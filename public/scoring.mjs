/** 前后端共用的评分规则；旧会话保留原始分数，不按新规则倒算。 */
export const RUBRIC = [
  { key: 'novelty', label: '新颖性', weight: 0.3, anchor: '相对已知工作的研究问题、解释或方法是否有新意' },
  { key: 'increment', label: '增量贡献', weight: 0.25, anchor: '能够新增什么知识、证据或适用范围' },
  { key: 'rigor', label: '方案严谨性', weight: 0.2, anchor: '已提供的设计能否检验主张并控制主要偏倚' },
  { key: 'translatability', label: '科学或应用价值', weight: 0.15, anchor: '对科学理解、后续研究或实际决策的潜在价值' },
  { key: 'feasibility', label: '可行性', weight: 0.1, anchor: '已说明的数据、资源和实施条件能否支持方案' },
];

export function validScore(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n * 10) / 10 : null;
}

export function weightedScore(scores, dimensions = RUBRIC) {
  if (!dimensions.every(d => validScore(scores?.[d.key]) !== null)) return null;
  const weight = dimensions.reduce((sum, d) => sum + d.weight, 0);
  return Math.round(dimensions.reduce((sum, d) => sum + validScore(scores[d.key]) * d.weight, 0) / weight * 10) / 10;
}

export const computeTotal = scores => weightedScore(scores);
export const computeInnovation = scores => weightedScore(scores, RUBRIC.slice(0, 2));

const strings = (value, limit = 6) => Array.isArray(value)
  ? value.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 800)).filter(Boolean).slice(0, limit) : [];

export function normalizeScorecard(parsed = {}) {
  const assessments = {};
  const scores = {};
  for (const dim of RUBRIC) {
    const detail = parsed?.assessments?.[dim.key] || {};
    const reason = typeof detail.reason === 'string' ? detail.reason.trim().slice(0, 1600) : '';
    const n = validScore(parsed?.[dim.key]);
    const scored = detail.status === 'scored' && !!reason && n !== null;
    scores[dim.key] = scored ? n : null;
    assessments[dim.key] = {
      status: scored ? 'scored' : 'insufficient',
      reason: reason || '缺少可核对的逐维评分理由，暂不评分。',
      confidence: ['low', 'medium'].includes(detail.confidence) ? detail.confidence : 'low',
      evidence: strings(detail.evidence),
      missingInformation: strings(detail.missingInformation),
    };
  }
  const total = computeTotal(scores);
  return {
    ...scores, version: 2, assessmentType: 'preliminary', assessments,
    total, innovationTotal: computeInnovation(scores),
    ...(total === null ? { incomplete: true } : {}),
    comments: typeof parsed?.comments === 'string' ? parsed.comments.trim() : '',
    suggestions: strings(parsed?.suggestions),
  };
}

export function scorecardNotice(card) {
  return card?.version === 2
    ? '针对已提供材料的研究潜力初评，非论文质量或录用预测。创新潜力仅含新颖性与增量；综合初评包含五维。待评估不等于低分，五维齐全才计算综合分；有限检索不能证明首创或重复。'
    : '旧版评分记录：保留当时模型结果，未按新规则重评，不能与新版分数直接比较。';
}

export function assessmentText(card, key) {
  const a = card?.assessments?.[key];
  if (!a) return '';
  return [a.reason, a.evidence?.length ? `依据：${a.evidence.join('；')}` : '',
    a.missingInformation?.length ? `待补充：${a.missingInformation.join('；')}` : '',
    `判断把握：${a.confidence === 'medium' ? '中' : '低'}`].filter(Boolean).join(' ');
}
