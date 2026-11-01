#!/usr/bin/env node
/**
 * Science Arena 服务端。
 *
 * 零依赖：只用 node:http / node:fs / 内置 fetch。
 * 启动：node server.mjs  然后打开 http://localhost:<PORT>
 *
 * 为什么不用框架：这个项目要在比赛现场跑。少一个依赖就少一个现场翻车的理由。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, describeProvider, withModelConfig } from './src/config.mjs';
import { guardRequest, publicMode, consumeQuota, modelOverrides } from './src/hosting.mjs';
import { getProvider, providerNames } from './src/llm/provider.mjs';
import { selftest as difySelftest } from './src/llm/dify.mjs';
import { runDebate, STAGES } from './src/engine/debate.mjs';
import { getAgentProfiles } from './src/engine/agents.mjs';
import { RUBRIC, checkCriticalCoverage } from './src/engine/synthesize.mjs';
import * as store from './src/store/session.mjs';
import { toMarkdown, toHtml, reportFilename, DISCLAIMER } from './src/export/report.mjs';
import { toDocx } from './src/export/docx.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 运行时会话注册表。
 * 关键点：事件要缓冲。POST 启动辩论和浏览器建立 SSE 连接之间有时间差，
 * 不缓冲就会丢掉开头的几个事件（恰恰是最重要的假设解析结果）。
 */
const runtime = new Map();

function createRuntime(id) {
  const entry = {
    id,
    events: [],
    listeners: new Set(),
    session: null,
    done: false,
    cancelled: false,
    lastPersistAt: 0,
  };
  runtime.set(id, entry);
  return entry;
}

function broadcast(entry, event) {
  entry.events.push(event);
  for (const res of entry.listeners) {
    writeSse(res, event);
  }
}

function writeSse(res, event) {
  try {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* 连接已断，忽略 */
  }
}

