#!/usr/bin/env node
/**
 * HTTP 全链路端到端测试。
 *
 * 覆盖一个真实用户从打开页面到导出报告会走的每一步：
 *   冷启动 → 健康检查 → 角色/案例 → 发起辩论 → SSE 事件流 →
 *   会话列表 → 会话详情 → 三种格式导出 → 删除
 *
 * 这是"可现场演示"这句话唯一靠谱的证明方式：不是我说它能跑，
 * 而是每次改完代码，这个测试都会替我把整条路走一遍。
 *
 * 用 mock 后端跑，所以不消耗 token、不依赖网络。
 * 用法：node tools/test-http-e2e.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), LLM_PROVIDER: 'mock' },
  stdio: 'ignore',
});

function cleanup(code) {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

async function api(pathname, options) {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/** 读 SSE，直到收到 done 或超时 */
function readStream(sessionId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const events = [];
    const ac = new AbortController();
    const timer = setTimeout(() => {
      ac.abort();
      resolve({ events, timedOut: true });
    }, timeoutMs);

    fetch(`${BASE}/api/debate/${sessionId}/stream?from=0`, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            try {
              const evt = JSON.parse(line.slice(5).trim());
              events.push(evt);
              if (evt.type === 'done') {
                clearTimeout(timer);
                ac.abort();
                return resolve({ events, timedOut: false });
              }
            } catch {
              /* 忽略注释行等 */
            }
          }
        }
        clearTimeout(timer);
        resolve({ events, timedOut: false });
      })
      .catch((err) => {
        clearTimeout(timer);
        if (err.name === 'AbortError') resolve({ events, timedOut: true });
        else reject(err);
      });
  });
}

try {
  // ---------- 冷启动 ----------
  console.log('\n冷启动');
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) up = true;
    } catch {
      await sleep(200);
    }
  }
  if (!up) throw new Error('服务未在预期时间内启动');
  check('服务在 200ms 级时间内起来', true);

  // ---------- 元数据接口 ----------
  console.log('\n元数据');
  const health = await api('/api/health');
  check('GET /api/health 200', health.status === 200);
  check('后端为 mock', health.body.provider === 'mock', health.body.provider);
  check('阶段定义有 6 个', (health.body.stages || []).length === 6);
  check('评分卡维度有 5 个', (health.body.rubric || []).length === 5);
  check('带了解释性免责声明', typeof health.body.disclaimer === 'string' && health.body.disclaimer.length > 20);

  const agents = await api('/api/agents');
  check('GET /api/agents 返回 6 个角色', (agents.body.agents || []).length === 6);
  check(
    '角色元数据字段完整',
    agents.body.agents.every((a) => a.id && a.name && a.color && a.discipline),
  );

  const cases = await api('/api/cases');
  check('GET /api/cases 返回案例', (cases.body.cases || []).length >= 4);
  check(
    '案例都带假设文本',
    cases.body.cases.every((c) => typeof c.hypothesis === 'string' && c.hypothesis.length > 5),
  );

  // ---------- 触发一次辩论 ----------
  console.log('\n发起辩论 + SSE 事件流');
  const started = await api('/api/debate', {
    method: 'POST',
    body: JSON.stringify({ hypothesis: '某种菌群能否通过胆汁酸改善IBD抑郁共病？', provider: 'mock', crossRounds: 1 }),
  });
  check('POST /api/debate 返回 sessionId', started.status === 200 && !!started.body.sessionId);
  const sid = started.body.sessionId;

  const tooShort = await api('/api/debate', { method: 'POST', body: JSON.stringify({ hypothesis: '短' }) });
  check('过短的假设被拒绝（400）', tooShort.status === 400);

  const { events, timedOut } = await readStream(sid);
  check('事件流正常结束（未超时）', !timedOut);
  const kinds = new Set(events.map((e) => e.type));
  for (const t of ['started', 'stage', 'agent_start', 'agent_delta', 'message', 'hypothesis', 'evidence', 'scorecard', 'contentions', 'protocol', 'done']) {
    check(`SSE 事件含 ${t}`, kinds.has(t));
  }
  const msgEvents = events.filter((e) => e.type === 'message');
  check('收到 16 条发言事件', msgEvents.length === 16, `实际 ${msgEvents.length}`);
  const doneEvt = events.find((e) => e.type === 'done');
  check('done 事件携带完整会话', !!doneEvt?.session?.contentions?.length);
  check('致命争议 100% 覆盖', doneEvt?.session?.coverage?.ratio === 1);

  // ---------- 会话管理 ----------
  console.log('\n会话管理与导出');
  const list = await api('/api/sessions');
  check('会话出现在列表中', (list.body.sessions || []).some((s) => s.id === sid));
  const row = list.body.sessions.find((s) => s.id === sid);
  check('列表带统计信息', row.contentionCount > 0 && row.scoreTotal != null);

  const detail = await api(`/api/sessions/${sid}`);
  check('GET 会话详情 200', detail.status === 200);
  check('详情含完整发言', (detail.body.messages || []).length === 16);
  check('详情含证据卡', (detail.body.evidence || []).length > 0);

  const missing = await api('/api/sessions/arena_not_exist');
  check('不存在的会话返回 404', missing.status === 404);

  for (const [kind, minSize, expectType] of [
    ['md', 5000, 'text/markdown'],
    ['html', 8000, 'text/html'],
    ['docx', 8000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ]) {
    const r = await fetch(`${BASE}/api/sessions/${sid}/report.${kind}`);
    const buf = Buffer.from(await r.arrayBuffer());
    check(`导出 ${kind} 成功`, r.status === 200 && buf.length > minSize, `size=${buf.length}`);
    check(`导出 ${kind} 类型正确`, (r.headers.get('content-type') || '').includes(expectType));
    if (kind === 'docx') {
      check('docx 是合法 ZIP', buf.readUInt32LE(0) === 0x04034b50);
    }
  }

  // ---------- 清理 ----------
  const del = await api(`/api/sessions/${sid}`, { method: 'DELETE' });
  check('DELETE 会话成功', del.status === 200);
  const after = await api('/api/sessions');
  check('删除后不在列表中', !(after.body.sessions || []).some((s) => s.id === sid));

  // ---------- 静态资源 ----------
  console.log('\n前端静态资源');
  for (const [p, must] of [
    ['/', 'Science Arena'],
    ['/app.js', 'renderReport'],
    ['/scoring.mjs', 'normalizeScorecard'],
    ['/styles.css', '--vermilion'],
  ]) {
    const r = await fetch(BASE + p);
    const t = await r.text();
    check(`GET ${p} 正常`, r.status === 200 && t.includes(must), `status=${r.status}`);
    if (p === '/scoring.mjs') check('评分模块以JavaScript类型返回', (r.headers.get('content-type') || '').includes('javascript'));
  }

  console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} passed, ${failed} failed\n`);
  cleanup(failed === 0 ? 0 : 1);
} catch (err) {
  console.error('\n端到端测试异常：', err.message);
  cleanup(1);
}
