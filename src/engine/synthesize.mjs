/**
 * S4 / S5 的结构化产出解析。
 *
 * 模型返回的 JSON 永远不能全信——所以要有一层"降级不崩"的解析：
 * 字段缺失就补默认值，类型不对就强制转换，绝不因为一个字段让整个会话失败。
 */
import { extractJson } from '../lib/util.mjs';
import { normalizeScorecard } from '../../public/scoring.mjs';
import { anchorChanges } from './provenance.mjs';
export { RUBRIC, computeTotal } from '../../public/scoring.mjs';

export function parseScorecard(content) {
  // repair: 输出被截断时抢救已生成的部分，而不是整份丢弃
  const parsed = extractJson(content, { repair: true }) || {};
  return normalizeScorecard(parsed);
}

const VALID_LEVELS = ['Critical', 'Major', 'Minor', 'Open Issue'];
const LEVEL_ALIASES = {
  致命: 'Critical',
  重要: 'Major',
  次要: 'Minor',
  未解决: 'Open Issue',
  开放问题: 'Open Issue',
};

const LEVEL_ORDER = { Critical: 0, Major: 1, 'Open Issue': 2, Minor: 3 };

function normalizeLevel(level) {
  const raw = String(level || '').trim();
  if (VALID_LEVELS.includes(raw)) return raw;
  if (LEVEL_ALIASES[raw]) return LEVEL_ALIASES[raw];
  const lower = raw.toLowerCase();
  if (lower.startsWith('crit')) return 'Critical';
  if (lower.startsWith('maj')) return 'Major';
  if (lower.startsWith('min')) return 'Minor';
  if (lower.includes('open')) return 'Open Issue';
  return 'Major';
}

const VALID_AGENTS = ['scientist', 'statistician', 'clinician', 'reviewer', 'innovator'];

export function parseModeratorOutput(content, context = {}) {
  // 先严格解析；失败再抢救（repair）。主持人那份 JSON 最大、最容易被输出上限截断，
  // 能救回一部分争议清单，也比四件产出里两件直接为空强得多。
  const strict = extractJson(content);
  const parsed = strict || extractJson(content, { repair: true }) || {};
  // 标记"这是抢救出来的"——调用方要如实告知用户，不能假装完整
  const salvaged = !strict && Object.keys(parsed).length > 0;

  const contentions = (Array.isArray(parsed.contentions) ? parsed.contentions : [])
    .map((c) => ({
      title: String(c?.title || '').trim(),
      level: normalizeLevel(c?.level),
      raisedBy: (Array.isArray(c?.raisedBy) ? c.raisedBy : [])
        .map((r) => String(r).trim().toLowerCase())
        .filter((r) => VALID_AGENTS.includes(r)),
      suggestion: String(c?.suggestion || '').trim(),
      status: ['proposal', 'disputed'].includes(c?.status) ? c.status : 'needs_verification',
    }))
    .filter((c) => c.title)
    // 致命 → 重要 → Open Issue → 次要
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    // 编号在排序之后分配，保证 C-01 永远是清单里最严重的那条
    .map((c, i) => ({ ...c, id: `C-${String(i + 1).padStart(2, '0')}` }));

  let changeLog = (Array.isArray(parsed.changeLog) ? parsed.changeLog : []).map((item, i) => ({
    id: `L-${String(i + 1).padStart(2, '0')}`,
    originElement: String(item?.originElement || '').trim(),
    originQuote: String(item?.originQuote || '').trim(),
    contention: String(item?.contention || '').trim(),
    revisedElement: String(item?.revisedElement || '').trim(),
    rationale: String(item?.rationale || '').trim(),
  }));
  if (typeof context.rawText === 'string') changeLog = anchorChanges(changeLog, context.rawText);

  return {
    summary: String(parsed.summary || '').trim(),
    contentions,
    changeLog,
    revisedProtocol: String(parsed.revisedProtocol || '').trim(),
    salvaged,
  };
}

