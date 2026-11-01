/**
 * 评审报告导出：Markdown + 可直接打印成 PDF 的独立 HTML。
 *
 * 设计取舍：V1 不做 DOCX。理由不是偷懒——DOCX 要么引入依赖、
 * 要么手写 OOXML/ZIP 容器，两条路都会给"现场演示"增加失败点。
 * 浏览器打印成 PDF 已经覆盖真实使用场景，DOCX 放在 V1.1。
 */
import { RUBRIC, checkCriticalCoverage } from '../engine/synthesize.mjs';
import { STAGES } from '../engine/debate.mjs';
import { scorecardNotice, assessmentText } from '../../public/scoring.mjs';

/**
 * 导出前重算覆盖率。
 *
 * 会话里存的 coverage 是辩论当时算出来的；匹配算法后来改进过，
 * 直接展示存档值会让导出的报告与系统当前结论不一致（实测踩过：
 * 样例报告里写着 4/5，而按现行算法其实是 5/5）。
 * 导出件是对外交付物，必须以当前算法为准。
 */
function freshCoverage(session) {
  if (!session?.contentions?.length) return null;
  return checkCriticalCoverage(session.contentions, session.changeLog || []);
}

const LEVEL_CN = { Critical: '致命', Major: '重要', Minor: '次要', 'Open Issue': '未解决' };
const LEVEL_ORDER = { Critical: 0, Major: 1, 'Open Issue': 2, Minor: 3 };

const DISCLAIMER_BASE =
  '本内容为科研方案辅助建议，由多智能体辩论系统生成，不替代导师指导、伦理审查与临床决策。';

/** 导出件里的免责声明必须反映这一场到底有没有真实检索，不能写死 */
export function disclaimerFor(session) {
  const items = session?.evidence || [];
  const real = items.filter((e) => e.modelKnowledge === false).length;
  return (
    DISCLAIMER_BASE + ' 输入摘录只核对文字出处；模型建议待复核，未提供材料不等于原研究未实施。' +
    (real
      ? `其中 ${real}/${items.length} 条来自 PubMed 检索（附 PMID）；来源存在不等于内容正确，相关性仍需核查。`
      : '本次没有可用于论证的文献检索结果；模型概述已标为【模型知识】，未经独立核验。')
  );
}

