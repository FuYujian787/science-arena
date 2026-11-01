/* ============================================================
   Science Arena 前端
   原生 ES Module，无构建步骤。
   ============================================================ */

import { normalizeScorecard, validScore, computeTotal, scorecardNotice, assessmentText } from './scoring.mjs';
import { initModelSettings, getModelSettings } from './settings.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LEVEL_CN = { Critical: '致命', Major: '重要', Minor: '次要', 'Open Issue': '未解决' };
const LEVEL_ORDER = { Critical: 0, Major: 1, 'Open Issue': 2, Minor: 3 };

const state = {
  view: 'home',
  health: null,
  agents: [],
  cases: [],
  session: null,          // 完成后的完整会话
  live: null,             // 运行中的会话快照
  eventSource: null,
  msgEls: new Map(),      // messageId -> { card, body, text, reasoning, reasonEl }
  roleStatus: new Map(),  // agentId -> 'idle' | 'speaking' | 'done' | 'absent'
  stageEls: new Map(),
  follow: true,
  currentStage: null,
  msgSeq: 0,
};

/* ------------------------------ 基础工具 ------------------------------ */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 把【标签】和 [E-01] 高亮 */
function highlight(text) {
  return esc(text)
    .replace(/【([^】]{1,20})】/g, '<span class="tag-k">【$1】</span>')
    .replace(/\[E-\d{2}\]/g, '<span class="tag-e">$&</span>');
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：HTTP ${res.status}`);
  return data;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------ 视图切换 ------------------------------ */

function switchView(view) {
  state.view = view;
  for (const v of ['home', 'arena', 'report', 'library']) {
    $(`#view-${v}`).hidden = v !== view;
  }
  $$('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'library') loadLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  try {
    const health = await api('/api/health');
    state.health = health;
    $('#provider-pill').textContent = health.providerLabel;
    buildProviderSelect(health);
    renderStagebar(health.stages);
    await initModelSettings(health);
  } catch (err) {
    toast(`无法连接后端：${err.message}`, 'error');
  }

  try {
    const { agents } = await api('/api/agents');
    state.agents = agents;
    renderRail(agents);
    renderHomeRoles(agents);
  } catch { /* 忽略 */ }

  try {
    const { cases } = await api('/api/cases');
    state.cases = cases;
    renderCases($('#case-grid'), cases);
    renderCases($('#library-grid'), cases, true);
  } catch { /* 忽略 */ }

  loadSessions();

  // 事件绑定
  $$('.navbtn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
  $('#hypothesis').addEventListener('input', (e) => {
    $('#char-count').textContent = e.target.value.length;
  });
  $$('[data-input-mode]').forEach(b => b.addEventListener('click', () => setInputMode(b.dataset.inputMode)));
  $('#btn-input-template').addEventListener('click', () => {
    const input = $('#hypothesis');
    if (input.value.trim()) { toast('已保留你的输入。请按研究背景、已完成工作、本轮焦点和待核查材料补充。'); return; }
    input.value = '【研究背景】\n说明研究对象、暴露与结局。\n\n【已完成的研究】\n1. 写明已完成的方法与实际结果。\n2. 不同来源的数据分别说明。\n\n【本轮焦点】\n写一个具体问题或需要比较的解释。\n\n【材料边界】\n列出尚未提供的补充表、时间信息或其他材料，请将其作为待核查项。';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
  $('#btn-start').addEventListener('click', startDebate);
  $('#hypothesis').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') startDebate();
  });
  $('#btn-cancel').addEventListener('click', cancelDebate);
  $('#btn-refresh-sessions').addEventListener('click', () => loadSessions());
  $('#btn-health').addEventListener('click', showHealth);
  $('#modal-close').addEventListener('click', () => ($('#modal').hidden = true));
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  });
  $('#btn-follow').addEventListener('click', toggleFollow);

  $$('.sidetab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.sidetab').forEach((x) => x.classList.toggle('active', x === t));
      $('#side-evidence').hidden = t.dataset.side !== 'evidence';
      $('#side-contentions').hidden = t.dataset.side !== 'contentions';
    }),
  );

  $$('#report-tabs .tab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('#report-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      $$('#report-panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
    }),
  );

  // 深链接：?session=<id>&view=arena|report 可直接打开某次评审（方便分享与复盘）
  const params = new URLSearchParams(location.search);
  const sid = params.get('session');
  if (sid) {
    openSession(sid, params.get('view') === 'arena' ? 'arena' : 'report');
  } else if (params.get('case')) {
    const c = state.cases.find((x) => x.id === params.get('case'));
    if (c) {
      $('#hypothesis').value = c.hypothesis;
      $('#char-count').textContent = c.hypothesis.length;
    }
  }
}

function buildProviderSelect(health) {
  const sel = $('#provider-select');
  sel.innerHTML = '';
  const labels = { deepseek: 'DeepSeek 直连', dify: 'Dify 应用', mock: 'Mock 离线干跑' };
  for (const p of health.providers || []) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = labels[p] || p;
    if (p === health.provider) opt.selected = true;
    // 明显没配置好的后端给出提示，但不禁用——用户可能刚填好还没重启
    if (p === 'deepseek' && !health.deepseekReady) opt.textContent += '（未配置 Key）';
    if (p === 'dify' && !health.difyReady) opt.textContent += '（未配置 App Key）';
    sel.appendChild(opt);
  }
}

/* ------------------------------ 首页渲染 ------------------------------ */

function renderCases(container, cases, withNote = false) {
  if (!container) return;
  container.innerHTML = '';
  for (const c of cases) {
    const card = document.createElement('button');
    card.className = 'case-card';
    card.type = 'button';
    card.innerHTML = `
      <span class="tag">${esc(c.tag || '案例')}</span>
      <h4>${esc(c.title)}</h4>
      <p>${esc(withNote ? c.note : c.hypothesis)}</p>`;
    card.addEventListener('click', () => {
      $('#hypothesis').value = c.hypothesis;
      $('#char-count').textContent = c.hypothesis.length;
      $('#home-hint').textContent = '已填入案例，点「启动辩论」开始。';
      $('#home-hint').className = 'hint';
      switchView('home');
      $('#hypothesis').focus();
    });
    container.appendChild(card);
  }
}

