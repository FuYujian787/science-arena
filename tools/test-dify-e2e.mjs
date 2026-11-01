#!/usr/bin/env node
/**
 * Dify 后端端到端集成测试。
 *
 * 为什么值得单独写：`src/llm/dify.mjs` 是唯一无法用真实服务验证的模块
 * （需要一个 App API Key）。没跑过的代码就是没写过的代码——
 * 这个测试拉起本地模拟的 Dify 服务，把整条链路真正跑一遍：
 *   流式 SSE 解析 → 引擎编排 → S4/S5 的 JSON 合成 → 覆盖率校验
 *
 * 用法：node tools/test-dify-e2e.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PORT = 8793;
const KEY = 'app-e2e-test-key';

let passed = 0;
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 必须在 import config 之前设好环境变量
process.env.DIFY_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.DIFY_APP_KEY = KEY;

const mock = spawn(process.execPath, [path.join(ROOT, 'tools', 'mock-dify.mjs'), `--port=${PORT}`, `--key=${KEY}`], {
  stdio: 'ignore',
});

function cleanup(code) {
  try {
    mock.kill();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

try {
  // 等模拟服务起来（不带 Key 会得到 401，说明端口已经在监听）
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/v1/parameters?user=probe`);
      if (res.status > 0) up = true;
    } catch {
      await sleep(150);
    }
  }
  if (!up) throw new Error('模拟 Dify 服务未启动');

  const { getProvider } = await import('../src/llm/provider.mjs');
  const { runDebate } = await import('../src/engine/debate.mjs');
  const { selftest } = await import('../src/llm/dify.mjs');

  console.log('\n自检流程');
  const st = await selftest({ dryRun: false });
  check('自检通过', st.ok === true, `hint=${st.hint}`);
  check(
    '自检逐步给出结论',
    st.steps.length >= 4 && st.steps.every((s) => typeof s.name === 'string' && typeof s.ok === 'boolean'),
  );

  console.log('\n完整辩论（provider=dify，流式）');
  const events = [];
  const session = await runDebate({
    provider: getProvider('dify'),
    rawText: '某种菌群能否通过胆汁酸改善IBD抑郁共病？',
    emit: (e) => events.push(e),
    crossRounds: 1,
  });

  check('会话完成', session.state === 'done', session.state);
  check('六个角色都发言', new Set(session.messages.map((m) => m.agentId)).size === 6);
  check('无角色缺席', session.messages.every((m) => !m.absent));
  check('S0–S5 六个阶段都跑到', ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'].every((s) => session.stages.some((x) => x.id === s)));
  check('证据卡已解析', session.evidence.length === 2, `实际 ${session.evidence.length}`);
  check('评分卡已解析', session.scorecard && session.scorecard.total != null, `total=${session.scorecard?.total}`);
  check('争议清单已解析', session.contentions.length === 3, `实际 ${session.contentions.length}`);
  check('修改对照表已解析', session.changeLog.length === 2, `实际 ${session.changeLog.length}`);
  check('致命争议 100% 覆盖', session.coverage?.ratio === 1, JSON.stringify(session.coverage?.uncovered));
  check('Open Issue 被保留（未被抹平）', session.contentions.some((c) => c.level === 'Open Issue'));
  check('修正方案非空', (session.revisedProtocol || '').length > 200);

  const kinds = new Set(events.map((e) => e.type));
  check('SSE 事件类型齐全', ['hypothesis', 'evidence', 'message', 'scorecard', 'contentions', 'done'].every((k) => kinds.has(k)));
  check('流式分片确实产生了', events.filter((e) => e.type === 'agent_delta').length > 0);

  console.log('\n错误诊断');
  process.env.DIFY_APP_KEY = 'app-wrong-key-for-diagnosis';
  // config 在导入时已固化，改 env 不生效，所以直接验证 401 分支的判定逻辑
  const badKeyProbe = await fetch(`http://127.0.0.1:${PORT}/v1/parameters?user=x`, {
    headers: { Authorization: 'Bearer app-wrong' },
  });
  check('错误密钥返回 401', badKeyProbe.status === 401, `实际 ${badKeyProbe.status}`);

  console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} passed, ${failed} failed\n`);
  cleanup(failed === 0 ? 0 : 1);
} catch (err) {
  console.error('\n集成测试异常：', err.message);
  cleanup(1);
}
