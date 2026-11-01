/**
 * 证据卡生成（PRD 中的 F3：RAG 证据检索）。
 *
 * 两条路径，行为不同但都不撒谎：
 *
 *   ① 真实检索（RAG_PROVIDER=pubmed，默认）
 *      先用模型把研究假设转写成英文检索式，再去 PubMed 取真实文献摘要。
 *      **证据卡的正文是原文摘录，不是模型复述**；出处是真实 PMID，可以点开核对。
 *      模型在这一步只做两件事：写检索式、判断"与假设的哪一环相关"。
 *      它不允许编造任何作者、期刊、年份、DOI——因为那些字段直接来自 PubMed 返回值。
 *
 *   ② 回退到模型知识（检索失败 / 断网 / RAG_PROVIDER=none）
 *      保持原来的行为：每张卡强制带「【模型知识】」前缀，会话统计里单独计数。
 *
 * 两种情况下用户都能一眼看出这条依据是哪来的——这是这个产品该有的诚实。
 */
import { extractJson } from '../lib/util.mjs';
import { getRetriever } from './retriever/index.mjs';

const QUERY_SYSTEM = `你是医学/生命科学文献检索专家。把给定的研究假设转写成一句**PubMed 检索式**。

规则：
1. 只输出英文关键词或 MeSH 主题词，用空格分隔，3–7 个词。
2. 不要写作者、期刊、年份、DOI，不要写检索语法限定符（如 [tiab]、AND/OR）。
3. 优先使用领域内通行的英文术语，不要直译中文。
4. 抓最能区分这个研究的 2–3 个核心概念，不要堆同义词。

同时给一个更宽的备选检索式：去掉过细的评分、方法或具体标志物限制，保留核心暴露与结局；用于首轮无匹配证据时重试。只输出JSON：
{"query": "bile acid depression gut microbiota", "fallbackQueries":["gut microbiota depression"]}`;

const RELEVANCE_SYSTEM = `你是科研方法学专家。下面给了研究假设和若干条真实文献摘要，请判断每条文献与该假设的关系。

严格要求：
1. 只依据给出的摘要内容判断，不要补充摘要里没有的信息。
2. 绝对不要编造或改写文献的作者、期刊、年份、DOI。
3. relevance 写这条文献与假设的哪一环相关（1–2 句，中文）。
4. confidence 取 high / medium / low：high 表示该摘要直接检验了假设中的关联；medium 表示间接支持；low 表示只是背景或存在冲突。
5. sourceType 取：文献摘要 / 方法学资料 / 临床指南。
6. relevanceLevel必须为direct（直接检验本问题）、indirect（相关人群/路径的间接证据）、background（仅背景）、irrelevant（不相关或结局/对象明显错配）。confidence不是事实正确率。不要仅因关键词重合就接受。

只输出 JSON，不要解释：
{"items":[{"i":0,"relevance":"…","relevanceLevel":"indirect","confidence":"medium","sourceType":"文献摘要"}]}`;

const MODEL_KNOWLEDGE_SYSTEM = `你是科研方法学与文献情报专家。请针对给定的研究假设，列出评审时最需要用到的**关键依据**。

极其重要的约束：
1. 你不知道具体的文献编号，因此**绝对不要编造**作者、期刊、年份、DOI 或具体数字。
2. 每条依据的 sourceRef 必须以「【模型知识】」开头，说明这是什么类型的知识。
3. sourceType 只能取：文献知识 / 方法学资料 / 临床指南。
4. summary仅提供通用方法核查提示与成立条件，不声称“多项文献证明”“该领域几乎空白”等无法查证的研究结论；不能补出用户未指明的蛋白或评分。
5. confidence 取 high / medium / low，low 表示这条依据本身在领域内存在争议。

只输出一个 JSON 对象，不要任何解释，不要代码围栏：
{
  "items": [
    {
      "sourceType": "方法学资料",
      "sourceRef": "【模型知识】研究类型",
      "summary": "这条依据说了什么（一到两句）",
      "relevance": "它与本研究假设的哪一点相关",
      "confidence": "high"
    }
  ],
  "coverage": "说明这是未核验的模型概述，不能用于断定公开证据充分程度"
}`;

/* ------------------------------------------------------------------ */

/** 摘录原文到指定长度，尽量在句末断开 */
function excerpt(text, max = 320) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut) + '…';
}