function sessionRow(s) {
  const row = document.createElement('div');
  row.className = 'session-row';
  const stateCn = { done: '已完成', cancelled: '已中止', failed: '失败', running: '进行中', interrupted: '已中断' }[s.state] || s.state;
  row.innerHTML = `
    <div class="sr-main">
      <div class="sr-title">${esc(/【(?:本轮唯一焦点|本轮焦点)】\s*([^\n]+)/.exec(s.rawText || '')?.[1] || s.name || s.rawText || s.id)}</div>
      <div class="sr-meta">${fmtTime(s.createdAt)} · ${stateCn} · ${s.messageCount} 条发言</div>
    </div>
    <div class="sr-stats">
      ${s.criticalCount ? `<span class="stat-chip crit">致命 ${s.criticalCount}</span>` : ''}
      ${s.contentionCount ? `<span class="stat-chip">争议 ${s.contentionCount}</span>` : ''}
      ${s.scoreTotal != null ? `<span class="stat-chip score">初评 ${s.scoreTotal}</span>` : ''}
    </div>`;
  const main = $('.sr-main', row);
  main.setAttribute('role', 'button');
  main.tabIndex = 0;
  main.addEventListener('click', () => openSession(s.id));
  main.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSession(s.id); } });
  return row;
}

async function loadSessions() {
  try {
    const { sessions } = await api('/api/sessions');
    const list = $('#session-list');
    list.innerHTML = '';
    if (!sessions.length) {
      list.innerHTML = '<p class="muted">还没有历史会话。启动第一次辩论后，记录会出现在这里。</p>';
      return;
    }
    sessions.forEach((s) => list.appendChild(sessionRow(s)));
  } catch (err) {
    $('#session-list').innerHTML = `<p class="muted">加载失败：${esc(err.message)}</p>`;
  }
}

async function loadLibrary() {
  try {
    const { sessions } = await api('/api/sessions');
    const box = $('#library-sessions');
    box.innerHTML = '';
    if (!sessions.length) {
      box.innerHTML = '<p class="muted">还没有历史评审记录。</p>';
      return;
    }
    sessions.forEach((s) => box.appendChild(sessionRow(s)));
  } catch { /* 忽略 */ }
}

async function openSession(id, view = 'report') {
  try {
    const session = await api(`/api/sessions/${id}`);
    state.session = session;
    $('#nav-report').disabled = false;
    $('#nav-arena').disabled = false;
    renderArena(session);
    renderReport(session);
    switchView(view);
  } catch (err) {
    toast(`打开会话失败：${err.message}`, 'error');
  }
}

/* ------------------------------ 启动辩论 ------------------------------ */

function setInputMode(mode) {
  const detailed = mode === 'research';
  $$('[data-input-mode]').forEach(b => {
    const active = b.dataset.inputMode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  const input = $('#hypothesis');
  input.maxLength = detailed ? 8000 : 2000;
  input.rows = detailed ? 12 : 4;
  input.classList.toggle('research-input', detailed);
  input.placeholder = detailed ? '研究背景与已完成工作 → 本轮焦点 → 未提供材料。请分别说明不同数据来源。' : '例如：某种菌群能否通过胆汁酸改善 IBD 抑郁共病？';
  $('#input-label').textContent = detailed ? '提供研究背景，围绕一个具体问题展开讨论' : '把你想做的研究写成一句话';
  $('#input-limit').textContent = input.maxLength;
  $('.sheet-guide').hidden = detailed;
  $('#research-guide').hidden = !detailed;
}

async function startDebate() {
  const rawText = $('#hypothesis').value.trim();
  const hint = $('#home-hint');
  if (rawText.length > $('#hypothesis').maxLength) {
    hint.textContent = '输入超过当前方式的长度限制，请切换“已有研究”或精简内容。';
    hint.className = 'hint error';
    return;
  }
  if (rawText.length < 6) {
    hint.textContent = '请先写清楚研究假设（至少 6 个字）。';
    hint.className = 'hint error';
    return;
  }
  hint.textContent = '';
  hint.className = 'hint';

  const provider = $('#provider-select').value;
  const crossRounds = Number($('#rounds-select').value);

  $('#btn-start').disabled = true;
  $('.btn-label', $('#btn-start')).textContent = '启动中…';

  try {
    const { sessionId } = await api('/api/debate', {
      method: 'POST',
      body: JSON.stringify({ hypothesis: rawText, provider, crossRounds, modelSettings: getModelSettings(provider) }),
    });
    resetArena();
    $('#nav-arena').disabled = false;
    $('#nav-report').disabled = true;
    switchView('arena');
    connectStream(sessionId);
  } catch (err) {
    hint.textContent = err.message;
    hint.className = 'hint error';
    toast(err.message, 'error');
  } finally {
    $('#btn-start').disabled = false;
    $('.btn-label', $('#btn-start')).textContent = '启动辩论';
  }
}

async function cancelDebate() {
  if (!state.live?.id) return;
  try {
    await api(`/api/debate/${state.live.id}/cancel`, { method: 'POST' });
  } catch { /* 忽略 */ }
}

function toggleFollow() {
  state.follow = !state.follow;
  $('#btn-follow').textContent = `跟随：${state.follow ? '开' : '关'}`;
}

/* ------------------------------ SSE 连接 ------------------------------ */

function connectStream(sessionId) {
  if (state.eventSource) state.eventSource.close();
  state.live = { id: sessionId };
  $('#live-dot').className = 'live-dot on';
  $('#arena-title').textContent = '辩论进行中';
  $('#arena-sub').textContent = `会话 ${sessionId}`;
  $('#btn-cancel').hidden = false;

  const es = new EventSource(`/api/debate/${sessionId}/stream?from=0`);
  state.eventSource = es;

  const TYPES = [
    'started', 'stage', 'agent_start', 'agent_delta', 'message', 'notice',
    'hypothesis', 'evidence', 'scorecard', 'contentions', 'protocol', 'done', 'error',
  ];
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      try {
        handleEvent(JSON.parse(e.data));
      } catch (err) {
        console.error('事件解析失败', err);
      }
    });
  }
  es.onerror = async () => {
    // 服务端主动断开（辩论结束）时也会触发 onerror。
    // 如果事件流根本没建立起来（比如服务重启后内存里的会话没了），
    // 就退回去读落盘的会话记录，不要让用户看到空白页。
    if (es.readyState === EventSource.CLOSED) {
      $('#live-dot').className = 'live-dot';
      const live = await api(`/api/debate/${sessionId}`).catch(() => null);
      if (!live) {
        toast('事件流已断开，正在从存档加载该会话…', 'warn');
        openSession(sessionId, 'report');
      }
    }
  };
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  $('#btn-cancel').hidden = true;
}