/** 兼容旧调用点：没有会话上下文时给通用说明 */
export const DISCLAIMER = DISCLAIMER_BASE + '证据来源（真实检索 / 模型知识）在文中逐条标注。';

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function scoreTable(card, format) {
  if (!card) return format === 'md' ? '_未生成评分卡_\n' : '<p><em>未生成评分卡</em></p>';
  const rows = RUBRIC.map((d) => ({
    label: d.label,
    weight: `${d.weight * 100}%`,
    value: card[d.key] ?? '待评估',
    anchor: assessmentText(card, d.key) || d.anchor,
  }));
  if (format === 'md') {
    let md = `${scorecardNotice(card)}\n\n| 维度 | 权重 | 得分 | 评分依据与待补信息 |\n|---|---|---|---|\n`;
    for (const r of rows) md += `| ${r.label} | ${r.weight} | **${r.value}** | ${r.anchor.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')} |\n`;
    md += `| **${card.version === 2 ? '综合初评' : '旧版加权总分'}** | 100% | **${card.total ?? '待评估'}** | |\n`;
    if (card.version === 2) md += `\n创新潜力（新颖性与增量贡献）：${card.innovationTotal ?? '待评估'} / 5\n`;
    if (card.comments) md += `\n**总评**：${card.comments}\n`;
    if (card.suggestions?.length) {
      md += '\n**提升建议**：\n';
      card.suggestions.forEach((s, i) => (md += `${i + 1}. ${s}\n`));
    }
    return md;
  }
  let html = `<p>${esc(scorecardNotice(card))}</p><table><thead><tr><th>维度</th><th>权重</th><th>得分</th><th>评分依据与待补信息</th></tr></thead><tbody>`;
  for (const r of rows) html += `<tr><td>${esc(r.label)}</td><td>${r.weight}</td><td class="num">${r.value}</td><td>${esc(r.anchor)}</td></tr>`;
  html += `<tr class="total"><td>${card.version === 2 ? '综合初评' : '旧版加权总分'}</td><td>100%</td><td class="num">${card.total ?? '待评估'}</td><td></td></tr>`;
  html += '</tbody></table>';
  if (card.version === 2) html += `<p>创新潜力（新颖性与增量贡献）：${card.innovationTotal ?? '待评估'} / 5</p>`;
  if (card.comments) html += `<p class="muted">${esc(card.comments)}</p>`;
  if (card.suggestions?.length) html += `<ol>${card.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
  return html;
}

/** ------------------------------ Markdown ------------------------------ */
export function toMarkdown(session) {
  const h = session.hypothesis || {};
  const L = [];
  const push = (s = '') => L.push(s);

  push(`# Science Arena 评审报告`);
  push();
  push(`> ${disclaimerFor(session)}`);
  push();
  push(`**研究假设**：${session.rawText || ''}`);
  if (h.focus) push(`\n**本轮焦点**：${h.focus}`);
  if (h.userFacts?.length) {
    push('\n**用户已提供材料（原文摘录，未独立核验）**');
    h.userFacts.forEach(f => push(`- [${f.id}] ${f.quote}`));
  }
  push();
  push(`| 项 | 内容 |`);
  push(`|---|---|`);
  push(`| 会话 ID | \`${session.id}\` |`);
  push(`| 生成时间 | ${fmtDate(session.createdAt)} |`);
  push(`| 辩论轮次 | 交叉质疑 ${session.messages.filter((m) => m.stage === 'S2').length ? Math.max(...session.messages.filter((m) => m.stage === 'S2').map((m) => m.round)) : 0} 轮 |`);
  push(`| 参与角色 | ${[session.hypothesis ? '科学家 / 统计学家 / 临床专家 / 审稿人 / 创新性评估员 / 主持人' : ''].join('')} |`);
  push(`| 模型后端 | ${session.provider || ''} ${session.model || ''} |`);
  push(`| 总用时 | ${((session.totalElapsedMs || 0) / 1000).toFixed(1)} 秒 |`);
  push();

  push(`## 一、假设卡`);
  push();
  push(`| 要素 | 内容 |`);
  push(`|---|---|`);
  push(`| 研究对象 | ${h.subject || ''} |`);
  push(`| 干预 / 暴露 | ${h.intervention || ''} |`);
  push(`| 中介变量 | ${h.mediator || '（未指定）'} |`);
  push(`| 结局指标 | ${h.outcome || ''} |`);
  push(`| 目标人群 | ${h.population || ''} |`);
  push(`| 研究类型 | ${h.studyType || ''} |`);
  push();
  if (h.ambiguities?.length) {
    push(`**歧义提示**：`);
    h.ambiguities.forEach((a) => push(`- ${a}`));
    push();
  }

  if (session.summary) {
    push(`## 二、主持人总结`);
    push();
    push(session.summary);
    push();
  }

  push(`## 三、争议清单`);
  push();
  if (!session.contentions?.length) {
    push('_未生成争议清单_');
  } else {
    push(`| 编号 | 争议点 | 等级 | 提出者 | 建议修改 |`);
    push(`|---|---|---|---|---|`);
    const order = [...session.contentions].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    for (const c of order) {
      push(
        `| ${c.id} | ${c.title} | ${LEVEL_CN[c.level] || c.level} | ${(c.raisedBy || []).join('、') || '—'} | ${c.suggestion || '—'} |`,
      );
    }
  }
  push();

  push(`## 四、创新性评分卡`);
  push();
  push(scoreTable(session.scorecard, 'md'));
  push();

  push(`## 五、修改对照表`);
  push();
  if (!session.changeLog?.length) {
    push('_未生成修改对照表_');
  } else {
    push(`| 原方案要素 | 对应争议 | 修改后设计 | 修改理由 |`);
    push(`|---|---|---|---|`);
    for (const l of session.changeLog) {
      push(`| ${l.originElement} | ${l.contention} | ${l.revisedElement} | ${l.rationale} |`);
    }
  }
  const coverage = freshCoverage(session);
  if (coverage) {
    push();
    push(
      `**关键建议文本回应**：${coverage.covered}/${coverage.total}` +
        (coverage.uncovered?.length ? `（未覆盖：${coverage.uncovered.join(', ')}）` : '（已有文本对应，不代表问题已解决）'),
    );
  }
  push();

  push(`## 六、修正版研究方案`);
  push();
  push(session.revisedProtocol || '_未生成_');
  push();

  push(`## 七、证据卡`);
  push();
  if (!session.evidence?.length) {
    push('_未检索到证据_');
  } else {
    push(`> ${session.evidenceCoverage || ''}`);
    push();
    push(`| 编号 | 类型 | 置信度 | 要点 | 与假设的关联 | 出处 |`);
    push(`|---|---|---|---|---|---|`);
    for (const e of session.evidence) {
      const src = e.modelKnowledge === false && e.url ? `[${e.sourceRef}](${e.url})` : e.sourceRef;
      push(`| ${e.id} | ${e.sourceType} | ${e.confidence} | ${e.summary} | ${e.relevance} | ${src} |`);
    }
  }
  push();

  push(`## 八、诚实披露`);
  push();
  const st = session.inferenceStats || {};
  const retrieved = st.retrievedCount ?? 0;
  push(
    `- 证据卡数量：${st.evidenceCount ?? 0}` +
      (retrieved > 0
        ? `（其中 **${retrieved} 条来自 PubMed 真实检索，附 PMID 可核对**）`
        : '（**全部来自模型知识，非真实文献检索**）'),
  );
  push(`- 正文中的引用标注次数：${st.citationMarks ?? 0}`);
  push(`- 【模型知识】标注次数：${st.knowledgeMarks ?? 0}`);
  push(`- 【推断】标注次数：${st.inferenceMarks ?? 0}`);
  push();

  push(`## 九、完整辩论记录`);
  push();
  for (const st2 of STAGES) {
    const msgs = session.messages.filter((m) => m.stage === st2.id);
    if (!msgs.length) continue;
    push(`### ${st2.id} ${st2.name}（${(msgs.reduce((a, m) => a + (m.elapsedMs || 0), 0) / 1000).toFixed(1)}s）`);
    push();
    for (const m of msgs) {
      push(`#### ${m.agentName}${m.round ? `（第 ${m.round} 轮）` : ''}${m.absent ? ' ⚠️ 缺席' : ''}`);
      push();
      push(m.content);
      push();
    }
  }

  return L.join('\n');
}

