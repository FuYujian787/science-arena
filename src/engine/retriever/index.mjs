/**
 * 检索器注册表。
 *
 * 和 LLM 后端一样做成可插拔：以后要接 CNKI、指南库、或 Dify 的知识库，
 * 只要在这里加一个实现，引擎层不用动。
 *
 *   pubmed —— 真实文献（默认）
 *   none   —— 不检索，回退到模型知识（离线/断网时的行为）
 */
import { pubmedRetriever } from './pubmed.mjs';

const noneRetriever = {
  name: 'none',
  async retrieve() {
    return { ok: false, query: '', total: 0, items: [], error: '未启用检索' };
  },
};

const RETRIEVERS = {
  pubmed: pubmedRetriever,
  none: noneRetriever,
};

export const retrieverNames = Object.keys(RETRIEVERS);

export function getRetriever(name) {
  const key = String(name || 'none').toLowerCase();
  return RETRIEVERS[key] || RETRIEVERS.none;
}