/* ------------------------------ 事件处理 ------------------------------ */

function handleEvent(evt) {
  switch (evt.type) {
    case 'started':
      state.live.id = evt.sessionId;
      $('#arena-sub').textContent = `${evt.providerLabel || evt.provider} · 交叉质疑 ${evt.crossRounds} 轮`;
      break;

    case 'stage':
      onStage(evt);
      break;

    case 'agent_start':
      setRoleStatus(evt.agentId, 'speaking');
      createMessage(evt);
      break;

    case 'agent_delta':
      appendDelta(evt);
      break;

    case 'message':
      finalizeMessage(evt.message);
      break;

    case 'notice':
      addNotice(evt.message, evt.level);
      break;

    case 'hypothesis':
      renderHypothesisCard(evt.hypothesis);
      break;

    case 'evidence':
      renderEvidence(evt.items, evt.coverage, evt.disclaimer, evt.rag);
      break;

    case 'scorecard':
      state.partialScorecard = evt.scorecard;
      break;

    case 'contentions':
      state.partialContentions = evt;
      renderContentions(evt.contentions, evt.coverage);
      break;

    case 'protocol':
      state.partialProtocol = evt.revisedProtocol;
      break;

    case 'done':
      onDone(evt);
      break;

    case 'error':
      addNotice(evt.message, 'error');
      $('#live-dot').className = 'live-dot err';
      break;

    default:
      break;
  }
}

function onStage(evt) {
  const el = state.stageEls.get(evt.stage);
  if (evt.status === 'start') {
    if (state.currentStage && state.stageEls.get(state.currentStage)) {
      state.stageEls.get(state.currentStage).classList.remove('active');
      state.stageEls.get(state.currentStage).classList.add('done');
    }
    state.currentStage = evt.stage;
    if (el) {
      el.classList.add('active');
      el.classList.remove('done');
    }
    if (evt.stage === 'S2') addStageDivider(`S2 交叉质疑`);
    else if (evt.stage !== 'EVIDENCE') addStageDivider(`${evt.stage} ${evt.name}`);
    $('#arena-title').textContent = evt.name || '辩论进行中';
  } else {
    if (el) {
      el.classList.remove('active');
      el.classList.add('done');
      const t = $('.si-time', el);
      if (t && evt.elapsedMs != null) t.textContent = `${(evt.elapsedMs / 1000).toFixed(1)}s`;
    }
    state.currentStage = null;
  }
}

function onDone(evt) {
  closeStream();
  $('#live-dot').className = 'live-dot';
  const label = { done: '辩论完成', cancelled: '已中止', failed: '发生错误', interrupted: '已中断' }[evt.state] || '结束';
  $('#arena-title').textContent = label;
  $('#btn-cancel').hidden = true;
  $$('.role-card').forEach((c) => c.classList.remove('speaking'));

  if (evt.session) {
    state.session = evt.session;
    if (evt.state === 'done') {
      $('#nav-report').disabled = false;
      renderReport(evt.session);
      toast('辩论完成，已生成评审产出', 'ok');
    } else {
      toast(`辩论${label}，已产出的内容保留`, evt.state === 'failed' ? 'error' : 'warn');
    }
    // 刷新历史列表
    loadSessions();
  }
}

/* ------------------------------ 辩论场渲染 ------------------------------ */

function renderStagebar(stages) {
  const bar = $('#stagebar');
  bar.innerHTML = '';
  state.stageEls.clear();
  for (const s of stages) {
    const el = document.createElement('div');
    el.className = 'stage-item';
    el.innerHTML = `
      <div class="si-id">${esc(s.id)}</div>
      <div class="si-name">${esc(s.name)}</div>
      <div class="si-time">${esc(s.goal || '')}</div>`;
    bar.appendChild(el);
    state.stageEls.set(s.id, el);
  }
}

function renderRail(agents) {
  const rail = $('#role-rail');
  rail.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'role-card';
    el.dataset.agent = a.id;
    el.title = `${a.name} · ${a.role}｜${a.short || ''}`;
    el.innerHTML = `
      <div class="role-avatar" style="background:${esc(a.color)}">${esc(a.name.slice(0, 1))}</div>
      <div class="role-info">
        <div class="role-name">${esc(a.name)}</div>
        <div class="role-disc">${esc(a.discipline || a.role)}</div>
      </div>
      <div class="role-status"></div>`;
    rail.appendChild(el);
  }
}

/** 首页右栏：把"谁会上场"直接写在首页上——这是产品最核心的差异点，
 *  不该只有跑起来之后才看得见 */
function renderHomeRoles(agents) {
  const box = $('#home-roles');
  if (!box) return;
  box.innerHTML = '';
  for (const a of agents) {
    const el = document.createElement('div');
    el.className = 'sig';
    el.innerHTML = `
      <span class="sig-mark" style="background:${esc(a.color)}"></span>
      <div class="sig-body">
        <div>
          <span class="sig-name">${esc(a.name)}</span>
          <span class="sig-role">${esc(a.role || '')}</span>
        </div>
        <div class="sig-line">${esc(a.short || a.discipline || '')}</div>
      </div>`;
    box.appendChild(el);
  }
}

function setRoleStatus(agentId, status) {
  state.roleStatus.set(agentId, status);
  const el = $(`.role-card[data-agent="${agentId}"]`);
  if (!el) return;
  el.classList.toggle('speaking', status === 'speaking');
  el.classList.toggle('done', status === 'done');
  el.classList.toggle('absent', status === 'absent');
  const s = $('.role-status', el);
  if (s) s.textContent = { speaking: '发言中', done: '已发言', absent: '缺席' }[status] || '';
  if (status !== 'speaking') {
    // 同一角色可能多轮发言，结束后回到 idle 以便下次再高亮
    setTimeout(() => {
      if (state.roleStatus.get(agentId) !== 'speaking') el.classList.remove('speaking');
    }, 260);
  }
}