/** 让模型写检索式。失败返回空串，调用方会回退到模型知识。 */
async function buildSearchQueries(provider, cardText) {
  // 预算必须给足：deepseek-flash 是推理模型，会先花一大截 token 在 reasoning 上。
  // 只留 400 的话正文回来是空的——实测踩过，表现为"没能生成检索式"。
  const attempts = [
    { maxTokens: 3000, extra: '' },
    { maxTokens: 7000, extra: '\n\n【重要】只输出那个 JSON 对象，不要写任何推理或解释。' },
  ];

  for (const a of attempts) {
    try {
      const res = await provider.chat({
        system: QUERY_SYSTEM,
        user: `研究假设：\n${cardText}${a.extra}`,
        maxTokens: a.maxTokens,
        meta: { task: 'rag-query', agentId: 'librarian' },
      });
      const parsed = extractJson(res.content);
      const q = String(parsed?.query || '').trim();
      if (q) return [...new Set([q, ...(Array.isArray(parsed.fallbackQueries) ? parsed.fallbackQueries : [])]
        .filter(x => typeof x === 'string' && x.trim()).map(x => x.trim().slice(0, 350)))].slice(0, 2);
    } catch {
      /* 换下一个预算再试 */
    }
  }
  return [];
}

/** 让模型为每条真实文献写"与假设的关系"。失败时用中性描述，绝不编造。 */
async function annotateRelevance(provider, cardText, records) {
  const listing = records
    .map((r, i) => `[${i}] 标题：${r.title}\n摘要：${excerpt(r.abstract, 900)}`)
    .join('\n\n');

  try {
    const res = await provider.chat({
      system: RELEVANCE_SYSTEM,
      user: `研究假设：\n${cardText}\n\n文献列表：\n${listing}`,
      maxTokens: 3000,
      meta: { task: 'rag-annotate', agentId: 'librarian' },
    });
    const parsed = extractJson(res.content);
    const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    const byIndex = new Map();
    for (const it of arr) {
      const i = Number(it.i);
      if (Number.isInteger(i) && i >= 0 && i < records.length) {
        byIndex.set(i, {
          relevance: String(it.relevance || '').trim(),
          confidence: ['high', 'medium', 'low'].includes(it.confidence) ? it.confidence : 'medium',
          sourceType: String(it.sourceType || '文献摘要'),
          relevanceLevel: ['direct', 'indirect', 'background', 'irrelevant'].includes(it.relevanceLevel)
            ? it.relevanceLevel : it.confidence === 'high' ? 'direct' : it.confidence === 'medium' ? 'indirect' : 'background',
        });
      }
    }
    return byIndex;
  } catch {
    return new Map();
  }
}

/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {object} opts.provider  模型后端
 * @param {object} opts.card      结构化假设卡
 * @param {string} opts.cardText  假设卡的文本形式
 * @param {object} [opts.rag]     { provider, topK, timeoutMs }
 */
export async function retrieveEvidence({ provider, card, cardText, rag = {}, retriever }) {
  const retrieverName = String(rag.provider || 'none').toLowerCase();
  const topK = Number(rag.topK) || 5;

  if (retrieverName !== 'none') {
    const result = await tryRetrieval({ provider, cardText, retrieverName, topK, timeoutMs: rag.timeoutMs, retrieverOverride: retriever });
    if (result.items.length) return result;
    // 检索失败时把原因带回去，上层会据此提示"已回退到模型知识"
    return { ...(await modelKnowledgeEvidence(provider, cardText)), retrievalError: result.error, retrievalQuery: result.query,
      rag: { enabled: false, provider: 'none', requestedProvider: retrieverName, query: result.query,
        total: 0, retrieved: 0, searchStatus: 'no_usable_evidence', attempts: result.attempts, excludedRecords: result.excludedRecords } };
  }

  return modelKnowledgeEvidence(provider, cardText);
}