/** ------------------------------ 工具 ------------------------------ */

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 200) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(config.publicDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

/** ------------------------------ 演示案例库 ------------------------------ */

const CASES = [
  {
    id: 'microbiome-bileacid-ibd',
    title: '菌群—胆汁酸—IBD 抑郁共病',
    tag: '跨学科 · 干预性',
    hypothesis: '某种菌群能否通过胆汁酸改善IBD抑郁共病？',
    note: '首发演示案例。天然跨微生物学、代谢、临床、统计与伦理五个视角，最能体现多角色分歧。',
  },
  {
    id: 'sleep-metabolism',
    title: '睡眠剥夺与代谢紊乱',
    tag: '观察性 · 中介分析',
    hypothesis: '长期睡眠剥夺是否通过肠道通透性改变导致代谢紊乱？',
    note: '适合演示观察性研究的中介分析时序问题。',
  },
  {
    id: 'ai-triage',
    title: 'AI 分诊系统临床效果',
    tag: '干预性 · 卫生管理',
    hypothesis: '基于大模型的门诊预分诊系统能否缩短患者平均候诊时间并降低误分诊率？',
    note: '适合演示临床终点选择、实施科学与卫生经济学评估的争议。',
  },
  {
    id: 'mindfulness-stress',
    title: '正念干预与研究生科研焦虑',
    tag: '行为干预 · 教育',
    hypothesis: '八周正念训练能否降低研究生的科研焦虑水平并提升论文产出？',
    note: '适合演示主观量表终点、安慰剂效应与因果归因问题。',
  },
];

/** ------------------------------ 路由 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  try {
    const access = guardRequest(req, res, url);
    if (access.handled) return;
    if (access.error) return json(res, { error: access.error }, access.status);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const owner = access.owner;
    const protectedId = /^\/api\/(?:sessions|debate)\/([\w-]+)(?:\/|$)/.exec(pathname)?.[1];
    if (publicMode && protectedId) {
      const sessionOwner = runtime.get(protectedId)?.owner || store.load(protectedId)?._owner;
      if (sessionOwner !== owner) return json(res, { error: '会话不存在' }, 404);
    }
    // ---------- 健康检查与元数据 ----------
    if (pathname === '/api/health') {
      return json(res, {
        ok: true,
        provider: config.provider,
        providerLabel: publicMode || config.mode === 'desktop' ? '请配置本人的模型 API' : describeProvider(),
        mode: config.mode,
        personalKeys: publicMode || config.mode === 'desktop',
        difyAllowedUrl: publicMode ? process.env.ARENA_DIFY_ALLOWED_URL || '' : '',
        providers: providerNames,
        stages: STAGES,
        rubric: RUBRIC,
        disclaimer: DISCLAIMER,
        crossRounds: config.crossRounds,
        deepseekReady: !publicMode && config.mode !== 'desktop' && !!config.deepseek.apiKey,
        difyReady: !publicMode && config.mode !== 'desktop' && !!(config.dify.baseUrl && config.dify.appKey),
        // RAG 状态：前端「后端状态」弹层里显示，让人一眼知道证据从哪来
        rag: { provider: config.rag.provider, topK: config.rag.topK, enabled: config.rag.provider !== 'none' },
      });
    }

    if (pathname === '/api/agents') {
      return json(res, { agents: getAgentProfiles() });
    }

    // Dify 连接自检：默认只验证配置不打模型，避免为了试配置白烧 token
    if (pathname === '/api/dify/selftest') {
      if (publicMode || config.mode === 'desktop') return json(res, { error: '请使用模型设置中的连接测试' }, 403);
      const dryRun = url.searchParams.get('run') !== '1';
      try {
        return json(res, await difySelftest({ dryRun }));
      } catch (err) {
        return json(res, { ok: false, steps: [], hint: err.message }, 200);
      }
    }

    if (pathname === '/api/cases') {
      return json(res, { cases: CASES });
    }

    if (pathname === '/api/model/test' && method === 'POST') {
      if (!consumeQuota(req)) return json(res, { error: '连接测试过于频繁，请稍后重试' }, 429);
      const body = await readBody(req);
      try {
        const provider = getProvider(body.provider);
        const overrides = modelOverrides(body.modelSettings, provider.name);
        // Probe authentication/model availability without sending research materials.
        await withModelConfig(overrides, () => provider.chat({ system: 'Connection test.', user: 'Reply OK.', maxTokens: 128 }));
        return json(res, { ok: true, message: provider.name === 'mock' ? '离线演示可用，未调用模型。' : '连接成功。测试会产生少量模型用量。' });
      } catch (err) {
        return json(res, { error: /请先|格式|公网|开放|未知|模型名称/.test(err.message) ? err.message : '连接失败，请检查密钥、模型、地址或网络。' }, 400);
      }
    }

    // ---------- 启动辩论 ----------
    if (pathname === '/api/debate' && method === 'POST') {
      const body = await readBody(req);
      const rawText = String(body.hypothesis || '').trim();
      if (rawText.length < 6) {
        return json(res, { error: '研究假设太短，请至少写清楚研究对象和结局。' }, 400);
      }
      if (rawText.length > 8000) {
        return json(res, { error: '研究材料过长（上限 8000 字符），请精简研究背景并明确本轮焦点。' }, 400);
      }

      let provider;
      let overrides;
      try {
        provider = getProvider(body.provider);
        overrides = modelOverrides(body.modelSettings, provider.name);
      } catch (err) {
        return json(res, { error: err.message }, 400);
      }
      if (publicMode) {
        const active = [...runtime.values()].filter(e => !e.done);
        if (active.length >= 4 || active.some(e => e.owner === owner)) return json(res, { error: '正在处理其他辩论，请稍后重试。' }, 429);
        if (!consumeQuota(req)) return json(res, { error: '本小时使用次数已达上限，请稍后重试。' }, 429);
      }

      // 预生成 id，让前端可以立刻订阅事件流；必须把同一个 id 传给 runDebate，
      // 否则会出现"返回给前端的 id"与"落盘 id"不一致
      const tempId = `arena_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const entry = createRuntime(tempId);
      entry.owner = owner;
      const saveOwned = session => { if (publicMode) session._owner = owner; return store.save(session); };

      const crossRounds = Number.isFinite(Number(body.crossRounds))
        ? Math.max(1, Math.min(4, Number(body.crossRounds)))
        : config.crossRounds;

      broadcast(entry, {
        type: 'started',
        sessionId: tempId,
        provider: provider.name,
        providerLabel: provider.label,
        crossRounds,
        stages: STAGES,
      });

      // 后台跑，不阻塞响应
      withModelConfig(overrides, async () => {
        try {
          const session = await runDebate({
            id: tempId,
            provider,
            rawText,
            rag: provider.name === 'mock' ? { ...config.rag, provider: 'none' } : config.rag,
            emit: (event) => {
              // done 事件对客户端的含义是"结果已经可用"。
              // 必须**先落盘再广播**，否则客户端收到 done 立刻查会话列表会查不到，
              // 万一这会儿服务重启，整场辩论的结果就丢了。（实测踩过这个竞态）
              if (event.type === 'done' && event.session) {
                try {
                  saveOwned(event.session);
                } catch (err) {
                  broadcast(entry, { type: 'notice', level: 'error', message: `会话落盘失败：${err.message}` });
                }
              }
              broadcast(entry, event);
            },
            crossRounds,
            isCancelled: () => entry.cancelled,
            // 增量落盘：一条发言就存一次，节流到最多每 1.5 秒写一次盘。
            // 这样即使服务被 Ctrl+C 或崩掉，已经吵出来的内容也不会丢。
            onProgress: (snapshot) => {
              const now = Date.now();
              if (now - entry.lastPersistAt < 1500) return;
              entry.lastPersistAt = now;
              saveOwned(snapshot);
            },
          });
          entry.session = session;
          // 兜底再存一次（幂等）：防止上面的分支因为异常没走到
          saveOwned(session);
        } catch (err) {
          broadcast(entry, { type: 'error', message: err.message });
        } finally {
          entry.done = true;
          for (const listener of entry.listeners) {
            try {
              listener.end();
            } catch {
              /* ignore */
            }
          }
          entry.listeners.clear();
          const cleanup = setTimeout(() => runtime.delete(tempId), 30 * 60 * 1000);
          cleanup.unref();
        }
      });

      return json(res, { sessionId: tempId, crossRounds, provider: provider.name });
    }

    // ---------- SSE 事件流（支持断线重放）----------
    const streamMatch = /^\/api\/debate\/([\w-]+)\/stream$/.exec(pathname);
    if (streamMatch && method === 'GET') {
      const id = streamMatch[1];
      const entry = runtime.get(id);
      if (!entry) return json(res, { error: '会话不存在或服务已重启' }, 404);

      const from = Number(url.searchParams.get('from') || 0);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');

      // 重放已缓冲的事件
      for (let i = Math.max(0, from); i < entry.events.length; i++) {
        writeSse(res, entry.events[i]);
      }

      if (entry.done) {
        res.end();
        return;
      }

      entry.listeners.add(res);
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, 15000);

      req.on('close', () => {
        clearInterval(keepAlive);
        entry.listeners.delete(res);
      });
      return;
    }

    // ---------- 取消 ----------
    const cancelMatch = /^\/api\/debate\/([\w-]+)\/cancel$/.exec(pathname);
    if (cancelMatch && method === 'POST') {
      const entry = runtime.get(cancelMatch[1]);
      if (!entry) return json(res, { error: '会话不存在' }, 404);
      entry.cancelled = true;
      broadcast(entry, { type: 'notice', level: 'warn', message: '用户请求中止，已产出的内容会保留。' });
      return json(res, { ok: true });
    }

    // ---------- 会话列表与详情 ----------
    if (pathname === '/api/sessions' && method === 'GET') {
      return json(res, { sessions: store.list({ limit: Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50)), owner: publicMode ? owner : undefined }) });
    }

    const reportMatch = /^\/api\/sessions\/([\w-]+)\/report\.(md|html|docx)$/.exec(pathname);
    if (reportMatch && method === 'GET') {
      const session = store.load(reportMatch[1]);
      if (!session) return json(res, { error: '会话不存在' }, 404);
      const kind = reportMatch[2];
      const filename = reportFilename(session, kind);

      if (kind === 'docx') {
        // 手写 OOXML，不引依赖——见 src/export/docx.mjs 的说明
        const buf = toDocx(session, RUBRIC);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Length': buf.length,
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        return res.end(buf);
      }

      const isMd = kind === 'md';
      const body = isMd ? toMarkdown(session) : toHtml(session);
      res.writeHead(200, {
        'Content-Type': isMd ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      });
      return res.end(body);
    }

    const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
    if (sessionMatch) {
      const id = sessionMatch[1];
      if (method === 'GET') {
        const session = store.load(id);
        if (!session) return json(res, { error: '会话不存在' }, 404);
        // 覆盖率按当前算法重算再返回。
        // 会话里存的是辩论当时算的；算法改进后旧结论会与系统不一致
        // （实测：界面显示 4/5，按现行算法其实是 5/5）。
        if (session.contentions?.length) {
          session.coverage = checkCriticalCoverage(session.contentions, session.changeLog || []);
        }
        return json(res, session);
      }
      if (method === 'DELETE') {
        store.remove(id);
        runtime.delete(id);
        return json(res, { ok: true });
      }
    }

    // ---------- 运行中会话的内存快照 ----------
    const liveMatch = /^\/api\/debate\/([\w-]+)$/.exec(pathname);
    if (liveMatch && method === 'GET') {
      const entry = runtime.get(liveMatch[1]);
      if (!entry) return json(res, { error: '会话不存在' }, 404);
      return json(res, { done: entry.done, eventCount: entry.events.length, session: entry.session });
    }

    // ---------- 静态资源 ----------
    if (method === 'GET') return serveStatic(req, res, pathname);

    return json(res, { error: '未找到该接口' }, 404);
  } catch (err) {
    return json(res, { error: err.message || '服务器内部错误' }, 500);
  }
});

