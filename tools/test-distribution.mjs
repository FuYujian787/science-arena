import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { config, withModelConfig } from '../src/config.mjs';
import { deepseekProvider } from '../src/llm/deepseek.mjs';

let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; console.log(`✓ ${message}`); }
const fetchOriginal = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    await delay(options.headers.Authorization.endsWith('alpha') ? 25 : 2);
    return { ok: true, json: async () => ({ model: JSON.parse(options.body).model, choices: [{ message: { content: options.headers.Authorization } }] }) };
  };
  const [a,b] = await Promise.all(['alpha','beta'].map(apiKey => withModelConfig({ deepseek: { ...config.deepseek, apiKey, model: apiKey } }, () => deepseekProvider.chat({ user:'test' }))));
  check(a.content === 'Bearer alpha' && b.content === 'Bearer beta', 'Concurrent model calls retain their own API keys');
  check(a.model === 'alpha' && b.model === 'beta', 'Concurrent model calls retain their own models');
} finally { globalThis.fetch = fetchOriginal; }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-distribution-'));
let server;
async function start() {
  server = fork(new URL('../server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT:'0',HOST:'127.0.0.1', ARENA_MODE:'public', ARENA_IGNORE_ENV_FILE:'1',
      ARENA_DATA_DIR:dir, LLM_PROVIDER:'deepseek', DEEPSEEK_API_KEY:'server-secret-canary', RAG_PROVIDER:'none', ARENA_HOURLY_LIMIT:'100' },
    stdio:['ignore','ignore','inherit','ipc'],
  });
  return await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('Server startup timeout')),10000);
    server.once('error',reject);
    server.once('exit', code => reject(new Error(`Server exited ${code}`)));
    server.on('message',msg=>{ if(msg.type==='ready') {clearTimeout(timer);resolve(`http://127.0.0.1:${msg.port}`);} });
  });
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited;
}
try {
  let base = await start();
  const health = await fetch(base+'/api/health');
  const cookieA = health.headers.get('set-cookie').split(';')[0];
  const cookieB = (await fetch(base+'/api/health')).headers.get('set-cookie').split(';')[0];
  const metadata = await health.json();
  check(metadata.personalKeys && !metadata.deepseekReady, 'Public mode does not expose server credentials as configured');
  check(cookieA !== cookieB, 'Visitors receive independent HttpOnly cookies');
  const headers = { 'Content-Type':'application/json',Cookie:cookieA };
  const denied = await fetch(base+'/api/debate',{ method:'POST',headers,body:JSON.stringify({hypothesis:'长期睡眠剥夺是否会导致肥胖？',provider:'deepseek'}) });
  check(denied.status===400, 'Public users cannot silently use the server API key');
  const ssrf = await fetch(base+'/api/model/test',{method:'POST',headers,body:JSON.stringify({provider:'deepseek',modelSettings:{apiKey:'test',baseUrl:'http://127.0.0.1:9'}})});
  check(ssrf.status===400, 'Public custom model endpoints are refused');
  const cross = await fetch(base+'/api/debate',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'},body:'{}'});
  check(cross.status===403, 'Cross-site write requests are refused');
  check((await fetch(base+'/api/dify/selftest',{headers})).status===403, 'Public Dify probe cannot use deployment secrets');
  const created = await fetch(base+'/api/debate',{method:'POST',headers,body:JSON.stringify({hypothesis:'长期睡眠剥夺是否会导致肥胖？',provider:'mock',crossRounds:1,modelSettings:{apiKey:'visitor-secret-canary'}})});
  assert.equal(created.status,200); const {sessionId:id} = await created.json();
  for (const [method,route] of [['GET',`/api/debate/${id}`],['GET',`/api/debate/${id}/stream`],['POST',`/api/debate/${id}/cancel`],['GET',`/api/sessions/${id}`],['GET',`/api/sessions/${id}/report.md`],['GET',`/api/sessions/${id}/report.docx`],['GET',`/api/sessions/${id}/report.html`],['DELETE',`/api/sessions/${id}`]]) {
    const res = await fetch(base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookieB}});
    check(res.status===404, `Other visitor refused: ${method} ${route.replace(id,'<id>')}`);
  }
  let session;
  for (let i=0;i<120;i++) {
    const live = await (await fetch(base+`/api/debate/${id}`,{headers})).json();
    if (live.done) {session=live.session;break;} await delay(500);
  }
  check(session?.state==='done', 'Public visitor can complete a full mock debate');
  const listB = await (await fetch(base+'/api/sessions',{headers:{Cookie:cookieB}})).json();
  const listA = await (await fetch(base+'/api/sessions',{headers})).json();
  check(listB.sessions.length===0 && listA.sessions.some(s=>s.id===id), 'History listing is isolated by visitor');
  check((await fetch(base+`/api/sessions/${id}/report.docx`,{headers})).status===200, 'Owner can export Word');
  const disk=fs.readFileSync(path.join(dir,`${id}.json`),'utf8');
  check(!disk.includes('visitor-secret-canary')&&!disk.includes('server-secret-canary'), 'API keys are absent from saved debate JSON');
  await stop(); base=await start();
  check((await fetch(base+`/api/sessions/${id}`,{headers})).status===200, 'Owner can reopen history after server restart');
  check((await fetch(base+`/api/sessions/${id}`,{headers:{Cookie:cookieB}})).status===404, 'Isolation survives server restart');
  for (const asset of ['/manifest.webmanifest','/sw.js','/icons/icon-192.png','/icons/icon-512.png']) check((await fetch(base+asset)).status===200, `PWA asset available: ${asset}`);
  console.log(`Distribution checks passed: ${checks}`);
} finally {
  await stop(); fs.rmSync(dir,{recursive:true,force:true});
}