/**
 * 一致性检查：致命级争议必须全部被修改对照表覆盖（PRD F6 验收标准）。
 *
 * 匹配算法的演进（每次都是在真实数据上翻的车，不是拍脑袋改的）：
 *
 *   1.0 中文关键词重叠：标题里的顿号会把片段切断 → 假阴性。
 *   1.1 字符二元组 Dice（整体拼接）：拼接四个字段撑大分母 → 系统性低估。
 *   1.2 Dice（逐字段取最大）：解决了稀释，但仍有漏洞——
 *       主持人被要求"去重合并"，一条修改对照会合法地同时回应多条争议，
 *       此时长字段对短标题的 Dice 依然偏低（实测 0.349，卡在阈值下）。
 *   2.0 **双信号**（当前版本）：
 *       信号 A：逐字段 Dice（衡量"两边整体像不像"）
 *       信号 B：子句包含度（把标题按中文标点切成子句，
 *               衡量"对照表里是否成段地出现了这条争议"）
 *       任一命中即判覆盖。
 *
 * 阈值来自实测校准（3 场真实辩论、20 条致命争议 + 5 个负例）：
 *   · 信号 A 阈值 0.42：真匹配 0.48–1.00，负例 ≤0.27
 *   · 信号 B 阈值 0.50：真匹配 0.556–1.00，负例 ≤0.27
 *   两个阈值都落在清晰的空隙里，不是为了凑通过率调出来的。
 *
 * 仍然是启发式校验——结论只用于提示"这条你可能没在方案里回应"，不做自动判定。
 */
function normalizeText(s) {
  return String(s ?? '')
    .replace(/[\s\u3000，。、；：！？（）()【】\[\]“”‘’"'\-—_:：/\\|]/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const t = normalizeText(s);
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice 系数 */
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return (2 * inter) / (a.size + b.size);
}

/** 包含度：a 有多大比例的字符二元组出现在 b 里 */
function containment(a, b) {
  if (!a.size) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / a.size;
}

/** 把长标题按中文标点切成子句，丢掉太短（不足以构成证据）的 */
function splitClauses(title) {
  return String(title || '')
    .split(/[：:；;，,。、（）()]/)
    .map((s) => s.trim())
    .filter((s) => normalizeText(s).length >= 6);
}

export function checkCriticalCoverage(
  contentions,
  changeLog,
  { diceThreshold = 0.42, clauseThreshold = 0.5 } = {},
) {
  const critical = contentions.filter((c) => c.level === 'Critical');

  // 把每条修改对照拆成独立字段——拼接会把分母撑大、系统性低估相似度
  const fields = [];
  for (const l of changeLog) {
    for (const f of [l.originElement, l.contention, l.revisedElement, l.rationale]) {
      if (!f) continue;
      fields.push({ text: String(f), grams: bigrams(f) });
    }
  }

  const details = critical.map((c) => {
    // 优先看是否直接引用了争议编号
    const byId = changeLog.some(
      (l) => l.contention && (String(l.contention).includes(c.id) || c.id.includes(String(l.contention).trim())),
    );

    // 信号 A：整条标题 vs 每个字段
    const whole = bigrams(c.title);
    let bestDice = 0;
    for (const f of fields) bestDice = Math.max(bestDice, dice(whole, f.grams));

    // 信号 B：标题的每个子句 vs 每个字段，取包含度最大值
    let bestClause = 0;
    for (const clause of splitClauses(c.title)) {
      const g = bigrams(clause);
      for (const f of fields) bestClause = Math.max(bestClause, containment(g, f.grams));
    }

    return {
      id: c.id,
      title: c.title,
      similarity: Number(bestDice.toFixed(3)),
      clauseCoverage: Number(bestClause.toFixed(3)),
      byId,
      covered: byId || bestDice >= diceThreshold || bestClause >= clauseThreshold,
    };
  });

  const uncovered = details.filter((d) => !d.covered).map((d) => d.id);
  return {
    total: critical.length,
    covered: critical.length - uncovered.length,
    uncovered,
    ratio: critical.length ? (critical.length - uncovered.length) / critical.length : 1,
    details,
    threshold: diceThreshold,
    clauseThreshold,
    method: 'per-field-dice + clause-containment',
  };
}

/** 推断占比统计：用于诚实披露有多少论断没有真实文献支撑 */
export function computeInferenceStats(messages, evidence) {
  const text = messages.map((m) => m.content).join('\n');
  const inferenceMarks = (text.match(/【推断】/g) || []).length;
  const knowledgeMarks = (text.match(/【模型知识】/g) || []).length;
  const citationMarks = (text.match(/\[E-\d{2}\]/g) || []).length;
  return {
    inferenceMarks,
    knowledgeMarks,
    citationMarks,
    evidenceCount: evidence?.length ?? 0,
    // 真实检索回来的条数（modelKnowledge === false）
    retrievedCount: (evidence ?? []).filter((e) => e.modelKnowledge === false).length,
    allEvidenceFromModelKnowledge: (evidence ?? []).every((e) => e.modelKnowledge !== false),
  };
}
