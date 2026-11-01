let active = null;
let health = {};
export function getModelSettings(provider) {
  return active?.provider === provider && provider !== 'mock' ? { apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model } : undefined;
}
export async function initModelSettings(info) {
  health = info || {};
  const dialog = document.querySelector('#model-settings');
  const form = document.querySelector('#model-settings-form');
  const status = document.querySelector('#settings-status');
  const remember = document.querySelector('#settings-remember');
  let canSave = false;
  try {
    if (window.scienceArena) {
      const result = await window.scienceArena.loadSettings();
      active = result.settings;
      canSave = result.canSave;
    }
  } catch { status.textContent = '无法读取已保存设置，请重新输入。'; }
  document.querySelector('#settings-storage').hidden = !window.scienceArena;
  remember.disabled = !canSave;
  remember.checked = canSave;
  document.querySelector('#settings-privacy').textContent = window.scienceArena
    ? '研究记录保存在本机；研究内容会发送至你选择的模型服务。勾选保存时，模型配置由系统安全存储加密。'
    : '密钥仅在当前页面内存中使用，刷新后需重新输入。运行时会经本站后端转交模型服务；研究记录保存在本站，当前浏览器通过专属凭证访问。清除浏览器数据会失去访问入口。';
  const input = name => form.elements.namedItem(name);
  function display() {
    status.textContent = '';
    const provider = input('provider').value;
    const mock = provider === 'mock';
    document.querySelectorAll('[data-model-field]').forEach(el => { el.hidden = mock; });
    document.querySelector('#settings-model-field').hidden = provider !== 'deepseek';
    input('apiKey').required = !mock;
    input('baseUrl').required = !mock;
    const baseline = provider === 'dify' ? health.difyAllowedUrl || '' : 'https://api.deepseek.com';
    input('baseUrl').value = active?.provider === provider ? active.baseUrl : baseline;
    input('apiKey').value = active?.provider === provider ? active.apiKey : '';
    input('model').value = active?.provider === provider ? active.model : 'deepseek-flash';
  }
  function reflect() {
    if (active) {
      document.querySelector('#provider-select').value = active.provider;
      document.querySelector('#provider-pill').textContent = active.provider === 'mock' ? '离线演示' : '使用本人的 API';
    }
  }
  function open() {
    input('provider').value = active?.provider || document.querySelector('#provider-select').value || 'deepseek';
    display(); dialog.showModal();
  }
  const read = () => ({ provider: input('provider').value, apiKey: input('apiKey').value.trim(), baseUrl: input('baseUrl').value.trim(), model: input('model').value.trim() });
  form.addEventListener('input', () => { status.textContent = ''; });
  document.querySelector('#btn-settings').addEventListener('click', open);
  input('provider').addEventListener('change', display);
  document.querySelector('#settings-close').addEventListener('click', () => dialog.close());
  document.querySelector('#settings-clear').addEventListener('click', async () => {
    try {
      await window.scienceArena?.clearSettings(); active = null; display();
      document.querySelector('#provider-pill').textContent = '未设置个人 API';
      status.textContent = '个人配置已清除。';
    } catch { status.textContent = '清除失败，请重试。'; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const value = read();
      if (window.scienceArena) {
        if (remember.checked) await window.scienceArena.saveSettings(value);
        else await window.scienceArena.clearSettings();
      }
      active = value; reflect(); dialog.close();
    } catch (error) { status.textContent = error.message; }
  });
  document.querySelector('#settings-test').addEventListener('click', async event => {
    if (!form.reportValidity()) return;
    event.target.disabled = true; status.textContent = '正在测试连接…';
    const value = read();
    try {
      const response = await fetch('/api/model/test', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: value.provider, modelSettings: value }) });
      const result = await response.json();
      status.textContent = result.message || result.error || '连接失败';
    } catch { status.textContent = '连接失败，请检查网络。'; }
    finally { event.target.disabled = false; }
  });
  reflect();
  if (health.personalKeys && !active) open();
}

if ('serviceWorker' in navigator && !window.scienceArena) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
