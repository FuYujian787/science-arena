/**
 * DeepSeek 直连后端（OpenAI 兼容协议）。
 *
 * 两个坑必须处理，否则会得到空回答：
 *  1. deepseek-flash 是推理模型，先输出 reasoning_content，再输出 content。
 *     max_tokens 必须给足（配置默认 4000），否则全被推理吃掉，content 为空。
 *  2. 想拿结构化结果时不能只靠 response_format，模型仍可能裹代码围栏，
 *     因此统一走 prompt 约束 + extractJson 容错解析。
 */
import { config } from '../config.mjs';

function buildBody({ system, user, maxTokens, stream }) {
  const body = {
    model: config.deepseek.model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens || config.deepseek.maxTokens,
    stream: !!stream,
  };
  if (config.deepseek.effort) body.effort = config.deepseek.effort;
  return body;
}

function endpoint() {
  return `${config.deepseek.baseUrl}/chat/completions`;
}

/**
 * 静默超时（inactivity timeout）。
 *
 * 这里踩过坑：最初用的是"整次请求总时长"超时，结果主持人阶段要输出完整的
 * 修正版方案 JSON，生成时间天然就超过 120 秒，中途一直被正常地流式返回，
 * 却在 120 秒被整体掐断，最关键的产出变成了空。
 *
 * 正确的语义是：只要还在持续吐数据就不算超时，静默超过 ms 才中断。
 */
function withInactivityTimeout(ms) {
  const controller = new AbortController();
  let timer = null;
  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), ms);
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  reset();
  return { signal: controller.signal, reset, clear };
}

function assertKey() {
  if (!config.deepseek.apiKey) {
    throw new Error(
      '未配置 DEEPSEEK_API_KEY。请在 science-arena/.env 里填写，或把 LLM_PROVIDER 改为 mock 做离线演示。',
    );
  }
}

async function readError(res) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  return `DeepSeek 请求失败：HTTP ${res.status} ${res.statusText}`;
}

/** 一次性问答：非流式，等整体返回，用整体超时即可 */
async function chat({ system, user, maxTokens }) {
  assertKey();
  const t = withInactivityTimeout(config.llm.timeoutMs);
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify(buildBody({ system, user, maxTokens, stream: false })),
    });
    if (!res.ok) throw new Error(await readError(res));

    const data = await res.json();
    const msg = data.choices?.[0]?.message ?? {};
    return {
      content: msg.content ?? '',
      reasoning: msg.reasoning_content ?? '',
      usage: data.usage ?? null,
      model: data.model ?? config.deepseek.model,
      finishReason: data.choices?.[0]?.finish_reason ?? null,
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`DeepSeek 请求超时（${config.llm.timeoutMs / 1000}s 未返回）`);
    }
    throw err;
  } finally {
    t.clear();
  }
}

/**
 * 流式问答：逐块吐出 { type: 'reasoning' | 'content' | 'done', text }。
 * 调用方拿到 content 分片即可实时渲染；reasoning 分片可选展示。
 * 最后一个 done 事件带 finishReason，调用方据此判断是否被 token 上限截断。
 */
async function* stream({ system, user, maxTokens }) {
  assertKey();
  const t = withInactivityTimeout(config.llm.timeoutMs);
  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      signal: t.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      body: JSON.stringify(buildBody({ system, user, maxTokens, stream: true })),
    });
    if (!res.ok) throw new Error(await readError(res));
    if (!res.body) throw new Error('DeepSeek 未返回流式响应体');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finishReason = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 收到数据就重置静默计时——持续吐字的长时间生成不会被误杀
      t.reset();
      buffer += decoder.decode(value, { stream: true });

      // 按 SSE 事件切分（\n 分隔）
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'done', finishReason };
          return;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta ?? {};
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
        if (delta.content) yield { type: 'content', text: delta.content };
      }
    }
    // 上游没发 [DONE] 就断流时也要把 finish_reason 交出去
    yield { type: 'done', finishReason };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`DeepSeek 流式请求超时（连续 ${config.llm.timeoutMs / 1000}s 无数据返回）`);
    }
    throw err;
  } finally {
    t.clear();
  }
}

export const deepseekProvider = {
  name: 'deepseek',
  label: 'DeepSeek 直连',
  chat,
  stream,
  model: () => config.deepseek.model,
};