function resetArena() {
  $('#timeline').innerHTML = '';
  state.msgEls.clear();
  state.msgSeq = 0;
  state.roleStatus.clear();
  $$('.role-card').forEach((c) => {
    c.classList.remove('speaking', 'done', 'absent');
    const s = $('.role-status', c);
    if (s) s.textContent = '';
  });
  $$('.stage-item').forEach((c) => c.classList.remove('active', 'done'));
  state.stageEls.forEach((el) => {
    const t = $('.si-time', el);
    if (t) t.textContent = '';
  });
  $('#side-evidence').innerHTML = '<p class="muted pad">正在检索证据…</p>';
  $('#side-contentions').innerHTML = '<p class="muted pad">辩论结束后由主持人汇总生成。</p>';
  $('#arena-title').textContent = '辩论进行中';
  $('#live-dot').className = 'live-dot on';
  state.partialScorecard = null;
  state.partialContentions = null;
  state.partialProtocol = null;
  state.session = null;
}

function addStageDivider(label) {
  const tl = $('#timeline');
  const d = document.createElement('div');
  d.className = 'stage-divider';
  d.textContent = label;
  tl.appendChild(d);
  scrollIfFollow();
}

function addNotice(message, level) {
  const tl = $('#timeline');
  const d = document.createElement('div');
  d.className = `notice-banner${level === 'error' ? ' error' : level === 'info' ? ' info' : ''}`;
  d.textContent = message;
  tl.appendChild(d);
  scrollIfFollow();
}

function createMessage(evt) {
  const tl = $('#timeline');
  const card = document.createElement('div');
  card.className = 'msg typing';
  const index = String(++state.msgSeq).padStart(2, '0');
  card.innerHTML = `
    <span class="msg-index">${index}</span>
    <div class="msg-head">
      <span class="msg-who" style="color:${esc(evt.color || '#334155')}">${esc(evt.agentName)}</span>
      ${evt.round ? `<span class="msg-tag round">第 ${evt.round} 轮</span>` : ''}
      <span class="msg-tag">${esc(stageName(evt.stage))}</span>
      <span class="msg-time"></span>
    </div>
    <div class="msg-body"></div>`;
  tl.appendChild(card);
  state.msgEls.set(evt.messageId, {
    card,
    body: $('.msg-body', card),
    text: '',
    reasoning: '',
  });
  scrollIfFollow();
}

function stageName(id) {
  const found = (state.health?.stages || []).find((s) => s.id === id);
  return found ? found.name : id;
}

function appendDelta(evt) {
  const rec = state.msgEls.get(evt.messageId);
  if (!rec) return;
  if (evt.kind === 'content') {
    rec.text += evt.text;
    rec.body.textContent = rec.text;
  } else {
    rec.reasoning += evt.text;
  }
  scrollIfFollow();
}

function finalizeMessage(msg) {
  const rec = state.msgEls.get(msg.id);
  const tl = $('#timeline');
  if (!rec) {
    // 例如从断线重放里拿到的、之前没建过 DOM 的消息
    const card = document.createElement('div');
    card.className = 'msg';
    tl.appendChild(card);
    state.msgEls.set(msg.id, { card, body: document.createElement('div'), text: msg.content, reasoning: '' });
    card.innerHTML = `
      <span class="msg-index">${String(++state.msgSeq).padStart(2, '0')}</span>
      <div class="msg-head">
        <span class="msg-who" style="color:${esc(msg.color || '#334155')}">${esc(msg.agentName)}</span>
        ${msg.round ? `<span class="msg-tag round">第 ${msg.round} 轮</span>` : ''}
        <span class="msg-tag">${esc(stageName(msg.stage))}</span>
        <span class="msg-time">${((msg.elapsedMs || 0) / 1000).toFixed(1)}s</span>
      </div>
      <div class="msg-body"></div>`;
    $('.msg-body', card).innerHTML = highlight(msg.content);
    if (msg.absent) setRoleStatus(msg.agentId, 'absent');
    else setRoleStatus(msg.agentId, 'done');
    return;
  }

  rec.card.classList.remove('typing');
  const finalText = rec.text || msg.content;

  // S4 / S5 的输出是 JSON。直接把 JSON 铺在时间轴上没法读，
  // 这里就地渲染成评分卡和摘要——但保留原始 JSON 的折叠入口，方便核对。
  const rendered = renderStructured(rec, msg, finalText);
  if (!rendered) rec.body.innerHTML = highlight(finalText);

  const t = $('.msg-time', rec.card);
  if (t) t.textContent = `${((msg.elapsedMs || 0) / 1000).toFixed(1)}s`;

  if (msg.absent) {
    const tag = document.createElement('span');
    tag.className = 'msg-tag absent';
    tag.textContent = '缺席';
    $('.msg-head', rec.card).insertBefore(tag, t);
    setRoleStatus(msg.agentId, 'absent');
  } else {
    setRoleStatus(msg.agentId, 'done');
  }

  if (rec.reasoning.trim()) {
    const btn = document.createElement('button');
    btn.className = 'reasoning-toggle';
    btn.textContent = '查看推理过程';
    const box = document.createElement('div');
    box.className = 'reasoning-box';
    box.hidden = true;
    box.textContent = rec.reasoning;
    btn.addEventListener('click', () => {
      box.hidden = !box.hidden;
      btn.textContent = box.hidden ? '查看推理过程' : '收起推理过程';
    });
    rec.card.appendChild(btn);
    rec.card.appendChild(box);
  }
  scrollIfFollow();
}

function scrollIfFollow() {
  if (!state.follow) return;
  const tl = $('#timeline');
  tl.scrollTop = tl.scrollHeight;
}

