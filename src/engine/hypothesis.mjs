/**
 * S0：假设解析与规范化。
 *
 * 把用户的一句话想法，变成一张结构化「假设卡」：
 * 研究对象 / 干预或暴露 / 中介变量 / 结局 / 目标人群 / 研究类型 + 歧义提示。
 * 五类角色后续都基于这张卡工作，所以这一步的抽取质量决定整场辩论的质量。
 */
import { extractJson } from '../lib/util.mjs';
import { userContext } from './provenance.mjs';

const SYSTEM = `你是科研方案结构化的专家。你的任务是把一段自然语言描述的研究假设，抽取成结构化要素。

要求：
1. 严格区分「中介变量」与「结局」——中介是暴露作用于结局的中间环节。
2. 原文没有明确的要素，不要编造，写"原文未明确"并把它列入 ambiguities。
3. ambiguities 要指出真正会导致研究设计分歧的歧义，而不是"表述可以更清楚"这类废话。
4. clarifyingQuestions 最多 2 条，只问那些答案会实质改变研究设计的問題。
5. 长输入可能包含已完成研究和本轮焦点。providedFacts只能逐字摘录用户提供的研究事实，不把输出要求或角色推断列为事实；focus逐字摘录本轮问题。未知写待核查，不推断作者未实施。

只输出一个 JSON 对象，不要任何解释，不要代码围栏：
{
  "subject": "研究对象（菌群/药物/行为等，尽可能具体到属种或类别）",
  "intervention": "干预或暴露因素",
  "mediator": "中介变量（若无则为空字符串）",
  "outcome": "结局指标",
  "population": "目标人群",
  "studyType": "研究类型（观察性/干预性/动物实验/待定）",
  "ambiguities": ["会导致设计分歧的歧义1", "歧义2"],
  "clarifyingQuestions": ["只问会实质改变设计的问题"],
  "providedFacts": ["从输入逐字摘录的已提供事实"],
  "focus": "从输入摘录的本轮焦点；无则空字符串"
}`;

export async function normalizeHypothesis({ provider, rawText, name }) {
  const user = `用户输入的研究假设：

"""${rawText}"""

请把它抽取成结构化假设卡。`;

  let res;
  let parsed;
  let attempts = 0;
  for (const maxTokens of [5000, 10000]) {
    attempts++;
    res = await provider.chat({ system: SYSTEM, user, maxTokens, meta: { task: 'hypothesis', agentId: 'moderator' } });
    const candidate = extractJson(res.content);
    if (candidate && !Array.isArray(candidate) && typeof candidate === 'object'
      && ['subject', 'intervention', 'outcome'].every(k => typeof candidate[k] === 'string' && candidate[k].trim())) {
      parsed = candidate;
      break;
    }
  }

  const fallback = {
    subject: '未解析',
    intervention: '未解析',
    mediator: '',
    outcome: '未解析',
    population: '未解析',
    studyType: '待定',
    ambiguities: ['假设解析失败，请检查模型输出'],
    clarifyingQuestions: [],
  };

  const card = parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback;
  for (const key of ['subject', 'intervention', 'mediator', 'outcome', 'population', 'studyType']) {
    if (typeof card[key] !== 'string') card[key] = String(card[key] ?? '');
  }
  if (!Array.isArray(card.ambiguities)) card.ambiguities = [];
  if (!Array.isArray(card.clarifyingQuestions)) card.clarifyingQuestions = [];

  return {
    ...card,
    ...userContext(rawText, parsed?.providedFacts, parsed?.focus),
    parseStatus: parsed ? 'ok' : 'fallback',
    parseAttempts: attempts,
    name: name || deriveName(userContext(rawText, [], parsed?.focus).focus || rawText),
    rawText,
    usage: res.usage,
    model: res.model,
  };
}

/** 给会话起个短名字，用于列表展示 */
function deriveName(rawText) {
  const clean = (rawText || '').replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
  return clean.length <= 24 ? clean : clean.slice(0, 23) + '…';
}

/** 给模型看的紧凑文本 */
export function cardToText(card) {
  return [
    `研究假设（原话）：${card.rawText}`,
    `研究对象：${card.subject}`,
    `干预/暴露：${card.intervention}`,
    `中介变量：${card.mediator || '（未指定）'}`,
    `结局指标：${card.outcome}`,
    `目标人群：${card.population}`,
    `研究类型：${card.studyType}`,
    card.focus ? `本轮焦点：${card.focus}\n围绕本轮焦点讨论；不要扩展为与焦点无关的全面重审。` : '',
    card.userFacts?.length ? `用户提供的材料（仅确认文字出处，未独立核实）：\n${card.userFacts.map(f => `[${f.id}] ${f.quote}`).join('\n')}` : '',
    '事实边界：未提供不等于未实施；角色建议不等于用户方案。已提供的处理不能重复认定为缺失。',
    card.ambiguities?.length ? `已知歧义：${card.ambiguities.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
