/**
 * LLM 后端抽象。
 *
 * 三个实现共享同一接口：
 *   chat({ system, user, maxTokens, json }) -> Promise<{ content, reasoning, usage, model }>
 *   stream({ system, user, maxTokens })     -> AsyncGenerator<{ type, text }>
 *
 * 之所以要 stream：辩论场前端要"边想边说"，首 token 延迟直接决定观感。
 */
import { config } from '../config.mjs';
import { deepseekProvider } from './deepseek.mjs';
import { difyProvider } from './dify.mjs';
import { mockProvider } from './mock.mjs';

const REGISTRY = {
  deepseek: deepseekProvider,
  dify: difyProvider,
  mock: mockProvider,
};

/** 按配置取后端；显式传入 name 可覆盖（便于测试与单次切换） */
export function getProvider(name) {
  const key = (name || config.provider).toLowerCase();
  const provider = REGISTRY[key];
  if (!provider) throw new Error(`未知的 LLM 后端：${key}（可选：${Object.keys(REGISTRY).join(' / ')}）`);
  return provider;
}

export const providerNames = Object.keys(REGISTRY);