// The local desktop backend must not outlive a crashed or closed parent app.
if (config.mode === 'desktop' && process.send) {
  process.on('disconnect', () => { server.close(); process.exit(0); });
}

/**
 * 启动前自检。
 *
 * 目的很单一：把"现场跑不起来"这件事提前到启动那 200 毫秒暴露，
 * 而不是等你打开浏览器点了启动辩论才发现。
 */
function preflight() {
  const fatal = [];
  const warn = [];

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) {
    fatal.push(`Node 版本过低：当前 ${process.versions.node}，需要 ≥ 24（依赖内置 fetch 与 zlib.crc32）`);
  }

  if (!fs.existsSync(path.join(config.root, '.env'))) {
    warn.push('没有找到 .env，将使用默认值。可以从 .env.example 复制一份并填入密钥。');
  }

  const p = config.provider;
  if (config.mode === 'local' && p === 'deepseek' && !config.deepseek.apiKey) {
    fatal.push('LLM_PROVIDER=deepseek 但没有配置 DEEPSEEK_API_KEY。先改成 mock 可以离线演示。');
  }
  if (config.mode === 'local' && p === 'dify' && (!config.dify.baseUrl || !config.dify.appKey)) {
    fatal.push('LLM_PROVIDER=dify 但没有配置 DIFY_APP_KEY。用页面上的「Dify 连接自检」排查，或先改成 deepseek / mock。');
  }

  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK);
  } catch {
    fatal.push(`数据目录不可写：${config.dataDir}`);
  }

  if (config.provider === 'dify' && config.dify.pinIp && config.dify.baseUrl.startsWith('https')) {
    warn.push(`Dify 请求将钉死到 IP ${config.dify.pinIp}（SNI 仍用真实域名）。地址变更时记得同步改 DIFY_PIN_IP。`);
  }

  return { fatal, warn };
}

