/**
 * Dify 应用后端。
 *
 * 对接方式：一个 **Workflow 应用**，输入 system_prompt 与 query，输出 text。
 * 六类角色共用同一个 Dify 工作流，只是每次传入的 system_prompt 不同——
 * 单 LLM 节点的 DSL 最稳、最不容易在导入时出错。
 *
 * 为什么不用 Chatflow：Chatflow 的 start 变量在网页端会变成"开始对话前要填的表单"，
 * 而 Workflow 的输入天然就是 API 参数，语义更对，也更好解释。
 *
 * 另有一个现实问题：本机 DNS 被代理工具劫持（fake-IP），
 * dify.zju.edu.cn 会解析到不可用地址，所以支持 DIFY_PIN_IP 钉死真实 IP，
 * 通过 https.request 的 lookup 覆盖解析结果。
 */
import http from 'node:http';
import https from 'node:https';
import { config } from '../config.mjs';

function assertReady() {
  if (!config.dify.baseUrl || !config.dify.appKey) {
    throw new Error(
      '未配置 Dify 应用。请在 science-arena/.env 里填写 DIFY_BASE_URL 与 DIFY_APP_KEY（app-xxxx），或把 LLM_PROVIDER 改为 deepseek / mock。',
    );
  }
}

/** 按 base URL 的协议选传输层：自建 Dify 走 http 的不少，不能写死 https */
function transportFor(path) {
  return new URL(config.dify.baseUrl + path).protocol === 'https:' ? https : http;
}

