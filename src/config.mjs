/**
 * 配置加载：读取 .env，暴露统一 config 对象。
 * 零依赖实现——不引 dotenv。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（science-arena/） */
export const ROOT = path.resolve(__dirname, '..');

/** 极简 .env 解析：支持 KEY=VALUE、# 注释、引号包裹 */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnv(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// 优先级：真实环境变量 > .env
const fileEnv = process.env.ARENA_IGNORE_ENV_FILE === '1' ? {} : loadEnvFile(path.join(ROOT, '.env'));
const get = (key, fallback = '') => {
  const v = process.env[key];
  if (v !== undefined && v !== '') return v;
  const f = fileEnv[key];
  return f !== undefined && f !== '' ? f : fallback;
};

const baseConfig = {
  root: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir: path.resolve(get('ARENA_DATA_DIR', path.join(ROOT, 'data', 'sessions'))),
  promptsDir: path.join(ROOT, 'prompts'),

  port: Number(get('PORT', '3010')),
  host: get('HOST', '127.0.0.1'),
  mode: get('ARENA_MODE', 'local'),

  provider: get('LLM_PROVIDER', 'deepseek').toLowerCase(),

  llm: {
    // 单次模型请求的静默超时：只要还在持续返回数据就不算超时，
    // 连续这么久没有任何数据才中断。长输出的阶段（主持人汇总）不会被误杀。
    timeoutMs: Number(get('LLM_TIMEOUT_MS', '180000')),
  },

  deepseek: {
    apiKey: get('DEEPSEEK_API_KEY'),
    baseUrl: get('DEEPSEEK_BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: get('DEEPSEEK_MODEL', 'deepseek-flash'),
    modelPro: get('DEEPSEEK_MODEL_PRO', 'deepseek-v4-pro'),
    maxTokens: Number(get('DEEPSEEK_MAX_TOKENS', '6000')),
    effort: get('DEEPSEEK_EFFORT', 'low'),
  },

  dify: {
    baseUrl: get('DIFY_BASE_URL', '').replace(/\/+$/, ''),
    appKey: get('DIFY_APP_KEY'),
    // 本机 DNS 被代理工具劫持时，用真实 IP 覆盖解析（留空则走系统 DNS）
    pinIp: get('DIFY_PIN_IP', ''),
  },

  crossRounds: Number(get('CROSS_ROUNDS', '2')),

  // RAG 证据检索：pubmed（真实文献，默认）| none（回退模型知识）
  rag: {
    provider: get('RAG_PROVIDER', 'pubmed').toLowerCase(),
    topK: Number(get('RAG_TOP_K', '5')),
    timeoutMs: Number(get('RAG_TIMEOUT_MS', '20000')),
  },
};

// Context stays attached to the entire asynchronous debate, including streaming.
const modelContext = new AsyncLocalStorage();
export const config = new Proxy(baseConfig, {
  get(target, key) {
    return modelContext.getStore()?.[key] ?? target[key];
  },
});
export function withModelConfig(overrides, task) {
  return modelContext.run(overrides || {}, task);
}

/** 当前后端是否可用，用于启动时给出清晰提示 */
export function describeProvider() {
  if (config.provider === 'deepseek') {
    return config.deepseek.apiKey
      ? `deepseek 直连（${config.deepseek.model}）`
      : 'deepseek 直连 —— 未配置 DEEPSEEK_API_KEY';
  }
  if (config.provider === 'dify') {
    return config.dify.appKey
      ? `Dify 应用（${config.dify.baseUrl}）`
      : 'Dify 应用 —— 未配置 DIFY_APP_KEY';
  }
  if (config.provider === 'mock') return 'mock 离线干跑（不调用任何模型）';
  return `未知后端：${config.provider}`;
}