/** 真实检索路径 */
async function tryRetrieval({ provider, cardText, retrieverName, topK, timeoutMs, retrieverOverride }) {
  const queries = await buildSearchQueries(provider, cardText);
  const attempts = [];
  const excludedRecords = [];
  const retriever = retrieverOverride || getRetriever(retrieverName);
  for (const query of queries) {
    const res = await retriever.retrieve({ query, topK, timeoutMs: timeoutMs || 20000 });
    if (!res.ok || !res.items.length) {
      attempts.push({ query, total: res.total || 0, accepted: 0, error: res.error || '没有匹配条目' });
      continue;
    }
    const annotations = await annotateRelevance(provider, cardText, res.items);
    const accepted = res.items.map((r, i) => ({ record: r, annotation: annotations.get(i) }))
      .filter(({ record, annotation }) => {
        if (annotation && ['direct', 'indirect'].includes(annotation.relevanceLevel)) return true;
        excludedRecords.push({ pmid: record.pmid, title: record.title, url: record.url,
          query, relevanceLevel: annotation?.relevanceLevel || 'unassessed', reason: annotation?.relevance || '未完成相关性判断，暂不作为论证依据' });
        return false;
      });
    attempts.push({ query, total: res.total, retrieved: res.items.length, accepted: accepted.length });
    if (!accepted.length) continue;
  const items = accepted.map(({ record: r, annotation: a }, i) => {
    const ref = [`PMID ${r.pmid}`, r.journal, r.year].filter(Boolean).join(' · ');
    return {
      id: `E-${String(i + 1).padStart(2, '0')}`,
      sourceType: a.sourceType || '文献摘要',
      sourceRef: ref,
      summary: `原文摘录：${excerpt(r.abstract)}`,
      relevance: a.relevance || `该文献与假设的研究方向相关，详见摘要原文（${r.title}）`,
      confidence: a.confidence || 'medium',
      relevanceLevel: a.relevanceLevel,
      evidenceStatus: 'retrieved_not_independently_verified',
      // 关键：这几项直接来自 PubMed 返回值，不是模型生成的
      modelKnowledge: false,
      pmid: r.pmid,
      doi: r.doi || null,
      url: r.url,
      title: r.title,
      journal: r.journal || null,
      year: r.year || null,
    };
  });

  const coverage =
    `在 PubMed 检索「${query}」，命中 ${res.total} 条，经模型相关性筛选保留 ${items.length} 条；相关性判断仍需人工复核。` +
    (res.total < 10 ? '命中数量偏少，该方向可能证据有限或检索式需调整。' : '');

  return {
    items,
    coverage,
    rag: { enabled: true, provider: retrieverName, query, total: res.total, retrieved: items.length,
      searchStatus: 'usable_records', attempts, excludedRecords },
  };
  }
  return { items: [], query: queries.at(-1) || '', attempts, excludedRecords,
    error: queries.length ? '检索未取得经过相关性筛选的直接或间接证据；不代表不存在相关研究' : '没能生成检索式' };
}

/** 回退路径：模型知识，全部强制标注 */
async function modelKnowledgeEvidence(provider, cardText) {
  const user = `研究假设的结构化信息：

${cardText}

请列出 4–6 条评审这个假设时最需要用到的关键依据。`;

  const res = await provider.chat({
    system: MODEL_KNOWLEDGE_SYSTEM,
    user,
    maxTokens: 6000,
    meta: { task: 'evidence', agentId: 'librarian' },
  });
  const parsed = extractJson(res.content);
  const rawItems = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];

  const items = rawItems.slice(0, 8).map((item, i) => ({
    id: `E-${String(i + 1).padStart(2, '0')}`,
    sourceType: '未核验模型概述',
    sourceRef: ensureModelKnowledgeTag(String(item.sourceRef || '')),
    summary: String(item.summary || ''),
    relevance: String(item.relevance || ''),
    confidence: 'low',
    evidenceStatus: 'unverified_model_generated',
    modelKnowledge: true,
  }));

  return {
    items,
    coverage: '未取得匹配的文献依据；以下是未核验模型概述，仅用于提出核查问题，不能据此判断领域证据是否充分。',
    usage: res.usage,
    rag: { enabled: false, provider: 'none', total: 0, retrieved: 0 },
  };
}

/** 强制打上【模型知识】标签，防止模型漏标后被误当成真实文献 */
function ensureModelKnowledgeTag(ref) {
  return ref.startsWith('【模型知识】') ? ref : `【模型知识】${ref}`;
}

export function evidenceToText(evidence) {
  if (!evidence?.length) return '（本次未检索到可用依据）';
  return evidence
    .map((e) => {
      const src = e.modelKnowledge === false && e.url ? `${e.sourceRef}　${e.url}` : e.sourceRef;
      return `[${e.id}] (${e.sourceType}｜关联判断 ${e.relevanceLevel || '未核验'}；来源与内容仍需核查) ${e.summary}\n     与假设的关联：${e.relevance}\n     出处：${src}`;
    })
    .join('\n');
}