function requestOptions(path) {
  const url = new URL(config.dify.baseUrl + path);
  const isHttps = url.protocol === 'https:';
  const isLocal = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);

  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    protocol: url.protocol,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.dify.appKey}`,
    },
  };

  // 钉死 IP 只在 https + 非本机时才有意义：http 没有 SNI 问题，本机也不该被覆盖
  if (config.dify.pinIp && isHttps && !isLocal) {
    // Node 20+ 默认开启 autoSelectFamily（Happy Eyeballs），此时 lookup 会带
    // opts.all=true，回调必须返回数组；只返回字符串会报 "Invalid IP address: undefined"。
    // 这个坑只在真正发出请求时才会暴露，所以两条分支都要写。
    options.lookup = (hostname, opts, cb) => {
      if (opts && opts.all) cb(null, [{ address: config.dify.pinIp, family: 4 }]);
      else cb(null, config.dify.pinIp, 4);
    };
    options.servername = url.hostname; // SNI 必须保持真实域名
  }
  return options;
}

function request(path, body) {
  assertReady();
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = requestOptions(path);
    options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = transportFor(path).request(options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          reject(
            new Error(
              `Dify 请求失败：HTTP ${res.statusCode}`,
            ),
          ),
        );
        return;
      }
      resolve(res);
    });
    req.setTimeout(config.llm.timeoutMs, () => {
      req.destroy(new Error(`Dify 请求超时（${config.llm.timeoutMs / 1000}s 未返回）`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** 收集整个响应体 */
async function collect(res) {
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** 解析 Dify 的 SSE 事件流 */
async function* sseEvents(res) {
  let buffer = '';
  for await (const chunk of res) {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload);
      } catch {
        /* 忽略无法解析的行 */
      }
    }
  }
}

const INPUTS = (system, user) => ({ system_prompt: system || '', query: user });

/** GET 请求（自检用） */
function get(path) {
  assertReady();
  return new Promise((resolve, reject) => {
    const options = { ...requestOptions(path), method: 'GET' };
    const req = transportFor(path).request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.setTimeout(config.llm.timeoutMs, () => req.destroy(new Error('Dify 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 把 Dify 的报错翻译成"该去改什么"。
 *
 * 这个函数是踩过坑才有的：最初我把所有工作流执行失败都归因成"LLM 节点没选模型"，
 * 结果真实错误是「Dify 里配的模型供应商 API Key 失效」，两者修法完全不同，
 * 给错的提示比不给还浪费时间。所以先把错误分类，再给对应的动作。
 */
export function classifyDifyError(message) {
  const m = String(message || '');

  // 供应商侧鉴权失败：错误里通常带 "Your api key: ****xxxx"
  if (/api key[^"]{0,40}invalid|Authentication Fails|invalid_request_error|status code 401/i.test(m)) {
    const tail = /\*{2,}\s*([A-Za-z0-9]{2,8})/.exec(m)?.[1];
    return {
      kind: 'provider-key',
      hint:
        '这不是工作流的问题，是 Dify 里配置的「模型供应商」API Key 失效了' +
        (tail ? `（错误信息显示密钥尾号 ${tail}）` : '') +
        '。\n' +
        '两条路选一条：\n' +
        '  A. 到 Dify「设置 → 模型供应商」里，把对应供应商的 API Key 换成有效的；\n' +
        '  B. 或点开 LLM 节点，换成一个你工作区里已经能正常工作的模型，然后重新发布。',
    };
  }

  if (/model not found|model_not_found|no available model|model.*not.*exist/i.test(m)) {
    return {
      kind: 'model-missing',
      hint: 'LLM 节点选了一个工作区里不存在的模型。点开该节点重新选一个，然后发布更新。',
    };
  }

  if (/rate limit|too many requests|429/i.test(m)) {
    return { kind: 'rate-limit', hint: '供应商限流了。稍等一会儿再试，或换一个模型。' };
  }

  if (/timeout|timed out|ETIMEDOUT/i.test(m)) {
    return { kind: 'timeout', hint: '工作流执行超时。检查模型供应商的网络连通性与响应速度。' };
  }

  return {
    kind: 'unknown',
    hint: '展开上面的错误信息定位。常见原因是节点配置错误、或模型供应商未正确配置。',
  };
}

/**
 * 连接自检。
 *
 * 设计要点：**先不烧 token**。用 GET /v1/parameters 验证密钥并读取应用实际声明的输入变量，
 * 只有当输入变量对得上、用户确实要试跑时才真正调用一次工作流。
 * 这样"Key 填错了"和"工作流输入变量名不对"这两种最常见的失败能一眼区分开。
 */
export async function selftest({ dryRun = true } = {}) {
  const steps = [];
  const push = (name, ok, detail) => {
    steps.push({ name, ok, detail });
    return ok;
  };

  if (!config.dify.baseUrl) {
    push('读取配置', false, '未配置 DIFY_BASE_URL');
    return { ok: false, steps, hint: '在 .env 里填写 DIFY_BASE_URL' };
  }
  const usingPin = !!config.dify.pinIp && config.dify.baseUrl.startsWith('https') && !/127\.0\.0\.1|localhost/.test(config.dify.baseUrl);
  push('读取配置', true, `${config.dify.baseUrl}${usingPin ? `（钉死 IP ${config.dify.pinIp}）` : ''}`);

  if (!config.dify.appKey) {
    push('检查 API 密钥', false, '未配置 DIFY_APP_KEY');
    return {
      ok: false,
      steps,
      hint: '在 Dify 打开应用 →「访问 API」→ 创建密钥，把 app-xxxx 填进 .env 的 DIFY_APP_KEY，然后重启服务',
    };
  }
  if (!config.dify.appKey.startsWith('app-')) {
    push('检查 API 密钥', false, `密钥格式可疑：应以 "app-" 开头，当前是 "${config.dify.appKey.slice(0, 8)}…"`);
    return { ok: false, steps, hint: 'Dify 应用的 API 密钥以 app- 开头；如果这是控制台 token 或别的值，请重新复制' };
  }
  push('检查 API 密钥', true, '格式正常（app- 开头）');

  // 1) 用 /v1/parameters 验证密钥 + 读输入变量（不消耗 token）
  let params;
  try {
    const res = await get('/v1/parameters?user=science-arena-selftest');
    if (res.status === 401 || res.status === 403) {
      push('验证密钥', false, `HTTP ${res.status} —— 密钥无效或已被删除`);
      return { ok: false, steps, hint: '在 Dify 应用里重新创建一个 API 密钥' };
    }
    if (res.status === 404) {
      push('验证密钥', false, `HTTP 404 —— ${config.dify.baseUrl} 上没有找到该应用`);
      return { ok: false, steps, hint: '确认 DIFY_BASE_URL 指向的是 Dify 根地址，且 API 服务已开放' };
    }
    if (res.status !== 200) {
      push('验证密钥', false, `HTTP ${res.status}：${res.text.slice(0, 200)}`);
      return { ok: false, steps, hint: '把上面的响应内容发给开发者定位' };
    }
    params = JSON.parse(res.text);
    push('验证密钥', true, '密钥有效');
  } catch (err) {
    push('验证密钥', false, err.message);
    return {
      ok: false,
      steps,
      hint: /超时|timeout|ECONN|ENOTFOUND|EAI_AGAIN/i.test(err.message)
        ? '网络不通。如果本机有代理工具劫持了 DNS，请在 .env 里设置 DIFY_PIN_IP 为真实校内 IP'
        : '检查网络与 DIFY_BASE_URL',
    };
  }

  // 2) 检查输入变量是否符合引擎的约定
  const declared = (params.user_input_form || [])
    .map((item) => Object.values(item)[0]?.variable)
    .filter(Boolean);
  const need = ['system_prompt', 'query'];
  const missing = need.filter((v) => !declared.includes(v));
  push(
    '检查工作流输入变量',
    missing.length === 0,
    declared.length ? `应用声明了 ${declared.join(', ')}` : '应用没有声明任何输入变量',
  );
  if (missing.length) {
    return {
      ok: false,
      steps,
      hint: `缺少输入变量：${missing.join('、')}。导入 dify/science-arena-backend.yml，或手工在「开始」节点加这两个变量`,
    };
  }

  if (dryRun) {
    push('试运行工作流', true, '已跳过（只验证配置，不消耗 token）');
    return { ok: true, steps, hint: '配置正确。把 .env 的 LLM_PROVIDER 改成 dify 并重启服务即可。' };
  }

  // 3) 真正跑一次，确认模型配置没问题
  const t0 = Date.now();
  try {
    const out = await chat({ system: '你是测试助手。', user: '请只回复四个字：连接正常' });
    const text = (out.content || '').trim();
    push('试运行工作流', !!text, `${Date.now() - t0}ms 返回：${text.slice(0, 60) || '（空响应）'}`);
    if (!text) {
      return {
        ok: false,
        steps,
        hint: '工作流跑通了但输出为空。最常见的原因是 LLM 节点没有选模型，或「结束」节点没有把 text 作为输出变量',
      };
    }
    return { ok: true, steps, hint: '端到端连通，可以切到 dify 后端了。' };
  } catch (err) {
    const classified = classifyDifyError(err.message);
    push('试运行工作流', false, `${classified.kind}：${err.message}`);
    return { ok: false, steps, hint: classified.hint };
  }
}

/**
 * Dify 的 DeepSeek 插件把推理过程包成
 *   <think>\n<!--dify-deepseek-reasoning-->……推理……\n</think>正文
 * 直接透传会让每条发言前面糊一大段推理，还会让主持人输出的 JSON 更容易解析失败
 * （推理里也常有花括号）。
 *
 * 所以切开：推理单独作为 reasoning 回传，前端有「查看推理过程」折叠框可以展示；
 * content 只保留真正的回答。
 */
const THINK_TAG = '<think>';
const THINK_CLOSE = '</think>';
const REASONING_MARK = /<!--\s*dify-deepseek-reasoning\s*-->/g;

export function splitThink(text) {
  const raw = String(text ?? '');
  const open = raw.indexOf(THINK_TAG);
  if (open === -1) return { reasoning: '', content: raw };
  const close = raw.indexOf(THINK_CLOSE, open);
  if (close === -1) {
    // 只有开标签没有闭标签：整段当推理，正文为空
    return { reasoning: raw.slice(open + THINK_TAG.length).replace(REASONING_MARK, '').trim(), content: raw.slice(0, open) };
  }
  return {
    reasoning: raw.slice(open + THINK_TAG.length, close).replace(REASONING_MARK, '').trim(),
    content: (raw.slice(0, open) + raw.slice(close + THINK_CLOSE.length)).trim(),
  };
}

/** 一次性问答 */
async function chat({ system, user }) {
  const res = await request('/v1/workflows/run', {
    inputs: INPUTS(system, user),
    response_mode: 'blocking',
    user: 'science-arena',
  });
  const data = JSON.parse(await collect(res));

  if (data.data?.status === 'failed') {
    throw new Error(`Dify 工作流执行失败：${data.data.error || '未知错误'}`);
  }
  const outputs = data.data?.outputs ?? {};
  // 工作流输出字段名兼容几种常见写法
  const raw = String(outputs.text ?? outputs.answer ?? outputs.result ?? outputs.output ?? '');
  const { reasoning, content } = splitThink(raw);

  return {
    content,
    reasoning,
    usage: data.data?.total_tokens ? { total_tokens: data.data.total_tokens } : null,
    model: `dify:${data.workflow_run_id ? 'workflow' : 'app'}`,
    finishReason: 'stop',
    workflowRunId: data.workflow_run_id,
  };
}

/**
 * 流式问答：取 text_chunk 事件，并在流里实时剥离 <think> 段。
 *
 * 为什么要状态机而不是等流结束再切：正文必须边到边吐，否则实时辩论场就没有流式效果了；
 * 而 <think> 是正文之前的前缀，所以只要在头部先缓冲到能判断出有没有开标签，
 * 之后按 </think> 分流即可。
 */
async function* stream({ system, user }) {
  const res = await request('/v1/workflows/run', {
    inputs: INPUTS(system, user),
    response_mode: 'streaming',
    user: 'science-arena',
  });

  let buf = '';
  let mode = 'head'; // head（判断有没有 <think>）| think（在推理段）| body（正文）
  let reasoning = '';
  let sawAny = false;

  const flushBody = function* () {
    if (buf) {
      yield { type: 'content', text: buf };
      buf = '';
    }
  };

  for await (const evt of sseEvents(res)) {
    let text = null;

    if (evt.event === 'text_chunk') {
      text = evt.data?.text ?? null;
    } else if (evt.event === 'workflow_finished') {
      if (evt.data?.status === 'failed') {
        throw new Error(`Dify 工作流执行失败：${evt.data?.error || '未知错误'}`);
      }
      // 有些工作流不产生 text_chunk，只在结束时给出 outputs
      if (!sawAny) {
        const outputs = evt.data?.outputs ?? {};
        text = outputs.text ?? outputs.answer ?? outputs.result ?? outputs.output ?? null;
      }
    } else if (evt.event === 'error') {
      throw new Error(`Dify 返回错误：${evt.message || evt.code || '未知'}`);
    }

    if (!text) continue;
    sawAny = true;
    buf += text;

    // 阶段一：判断响应是否以 <think> 开头
    if (mode === 'head') {
      const t = buf.replace(/^\s+/, '');
      if (t.length < THINK_TAG.length && THINK_TAG.startsWith(t)) continue; // 还看不全，再等等
      if (t.startsWith(THINK_TAG)) {
        mode = 'think';
        buf = t.slice(THINK_TAG.length);
      } else {
        mode = 'body';
        buf = t;
      }
    }

    // 阶段二：在推理段里，直到出现 </think>
    if (mode === 'think') {
      const idx = buf.indexOf(THINK_CLOSE);
      if (idx === -1) {
        // 尾部可能正好是半个 </think>，先留着别当推理吐出去
        const keep = THINK_CLOSE.length;
        if (buf.length > keep) {
          reasoning += buf.slice(0, -keep);
          buf = buf.slice(-keep);
        }
        continue;
      }
      reasoning += buf.slice(0, idx);
      buf = buf.slice(idx + THINK_CLOSE.length);
      mode = 'body';
      const r = reasoning.replace(REASONING_MARK, '').trim();
      if (r) yield { type: 'reasoning', text: r };
    }

    if (mode === 'body') {
      yield* flushBody();
    }
  }

  // 收尾：可能整个响应都没有 </think>
  if (mode === 'think') {
    const r = (reasoning + buf).replace(REASONING_MARK, '').trim();
    if (r) yield { type: 'reasoning', text: r };
    buf = '';
  }
  if (buf) yield { type: 'content', text: buf };
}

export const difyProvider = {
  name: 'dify',
  label: 'Dify 应用',
  chat,
  stream,
  model: () => 'dify-workflow',
};