/** 从模型输出里稳健地取 JSON（与后端 extractJson 同思路的简化版） */
function parseJsonLoose(text) {
  if (!text) return null;
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;
  const unfenced = text.replace(/```(?:json)?/g, '').trim();
  const f = tryParse(unfenced);
  if (f !== undefined) return f;
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const c = tryParse(unfenced.slice(start, end + 1));
    if (c !== undefined) return c;
  }
  return null;
}

/**
 * 把 S4 评分卡 / S5 主持人输出渲染成可读形态。
 * 返回 true 表示已经接管渲染。
 */
function renderStructured(rec, msg, text) {
  if (msg.stage === 'S4') {
    const rawCard = parseJsonLoose(text);
    if (!rawCard || typeof rawCard !== 'object' || !('novelty' in rawCard)) return false;
    const card = rawCard.version === 2 || rawCard.assessments ? normalizeScorecard(rawCard) : rawCard;
    const rubric = state.health?.rubric || [];
    const rows = rubric
      .map((d) => {
        const v = validScore(card[d.key]);
        return `<div class="score-row">
          <div class="score-label">${esc(d.label)}</div>
          <div class="score-weight">权重 ${d.weight * 100}%</div>
          <div class="score-bar"><span style="width:${((v || 0) / 5) * 100}%"></span></div>
          <div class="score-val">${v ?? '待评估'}</div>
        </div>`;
      })
      .join('');
    const total = card.version === 2 ? card.total : computeTotal(card);
    rec.body.innerHTML = `
      <div class="score-total" style="padding:10px 14px">
        <span class="st-num" style="font-size:24px">${total ?? '待评估'}</span>
        <span class="st-label">综合初评（满分 5）</span>
      </div>
      <p class="muted">${esc(scorecardNotice(card))}</p>
      ${card.version === 2 ? `<p>创新潜力：${card.innovationTotal ?? '待评估'} / 5</p>` : ''}
      <div class="score-grid">${rows}</div>
      ${renderAssessmentReasons(card, rubric)}
      ${card.comments ? `<p style="margin:10px 0 0;color:var(--ink-2)">${esc(card.comments)}</p>` : ''}
      ${
        card.suggestions?.length
          ? `<ol style="margin:10px 0 0;padding-left:20px;color:var(--ink-2);line-height:1.8">${card.suggestions
              .map((s) => `<li>${esc(s)}</li>`)
              .join('')}</ol>`
          : ''
      }`;
    attachRawToggle(rec, text);
    return true;
  }

  if (msg.stage === 'S5') {
    const parsed = parseJsonLoose(text);
    if (!parsed || typeof parsed !== 'object') return false;
    const contentions = Array.isArray(parsed.contentions) ? parsed.contentions : [];
    const changes = Array.isArray(parsed.changeLog) ? parsed.changeLog : [];
    const byLevel = contentions.reduce((acc, c) => {
      const k = LEVEL_CN[c.level] || c.level || '其他';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    rec.body.innerHTML = `
      ${parsed.summary ? `<p style="margin:0 0 12px">${highlight(String(parsed.summary))}</p>` : ''}
      <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
        ${Object.entries(byLevel)
          .map(
            ([k, v]) => `<div class="stat-card"><div class="sc-num">${v}</div><div class="sc-label">${esc(k)}争议</div></div>`,
          )
          .join('')}
        <div class="stat-card"><div class="sc-num">${changes.length}</div><div class="sc-label">修改对照条目</div></div>
      </div>
      <p class="muted" style="margin-top:10px">
        完整产出（争议清单 / 评分卡 / 修改对照表 / 修正版方案）已生成，点顶部「评审产出」查看。
      </p>`;
    attachRawToggle(rec, text);
    return true;
  }

  return false;
}

function attachRawToggle(rec, text) {
  const btn = document.createElement('button');
  btn.className = 'reasoning-toggle';
  btn.textContent = '查看模型原始输出';
  const box = document.createElement('div');
  box.className = 'reasoning-box';
  box.hidden = true;
  box.textContent = text;
  btn.addEventListener('click', () => {
    box.hidden = !box.hidden;
    btn.textContent = box.hidden ? '查看模型原始输出' : '收起模型原始输出';
  });
  rec.card.appendChild(btn);
  rec.card.appendChild(box);
}

function renderHypothesisCard(h) {
  const tl = $('#timeline');
  const d = document.createElement('div');
  d.className = 'card-block';
  d.style.marginBottom = '18px';
  d.innerHTML = `
    <h3>假设卡</h3>
    <table class="data-table">
      <tr><th style="width:110px">研究对象</th><td>${esc(h.subject)}</td></tr>
      <tr><th>干预 / 暴露</th><td>${esc(h.intervention)}</td></tr>
      <tr><th>中介变量</th><td>${esc(h.mediator || '（未指定）')}</td></tr>
      <tr><th>结局指标</th><td>${esc(h.outcome)}</td></tr>
      <tr><th>目标人群</th><td>${esc(h.population)}</td></tr>
      <tr><th>研究类型</th><td>${esc(h.studyType)}</td></tr>
    </table>
    ${h.focus ? `<div class="focus-callout"><b>本轮焦点</b><p>${esc(h.focus)}</p></div>` : ''}
    ${h.userFacts?.length ? `<details class="material-details"><summary>用户已提供材料 · ${h.userFacts.length} 条原文摘录</summary>${h.userFacts.map(f=>`<p><span class="mono">${esc(f.id)}</span> ${esc(f.quote)}</p>`).join('')}</details>` : ''}
    ${h.ambiguities?.length ? `<details class="material-details"><summary>待澄清与待核查 · ${h.ambiguities.length} 项</summary><ul>${h.ambiguities.map(a=>`<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}`;
  tl.appendChild(d);
  scrollIfFollow();
}

/* ------------------------------ 证据 / 争议 ------------------------------ */

function evidenceAuditHtml(rag) {
  if (!rag?.attempts?.length && !rag?.excludedRecords?.length) return '';
  return `<details class="material-details"><summary>查看检索过程与未采用条目</summary>
    ${(rag.attempts || []).map(a=>`<p><span class="mono">${esc(a.query)}</span><br>命中 ${a.total || 0} 条 · 保留 ${a.accepted || 0} 条${a.error ? ` · ${esc(a.error)}` : ''}</p>`).join('')}
    ${(rag.excludedRecords || []).map(r=>`<p><b>${/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/?$/.test(r.url || '') ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.pmid)}</a>` : esc(r.title || r.pmid)}</b><br>${esc(r.reason)}</p>`).join('')}</details>`;
}

function renderEvidence(items, coverage, disclaimer, rag) {
  const box = $('#side-evidence');
  if (!items?.length) {
    box.innerHTML = '<p class="muted pad">本次未检索到可用证据。</p>';
    return;
  }
  const realCount = items.filter((e) => e.modelKnowledge === false).length;
  box.innerHTML =
    (disclaimer ? `<div class="notice-banner" style="margin-bottom:10px">${esc(disclaimer)}</div>` : '') +
    (coverage ? `<p class="muted" style="margin:0 0 10px">${esc(coverage)}</p>` : '') +
    evidenceAuditHtml(rag) +
    items
      .map((e) => {
        const isReal = e.modelKnowledge === false;
        // 真实检索的卡带 PMID，做成可点开的链接——这是"可溯源"最直接的证据
        const src = isReal && e.url
          ? `<a class="ei-src ei-link" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.sourceRef)} ↗</a>`
          : `<div class="ei-src">${esc(e.sourceRef)}</div>`;
        return `
      <div class="evidence-item${isReal ? ' evidence-real' : ''}">
        <div class="ei-head">
          <span class="ei-id">${esc(e.id)}</span>
          <span class="ei-type">${esc(e.sourceType)}</span>
          <span class="ei-type">${isReal ? `关联：${({direct:'直接',indirect:'间接',background:'背景',irrelevant:'不相关'})[e.relevanceLevel] || '待核查'}` : '未核验概述'}</span>
          ${isReal ? '<span class="ei-verified">可查原文</span>' : ''}
        </div>
        <div class="ei-sum">${esc(e.summary)}</div>
        <div class="ei-rel">与假设的关联：${esc(e.relevance)}</div>
        ${src}
      </div>`;
      })
      .join('');
}

function renderContentions(contentions, coverage) {
  const box = $('#side-contentions');
  if (!contentions?.length) {
    box.innerHTML = '<p class="muted pad">未生成争议清单。</p>';
    return;
  }
  const sorted = [...contentions].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  box.innerHTML =
    (coverage
      ? `<div class="notice-banner" style="margin-bottom:10px ${
          coverage.ratio >= 1 ? ';background:#ecfdf3;color:#067647;border-color:#abefc6' : ''
        }">关键建议回应 ${coverage.covered}/${coverage.total}${
          coverage.uncovered?.length ? `，未覆盖：${esc(coverage.uncovered.join(', '))}` : '（文本对应，不代表问题已解决）'
        }</div>`
      : '') +
    sorted
      .map(
        (c) => `
      <div class="contention-item lv-${c.level.replace(' ', '')}">
        <div class="ci-head">
          <span class="ci-id">${esc(c.id)}</span>
          <span class="badge lv-${c.level.replace(' ', '')}">${LEVEL_CN[c.level] || c.level}</span>
        </div>
        <div class="ci-title">${esc(c.title)}</div>
        ${c.suggestion ? `<div class="ci-sug">建议：${esc(c.suggestion)}</div>` : ''}
      </div>`,
      )
      .join('');
  // 有争议时自动切到争议标签页
  const tab = $('.sidetab[data-side="contentions"]');
  if (tab) tab.click();
}

/* ------------------------------ 产出视图 ------------------------------ */

function renderArena(session) {
  resetArena();
  renderHypothesisCard(session.hypothesis || {});
  renderEvidence(session.evidence, session.evidenceCoverage, '来源可回看，内容与适用性仍需核查。', session.rag);
  renderContentions(session.contentions, session.coverage);
  for (const m of session.messages) {
    createMessage({ messageId: m.id, agentId: m.agentId, agentName: m.agentName, color: m.color, stage: m.stage, round: m.round });
    const rec = state.msgEls.get(m.id);
    if (rec) {
      rec.text = m.content;
      finalizeMessage(m);
    }
  }
  session.stages?.forEach((st) => {
    const el = state.stageEls.get(st.id);
    if (el) {
      el.classList.add('done');
      const t = $('.si-time', el);
      if (t) t.textContent = `${((st.elapsedMs || 0) / 1000).toFixed(1)}s`;
    }
  });
  $('#arena-title').textContent = '历史会话';
  $('#live-dot').className = 'live-dot';
}

function renderReport(session) {
  if (!session) return;
  const h = session.hypothesis || {};
  $('#report-title').textContent = h.focus || /【(?:本轮唯一焦点|本轮焦点)】\s*([^\n]+)/.exec(session.rawText || '')?.[1] || h.name || session.rawText?.slice(0, 30) || '评审产出';
  const rounds = session.messages?.filter((m) => m.stage === 'S2').length
    ? Math.max(...session.messages.filter((m) => m.stage === 'S2').map((m) => m.round))
    : 0;
  $('#report-sub').textContent = `${fmtTime(session.createdAt)} · 交叉质疑 ${rounds} 轮 · ${session.messages?.length || 0} 条发言 · 总用时 ${(
    (session.totalElapsedMs || 0) / 1000
  ).toFixed(1)}s`;

  $('#btn-md').href = `/api/sessions/${session.id}/report.md`;
  $('#btn-html').href = `/api/sessions/${session.id}/report.html`;
  $('#btn-docx').href = `/api/sessions/${session.id}/report.docx`;

  renderSummaryPane(session);
  renderContentionsPane(session);
  renderScorecardPane(session);
  renderChangeLogPane(session);
  renderProtocolPane(session);
  renderTranscriptPane(session);
}

/** 免责声明按「这次到底有没有真实检索」动态生成——不能永远写死"未接入检索" */
function disclaimerBar(s = {}) {
  const real = (s.evidence || []).filter((e) => e.modelKnowledge === false).length;
  const total = (s.evidence || []).length;
  const ragLine = real
    ? `其中 ${real}/${total} 条证据来自 PubMed 真实检索（附 PMID，可点开核对原文），其余来自模型知识并已逐条标注。`
    : '本次未取得真实文献检索结果，全部证据来自模型知识，已逐条标注【模型知识】。';
  return `<div class="review-scope"><b>模型预评审 · 待复核</b>
    <p>文献来源 ${real} 条 · 模型概述 ${total - real} 条。来源存在不等于结论正确。</p>
    <details><summary>适用范围与来源说明</summary><p>本内容为科研方案辅助建议，不替代导师指导、伦理审查与临床决策。${ragLine} 输入材料与模型建议都需复核。</p></details></div>`;
}

function materialContextHtml(s) {
  const h = s.hypothesis || {};
  const focus = h.focus || /【(?:本轮唯一焦点|本轮焦点)】\s*([^\n]+)/.exec(s.rawText || '')?.[1];
  return `<div class="card-block material-context">
    <div class="section-eyebrow">本轮材料与证据</div>
    ${focus ? `<div class="focus-callout"><b>本轮焦点</b><p>${esc(focus)}</p></div>` : ''}
    <p class="muted">${s.reviewVersion >= 3 ? '原文锚点只核对文字出处，不代表科学判断已被验证。' : '历史会话保留原始输出，尚未按新版原文锚点规则处理。'}</p>
    ${h.userFacts?.length ? `<details class="material-details"><summary>已提供材料 · ${h.userFacts.length} 条原文摘录</summary>${h.userFacts.map(f=>`<p><span class="mono">${esc(f.id)}</span> ${esc(f.quote)}</p>`).join('')}</details>` : ''}
    <details class="material-details"><summary>查看原始输入</summary><div class="raw-input">${esc(s.rawText || '')}</div></details>
    ${evidenceAuditHtml(s.rag)}
    <p class="muted">${esc(s.evidenceCoverage || '')}</p>
  </div>`;
}

function renderSummaryPane(s) {
  const st = s.inferenceStats || {};
  const coverage = s.coverage;
  $('#report-panes .pane[data-pane="summary"]').innerHTML = `
    ${disclaimerBar(s)}
    ${materialContextHtml(s)}
    <div class="card-block">
      <h3>假设卡</h3>
      <table class="data-table">
        <tr><th style="width:110px">研究对象</th><td>${esc(s.hypothesis?.subject)}</td></tr>
        <tr><th>干预 / 暴露</th><td>${esc(s.hypothesis?.intervention)}</td></tr>
        <tr><th>中介变量</th><td>${esc(s.hypothesis?.mediator || '（未指定）')}</td></tr>
        <tr><th>结局指标</th><td>${esc(s.hypothesis?.outcome)}</td></tr>
        <tr><th>目标人群</th><td>${esc(s.hypothesis?.population)}</td></tr>
        <tr><th>研究类型</th><td>${esc(s.hypothesis?.studyType)}</td></tr>
      </table>
      ${s.hypothesis?.ambiguities?.length ? `<details class="material-details"><summary>待澄清与待核查 · ${s.hypothesis.ambiguities.length} 项</summary><ul>${s.hypothesis.ambiguities.map(a=>`<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}
    </div>

    ${
      coverage
        ? `<div class="coverage-bar ${coverage.ratio >= 1 ? 'ok' : 'bad'}">
            关键建议回应：<strong>${coverage.covered} / ${coverage.total}</strong>
            ${coverage.uncovered?.length ? `— 未覆盖：${esc(coverage.uncovered.join(', '))}` : '— 已有文本对应，科学问题仍需核查'}
          </div>`
        : ''
    }

    <div class="card-block">
      <h3>主持人总结 <span class="review-badge">模型建议 · 待复核</span></h3>
      <div style="white-space:pre-wrap;line-height:1.85">${highlight(s.summary || '—')}</div>
    </div>

    <div class="card-block">
      <h3>诚实披露</h3>
      <div class="stat-grid">
        <div class="stat-card"><div class="sc-num">${st.evidenceCount ?? 0}</div><div class="sc-label">证据卡（其中 ${st.retrievedCount ?? 0} 条真实检索）</div></div>
        <div class="stat-card"><div class="sc-num">${st.citationMarks ?? 0}</div><div class="sc-label">证据引用标注次数</div></div>
        <div class="stat-card"><div class="sc-num">${st.knowledgeMarks ?? 0}</div><div class="sc-label">【模型知识】标注</div></div>
        <div class="stat-card"><div class="sc-num">${st.inferenceMarks ?? 0}</div><div class="sc-label">【推断】标注</div></div>
      </div>
      <p class="muted" style="margin-top:12px">
        本系统强制要求：没有真实文献来源的论断必须标注为【模型知识】或【推断】。
        上表即为该机制的统计结果——它让"哪些是模型说的"变得可核查，而不是藏在流畅的文字里。
      </p>
    </div>`;
}

function renderContentionsPane(s) {
  const list = [...(s.contentions || [])].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const body = list.length
    ? `<table class="data-table contentions-table">
        <thead><tr><th class="contention-number">编号</th><th>争议点</th><th style="width:82px">等级</th><th style="width:150px">提出者</th><th>建议修改</th></tr></thead>
        <tbody>${list
          .map(
            (c) => `<tr class="row-${c.level.replace(' ', '')}">
              <td class="mono contention-number">${esc(c.id)}</td>
              <td>${esc(c.title)}</td>
              <td><span class="badge lv-${c.level.replace(' ', '')}">${LEVEL_CN[c.level] || c.level}</span></td>
              <td class="muted">${esc((c.raisedBy || []).join('、') || '—')}</td>
              <td>${esc(c.suggestion || '—')}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : '<p class="muted">未生成争议清单。</p>';
  $('#report-panes .pane[data-pane="contentions"]').innerHTML = `<div class="card-block"><p class="muted">以下为模型提出的争议与建议，等级不等于已确认缺陷。</p><div class="table-scroll">${body}</div></div>`;
}

function renderAssessmentReasons(card, dims) {
  return card.version === 2 ? `<div class="assessment-list">${dims.map(d => `<details class="material-details"><summary>${esc(d.label)} · ${card.assessments?.[d.key]?.status === 'scored' ? '查看评分依据' : '查看待补信息'}</summary><p>${esc(assessmentText(card, d.key))}</p></details>`).join('')}</div>` : '';
}

function renderScorecardPane(s) {
  const card = s.scorecard;
  const dims = state.health?.rubric || [];
  if (!card) {
    $('#report-panes .pane[data-pane="scorecard"]').innerHTML = '<div class="card-block"><p class="muted">未生成评分卡。</p></div>';
    return;
  }
  const rows = dims
    .map((d) => {
      const v = validScore(card[d.key]);
      return `<div class="score-row">
        <div class="score-label">${esc(d.label)}</div>
        <div class="score-weight">权重 ${d.weight * 100}%</div>
        <div class="score-bar"><span style="width:${((v || 0) / 5) * 100}%"></span></div>
        <div class="score-val">${v ?? '待评估'}</div>
      </div>`;
    })
    .join('');

  $('#report-panes .pane[data-pane="scorecard"]').innerHTML = `
    <div class="card-block">
      <h3>研究潜力初评</h3>
      <div class="score-total">
        <span class="st-num">${validScore(card.total) ?? '待评估'}</span>
        <span class="st-label">${card.version === 2 ? '综合初评' : '旧版加权总分'}（满分 5）</span>
      </div>
      <p class="muted">${esc(scorecardNotice(card))}</p>
      ${card.version === 2 ? `<p>创新潜力：${validScore(card.innovationTotal) ?? '待评估'} / 5（新颖性与增量贡献）</p>` : ''}
      <div class="score-grid">${rows}</div>
      ${renderAssessmentReasons(card, dims)}
      ${card.comments ? `<p style="line-height:1.85;color:var(--ink-2)">${esc(card.comments)}</p>` : ''}
      ${
        card.suggestions?.length
          ? `<h3 style="margin-top:18px">提升路径</h3><ol style="line-height:1.9;color:var(--ink-2);padding-left:20px">${card.suggestions
              .map((x) => `<li>${esc(x)}</li>`)
              .join('')}</ol>`
          : ''
      }
    </div>`;
}

function renderChangeLogPane(s) {
  const list = s.changeLog || [];
  const body = list.length
    ? `<table class="data-table">
        <thead><tr><th style="width:20%">原方案要素</th><th style="width:10%">对应争议</th><th style="width:34%">修改后设计</th><th>修改理由</th></tr></thead>
        <tbody>${list
          .map(
            (l) => `<tr>
              <td><span class="review-badge">${l.originAnchored ? '有输入原文锚点' : s.reviewVersion >= 3 ? '输入未明确 · 待核查' : '历史记录 · 未核对锚点'}</span><p>${esc(l.originElement)}</p></td>
              <td class="mono">${esc(l.contention)}</td>
              <td>${esc(l.revisedElement)}</td>
              <td class="muted">${esc(l.rationale)}</td>
            </tr>`,
          )
          .join('')}</tbody>
      </table>`
    : '<p class="muted">未生成修改对照表。</p>';
  $('#report-panes .pane[data-pane="changelog"]').innerHTML = `<div class="card-block"><h3>修改建议对照</h3><p class="muted">以下是建议，不表示研究已修改。原文锚点核对出处；没有锚点的判断需要回到材料中确认。</p><div class="table-scroll">${body}</div></div>`;
}

function renderProtocolPane(s) {
  $('#report-panes .pane[data-pane="protocol"]').innerHTML = `
    <div class="card-block">
      <h3>修正版研究方案</h3>
      <div class="protocol-body">${esc(s.revisedProtocol || '未生成')}</div>
    </div>`;
}

function renderTranscriptPane(s) {
  const groups = new Map();
  for (const m of s.messages || []) {
    if (!groups.has(m.stage)) groups.set(m.stage, []);
    groups.get(m.stage).push(m);
  }
  const order = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
  const html = order
    .filter((k) => groups.has(k))
    .map((k) => {
      const msgs = groups.get(k);
      return `<div class="card-block">
        <h3>${esc(k)} ${esc(stageName(k))}</h3>
        ${msgs
          .map(
            (m) => `<div class="msg" style="border-left-color:${esc(m.color || '#cbd5e1')}">
              <div class="msg-head">
                <span class="msg-who" style="color:${esc(m.color || '#334155')}">${esc(m.agentName)}</span>
                ${m.round ? `<span class="msg-tag round">第 ${m.round} 轮</span>` : ''}
                ${m.absent ? '<span class="msg-tag absent">缺席</span>' : ''}
                <span class="msg-time">${((m.elapsedMs || 0) / 1000).toFixed(1)}s</span>
              </div>
              <div class="msg-body">${highlight(m.content)}</div>
            </div>`,
          )
          .join('')}
      </div>`;
    })
    .join('');
  $('#report-panes .pane[data-pane="transcript"]').innerHTML = html || '<div class="card-block"><p class="muted">无记录。</p></div>';
}

/* ------------------------------ 后端状态 ------------------------------ */

function showHealth() {
  const h = state.health;
  if (!h) return;
  const body = $('#modal-body');
  body.innerHTML = `
    <dl>
      <dt>当前后端</dt><dd><code>${esc(h.provider)}</code> — ${esc(h.providerLabel)}</dd>
      <dt>可用后端</dt><dd>${esc((h.providers || []).join(' / '))}</dd>
      <dt>DeepSeek Key</dt><dd>${h.deepseekReady ? '已配置 ✓' : '未配置 ✗'}</dd>
      <dt>Dify App Key</dt><dd>${h.difyReady ? '已配置 ✓' : '未配置（导入 DSL 后把 app-xxxx 填进 .env）'}</dd>
      <dt>默认交叉质疑轮数</dt><dd>${h.crossRounds}</dd>
      <dt>阶段</dt><dd>${(h.stages || []).map((s) => `${esc(s.id)} ${esc(s.name)}`).join(' → ')}</dd>
    </dl>

    <div style="margin-top:18px;display:flex;gap:8px;flex-wrap:wrap">
      <button class="ghost-btn small" id="btn-dify-test">Dify 连接自检（不消耗 token）</button>
      <button class="ghost-btn small" id="btn-dify-run">自检 + 试跑一次</button>
    </div>
    <div id="dify-test-result" style="margin-top:12px"></div>

    <div class="disclaimer-bar" style="margin-top:18px">${esc(h.disclaimer || '')}</div>
    <p class="muted">改 .env 后需重启服务生效。</p>`;

  const run = async (dryRun) => {
    const box = $('#dify-test-result');
    box.innerHTML = '<p class="muted">正在自检…</p>';
    try {
      const r = await api(`/api/dify/selftest${dryRun ? '' : '?run=1'}`);
      box.innerHTML = `
        <div class="notice-banner" style="${r.ok ? 'background:#ecfdf3;color:#067647;border-color:#abefc6' : ''}">
          ${r.ok ? '✓ 连接正常' : '✗ 连接失败'}
        </div>
        <table class="data-table" style="font-size:12.5px">
          <thead><tr><th style="width:150px">检查项</th><th style="width:60px">结果</th><th>详情</th></tr></thead>
          <tbody>${(r.steps || [])
            .map(
              (s) =>
                `<tr><td>${esc(s.name)}</td><td>${s.ok ? '✓' : '✗'}</td><td class="muted">${esc(s.detail || '')}</td></tr>`,
            )
            .join('')}</tbody>
        </table>
        ${r.hint ? `<p style="margin-top:10px"><strong>下一步：</strong>${esc(r.hint)}</p>` : ''}`;
    } catch (err) {
      box.innerHTML = `<div class="notice-banner error">自检请求失败：${esc(err.message)}</div>`;
    }
  };

  $('#btn-dify-test').addEventListener('click', () => run(true));
  $('#btn-dify-run').addEventListener('click', () => run(false));

  $('#modal').hidden = false;
}

/* ------------------------------ 启动 ------------------------------ */

init();