const pre = preflight();
if (pre.warn.length) {
  console.log('');
  for (const w of pre.warn) console.log(`  \x1b[33m⚠ ${w}\x1b[0m`);
}
if (pre.fatal.length) {
  console.log('');
  console.log('  \x1b[31m✗ 启动自检未通过\x1b[0m');
  for (const f of pre.fatal) console.log(`    · ${f}`);
  console.log('');
  process.exit(1);
}

// 回收上次被中断的会话（辩论过程中会增量落盘，所以磁盘上可能有半成品）
const recovered = store.markInterrupted();
if (recovered.length) {
  console.log('');
  for (const r of recovered) {
    console.log(`  \x1b[33m⚑ 恢复中断的会话 ${r.id}\x1b[0m（已保留 ${r.messages} 条发言，可在「历史会话」里查看与导出）`);
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  \x1b[31m✗ 端口 ${config.port} 已被占用\x1b[0m`);
    console.log('    · 可能已经有一个 Science Arena 在跑：直接打开下面的地址试试');
    console.log(`      http://localhost:${config.port}`);
    console.log('    · 想同时开第二个，就在 .env 里把 PORT 改成别的值');
    console.log('');
    process.exit(1);
  }
  throw err;
});

server.listen(config.port, config.host, () => {
  const port = server.address().port;
  process.send?.({ type: 'ready', port });
  console.log('');
  console.log('  \x1b[1m\x1b[36mScience Arena\x1b[0m  \x1b[2m多智能体科研假说辩论与方案修正平台\x1b[0m');
  console.log('  \x1b[2m─────────────────────────────────────────────\x1b[0m');
  console.log(`  地址    \x1b[1mhttp://${config.host}:${port}\x1b[0m`);
  console.log(`  模型    ${describeProvider()}`);
  console.log(`  可选    ${providerNames.join(' / ')}（请求体传 provider 字段可单次覆盖）`);
  console.log(`  数据    ${config.dataDir}`);
  console.log('  \x1b[2m─────────────────────────────────────────────\x1b[0m');
  console.log('  \x1b[2mCtrl+C 停止\x1b[0m');
  console.log('');
});