/** ------------------------------ HTML ------------------------------ */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把纯文本段落转成 HTML（保留换行与【】小标题的强调） */
function textToHtml(text) {
  if (!text) return '';
  return String(text)
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((l) => esc(l)).join('<br>');
      return `<p>${lines.replace(/【([^】]+)】/g, '<strong class="tag">【$1】</strong>')}</p>`;
    })
    .join('');
}

export function toHtml(session) {
  const h = session.hypothesis || {};
  const levelClass = { Critical: 'lv-critical', Major: 'lv-major', Minor: 'lv-minor', 'Open Issue': 'lv-open' };
  const order = [...(session.contentions || [])].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);

  const contentionsHtml = order.length
    ? `<table><thead><tr><th>编号</th><th>争议点</th><th>等级</th><th>提出者</th><th>建议修改</th></tr></thead><tbody>${order
        .map(
          (c) =>
            `<tr><td class="mono">${esc(c.id)}</td><td>${esc(c.title)}</td><td><span class="badge ${levelClass[c.level] || ''}">${LEVEL_CN[c.level] || c.level}</span></td><td>${esc((c.raisedBy || []).join('、') || '—')}</td><td>${esc(c.suggestion || '—')}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">未生成争议清单</p>';

  const changeHtml = session.changeLog?.length
    ? `<table><thead><tr><th>原方案要素</th><th>对应争议</th><th>修改后设计</th><th>修改理由</th></tr></thead><tbody>${session.changeLog
        .map(
          (l) =>
            `<tr><td>${esc(l.originElement)}</td><td class="mono">${esc(l.contention)}</td><td>${esc(l.revisedElement)}</td><td>${esc(l.rationale)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">未生成修改对照表</p>';

  const evidenceHtml = session.evidence?.length
    ? `<p class="muted">${esc(session.evidenceCoverage || '')}</p><table><thead><tr><th>编号</th><th>类型</th><th>置信度</th><th>要点</th><th>与假设的关联</th><th>出处</th></tr></thead><tbody>${session.evidence
        .map((e) => {
          // 真实检索的证据给出可点的 PubMed 链接，打印成 PDF 也保留 URL
          const src =
            e.modelKnowledge === false && e.url
              ? `<a href="${esc(e.url)}">${esc(e.sourceRef)}</a>`
              : esc(e.sourceRef);
          return `<tr><td class="mono">${esc(e.id)}</td><td>${esc(e.sourceType)}</td><td>${esc(e.confidence)}</td><td>${esc(e.summary)}</td><td>${esc(e.relevance)}</td><td class="muted">${src}</td></tr>`;
        })
        .join('')}</tbody></table>`
    : '<p class="muted">未检索到证据</p>';

  const transcriptHtml = STAGES.map((st) => {
    const msgs = session.messages.filter((m) => m.stage === st.id);
    if (!msgs.length) return '';
    return `<h3>${st.id} ${esc(st.name)}</h3>${msgs
      .map(
        (m) =>
          `<div class="msg" style="border-left-color:${m.color || '#94a3b8'}"><div class="msg-head"><span class="who">${esc(m.agentName)}</span>${m.round ? `<span class="round">第 ${m.round} 轮</span>` : ''}${m.absent ? '<span class="absent">缺席</span>' : ''}<span class="time">${((m.elapsedMs || 0) / 1000).toFixed(1)}s</span></div><div class="msg-body">${textToHtml(m.content)}</div></div>`,
      )
      .join('')}`;
  }).join('');

  const st = session.inferenceStats || {};
  const coverage = freshCoverage(session);
  const roundsUsed = session.messages.filter((m) => m.stage === 'S2').length
    ? Math.max(...session.messages.filter((m) => m.stage === 'S2').map((m) => m.round))
    : 0;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Science Arena 评审报告 · ${esc(h.name || session.id)}</title>
<style>
  :root { --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; --accent:#1f3864; --bg:#ffffff; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f3f4f6; color:var(--ink);
         font-family:-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;
         font-size:14px; line-height:1.75; }
  .page { max-width:940px; margin:0 auto; background:var(--bg); padding:56px 64px 80px; }
  h1 { font-size:26px; color:var(--accent); margin:0 0 6px; letter-spacing:.5px; }
  h2 { font-size:18px; color:var(--accent); margin:44px 0 14px; padding-bottom:8px; border-bottom:2px solid #dbe4f5; }
  h3 { font-size:15px; color:#374151; margin:26px 0 10px; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:26px; }
  .disclaimer { background:#fef3c7; border-left:4px solid #f59e0b; padding:12px 16px;
                font-size:12.5px; color:#78350f; border-radius:0 6px 6px 0; margin-bottom:26px; }
  table { width:100%; border-collapse:collapse; margin:12px 0; font-size:12.5px; }
  th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#eef3fb; color:var(--accent); font-weight:600; }
  tr.total td { background:#f8fafc; font-weight:700; }
  td.num { text-align:center; font-weight:600; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:11.5px; color:var(--muted); }
  .muted { color:var(--muted); font-size:12.5px; }
  .badge { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11.5px; white-space:nowrap; }
  .lv-critical { background:#fee2e2; color:#991b1b; }
  .lv-major { background:#ffedd5; color:#9a3412; }
  .lv-minor { background:#e5e7eb; color:#374151; }
  .lv-open { background:#fef9c3; color:#854d0e; }
  .meta { display:grid; grid-template-columns:110px 1fr; gap:2px 14px; font-size:12.5px; margin:10px 0 4px; }
  .meta dt { color:var(--muted); }
  .meta dd { margin:0; }
  .msg { border-left:3px solid #cbd5e1; padding:6px 0 6px 14px; margin:14px 0; }
  .msg-head { font-size:12px; color:var(--muted); margin-bottom:4px; }
  .msg-head .who { font-weight:700; color:#111827; margin-right:8px; }
  .msg-head .round,.msg-head .absent { margin-right:8px; }
  .absent { color:#b91c1c; }
  .msg-body p { margin:0 0 6px; white-space:pre-wrap; }
  .tag { color:#1d4ed8; }
  .protocol { background:#f9fafb; border:1px solid var(--line); border-radius:8px;
              padding:18px 22px; white-space:pre-wrap; font-size:13px; }
  @media print {
    body { background:#fff; }
    .page { max-width:none; padding:0 12mm; box-shadow:none; }
    h2 { page-break-after:avoid; }
    table,.msg,.protocol { page-break-inside:avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <h1>Science Arena 评审报告</h1>
  <div class="sub">多智能体科研假说辩论与方案修正平台</div>
  <div class="disclaimer">${esc(disclaimerFor(session))}</div>

  <h2>研究假设</h2>
  <p>${esc(session.rawText || '')}</p>
  <dl class="meta">
    <dt>会话 ID</dt><dd class="mono">${esc(session.id)}</dd>
    <dt>生成时间</dt><dd>${fmtDate(session.createdAt)}</dd>
    <dt>交叉质疑</dt><dd>${roundsUsed} 轮</dd>
    <dt>模型后端</dt><dd>${esc(session.provider || '')} ${esc(session.model || '')}</dd>
    <dt>总用时</dt><dd>${((session.totalElapsedMs || 0) / 1000).toFixed(1)} 秒</dd>
  </dl>

  <h2>一、假设卡</h2>
  <table>
    <tr><th style="width:110px">研究对象</th><td>${esc(h.subject)}</td></tr>
    <tr><th>干预 / 暴露</th><td>${esc(h.intervention)}</td></tr>
    <tr><th>中介变量</th><td>${esc(h.mediator || '（未指定）')}</td></tr>
    <tr><th>结局指标</th><td>${esc(h.outcome)}</td></tr>
    <tr><th>目标人群</th><td>${esc(h.population)}</td></tr>
    <tr><th>研究类型</th><td>${esc(h.studyType)}</td></tr>
  </table>
  ${h.ambiguities?.length ? `<p class="muted">歧义提示：${esc(h.ambiguities.join('；'))}</p>` : ''}

  <h2>二、主持人总结</h2>
  ${textToHtml(session.summary) || '<p class="muted">—</p>'}

  <h2>三、争议清单</h2>
  ${contentionsHtml}

  <h2>四、创新性评分卡</h2>
  ${scoreTable(session.scorecard, 'html')}

  <h2>五、修改对照表</h2>
  ${changeHtml}
  ${
    coverage
      ? `<p class="muted">关键建议文本回应：<strong>${coverage.covered}/${coverage.total}</strong>${
          coverage.uncovered?.length ? `（未覆盖：${esc(coverage.uncovered.join(', '))}）` : '（已有文本对应，不代表问题已解决）'
        }</p>`
      : ''
  }

  <h2>六、修正版研究方案</h2>
  <div class="protocol">${esc(session.revisedProtocol || '未生成')}</div>

  <h2>七、证据卡</h2>
  ${evidenceHtml}

  <h2>八、诚实披露</h2>
  <ul>
    <li>证据卡数量：${st.evidenceCount ?? 0}${
      (st.retrievedCount ?? 0) > 0
        ? `（<strong>其中 ${st.retrievedCount} 条来自 PubMed 真实检索，附 PMID</strong>）`
        : '（<strong>全部来自模型知识，非真实文献检索</strong>）'
    }</li>
    <li>正文中引用标注次数：${st.citationMarks ?? 0}</li>
    <li>【模型知识】标注次数：${st.knowledgeMarks ?? 0}</li>
    <li>【推断】标注次数：${st.inferenceMarks ?? 0}</li>
  </ul>

  <h2>九、完整辩论记录</h2>
  ${transcriptHtml}
</div>
</body>
</html>`;
}

/** 导出文件名（避免中文与特殊字符导致下载问题） */
export function reportFilename(session, ext) {
  const safe = (session.hypothesis?.name || session.id).replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 30);
  return `ScienceArena_${safe || 'report'}.${ext}`;
}
