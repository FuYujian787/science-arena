/**
 * PubMed 文献检索（NCBI E-utilities）。
 *
 * 为什么选它：
 *   · 公开接口、无需密钥，不会因为谁的账号过期而挂掉
 *   · 返回真实 PMID —— 每条证据都能点开原文核对，这才叫"可溯源"
 *   · 纯文本模式（rettype=abstract&retmode=text）不需要写 XML 解析器，零依赖
 *
 * 走的是 Node 内置 fetch，和项目其他地方一致；不引入任何 npm 包。
 *
 * NCBI 使用礼仪：未注册的请求限 3 次/秒。我们一场辩论只发 2 次（1 次检索 + 1 次取摘要），
 * 远低于限额。带 tool 参数标明来源。
 */

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

function withCommon(url) {
  const u = new URL(url);
  u.searchParams.set('tool', 'science-arena');
  return u.toString();
}

/**
 * 第一步：按关键词检索，拿 PMID 列表。
 * @returns {Promise<{ids: string[], total: number}>}
 */
async function esearch(term, { retmax, timeoutMs, signal }) {
  const url = withCommon(
    `${BASE}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${retmax}&term=${encodeURIComponent(term)}`,
  );
  const res = await fetch(url, { signal: signal || AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`PubMed 检索失败：HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.esearchresult ?? {};
  // errorlist 里有值通常意味着检索式写坏了（比如全部被当作非法字符）
  if (result.errorlist?.phrases?.length || result.errorlist?.fields?.length) {
    throw new Error(`PubMed 检索式无效：${result.errorlist.phrases?.[0] || result.errorlist.fields?.[0]}`);
  }
  const ids = Array.isArray(result.idlist) ? result.idlist.filter(Boolean) : [];
  return { ids, total: Number(result.count || 0) };
}

/**
 * 把 rettype=abstract&retmode=text 的纯文本拆成记录。
 *
 * 真实返回长这样：
 *   1. Int Immunopharmacol. 2026 Sep 28;190:117487. doi: 10.1016/j.intimp.2026.117487.
 *
 *   Anxiolytic and antidepressant effects of ... in a mouse model.
 *
 *   作者，作者…
 *   ... 摘要正文 ...
 *   PMID: 42805062
 */
export function parseRecords(text, ids) {
  // 记录之间隔着空行。只在"空行 + 编号"处切，避免把摘要正文里以 "1. " 开头的行误当成新记录。
  const chunks = String(text || '')
    .split(/\r?\n\s*\r?\n(?=\s*\d+\.\s)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const records = [];
  for (const chunk of chunks) {
    // 期刊引用可能跨行（例如 "mSystems." 换行接 "2024 Feb 8:e0129923."），
    // 所以引用块要取到第一个空行为止，而不是只看第一行。
    const firstBlank = chunk.search(/\r?\n\s*\r?\n/);
    const citationBlock = firstBlank === -1 ? chunk : chunk.slice(0, firstBlank);
    const restRaw = firstBlank === -1 ? '' : chunk.slice(firstBlank).trim();
    const rest = restRaw.replace(/PMID:\s*\d+\s*$/m, '').trim();

    const citation = citationBlock
      .replace(/^\s*\d+\.\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 标题 = 引用块之后第一个非空行
    const title = (rest.split(/\r?\n/).find((l) => l.trim()) || '').trim();

    const pmid = /PMID:\s*(\d+)/.exec(chunk)?.[1] || null;
    // DOI 结尾可能紧跟句号，要剥掉
    const doi = (/doi:\s*(\S+)/i.exec(citation)?.[1] || '').replace(/[.,;]+$/, '') || null;
    const year = /\b(19|20)\d{2}\b/.exec(citation)?.[0] || null;
    // 期刊名：引用行里第一个 ". " 之前的部分
    const journal = citation.split(/\.\s/)[0]?.trim() || null;

    // 摘要正文：去掉标题行（以及作者行），取最长的那一段
    const body = rest.split(/\r?\n/).slice(1).join('\n').trim();
    const paragraphs = body.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);
    const abstract = paragraphs.sort((a, b) => b.length - a.length)[0] || '';

    records.push({
      pmid: pmid || ids[records.length] || null,
      title,
      journal,
      year,
      doi,
      abstract,
      citation,
    });
  }
  return records;
}

/**
 * 检索并取回摘要。
 *
 * @param {object} opts
 * @param {string} opts.query   英文检索式
 * @param {number} opts.topK    最多取几条
 * @param {number} opts.timeoutMs
 * @returns {Promise<{ok:boolean, query:string, total:number, items:object[], error?:string}>}
 */
export async function retrieve({ query, topK = 5, timeoutMs = 20000, signal }) {
  const term = String(query || '').trim();
  if (!term) return { ok: false, query: '', total: 0, items: [], error: '检索式为空' };

  try {
    const { ids, total } = await esearch(term, { retmax: topK, timeoutMs, signal });
    if (!ids.length) {
      return { ok: false, query: term, total: 0, items: [], error: '没有检索到相关文献' };
    }

    const url = withCommon(
      `${BASE}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${ids.join(',')}`,
    );
    const res = await fetch(url, { signal: signal || AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`PubMed 取摘要失败：HTTP ${res.status}`);
    const text = await res.text();

    const records = parseRecords(text, ids);
    const items = records
      .filter((r) => r.pmid)
      .slice(0, topK)
      .map((r) => ({ ...r, url: `https://pubmed.ncbi.nlm.nih.gov/${r.pmid}/` }));

    if (!items.length) {
      return { ok: false, query: term, total, items: [], error: '取回了 PMID 但没能解析出摘要' };
    }
    return { ok: true, query: term, total, items };
  } catch (err) {
    const msg = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? '检索超时' : err?.message || String(err);
    return { ok: false, query: term, total: 0, items: [], error: msg };
  }
}

export const pubmedRetriever = { name: 'pubmed', retrieve };
