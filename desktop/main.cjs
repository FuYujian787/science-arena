const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell } = require('electron');
const { fork } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

let child;
let window;
let baseUrl;
const smoke = process.env.ARENA_DESKTOP_SMOKE === '1';
if (process.env.ARENA_DESKTOP_TEST_DIR) app.setPath('userData', process.env.ARENA_DESKTOP_TEST_DIR);
const settingsFile = () => path.join(app.getPath('userData'), 'model-settings.encrypted');
const root = path.resolve(__dirname, '..');

function trusted(event) {
  if (!window || event.sender !== window.webContents || new URL(event.senderFrame.url).origin !== baseUrl) throw new Error('不允许访问桌面设置');
}
async function encryptionAvailable() {
  return await safeStorage.isAsyncEncryptionAvailable();
}
function cleanSettings(value) {
  if (!value || !['deepseek', 'dify', 'mock'].includes(value.provider)) throw new Error('模型配置格式无效');
  const out = {};
  for (const key of ['provider', 'apiKey', 'baseUrl', 'model']) out[key] = String(value[key] || '').slice(0, key === 'apiKey' ? 4096 : 1024);
  return out;
}
async function saveEncrypted(value) {
  if (!await encryptionAvailable()) throw new Error('系统安全存储不可用，请取消保存，仅本次使用。');
  const bytes = await safeStorage.encryptStringAsync(JSON.stringify(cleanSettings(value)));
  fs.writeFileSync(`${settingsFile()}.tmp`, bytes, { mode: 0o600 });
  fs.renameSync(`${settingsFile()}.tmp`, settingsFile());
}
async function readEncrypted() {
  if (!fs.existsSync(settingsFile())) return null;
  if (!await encryptionAvailable()) throw new Error('系统安全存储暂不可用，请重新输入配置。');
  const decrypted = await safeStorage.decryptStringAsync(fs.readFileSync(settingsFile()));
  return cleanSettings(JSON.parse(decrypted.result));
}

async function start() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const token = randomBytes(32).toString('hex');
  child = fork(path.join(root, 'server.mjs'), [], {
    execPath: process.execPath,
    cwd: app.getPath('userData'),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ARENA_MODE: 'desktop', ARENA_IGNORE_ENV_FILE: '1',
      ARENA_DATA_DIR: path.join(app.getPath('userData'), 'sessions'), ARENA_DESKTOP_TOKEN: token,
      PORT: '0', HOST: '127.0.0.1', LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: '', DIFY_APP_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  // Drain child pipes without writing research content or credentials to disk.
  child.stdout.resume(); child.stderr.resume();
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地服务启动超时')), 20000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`本地服务已退出 (${code})`)); });
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message.port); } });
  });
  baseUrl = `http://127.0.0.1:${port}`;
  window = new BrowserWindow({ width: 1280, height: 880, minWidth: 600, minHeight: 600,
    title: 'Science Arena', show: !smoke, backgroundColor: '#f6f7f9', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  ipcMain.handle('settings:load', async event => { trusted(event); return { settings: await readEncrypted(), canSave: await encryptionAvailable() }; });
  ipcMain.handle('settings:save', async (event, value) => { trusted(event); await saveEncrypted(value); return { ok: true }; });
  ipcMain.handle('settings:clear', event => { trusted(event); fs.rmSync(settingsFile(), { force: true }); return { ok: true }; });
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== baseUrl) event.preventDefault(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.origin === baseUrl && /^\/api\/sessions\/[\w-]+\/report\.html$/.test(target.pathname)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } } };
    }
    if (target.protocol === 'https:') shell.openExternal(url);
    return { action: 'deny' };
  });
  child.on('exit', () => { if (!app.isQuitting) { dialog.showErrorBox('Science Arena', '本地服务已停止，请重新打开应用。'); app.quit(); } });
  await window.loadURL(`${baseUrl}/desktop-entry?token=${token}`);
  if (smoke) {
    const sample = { provider: 'deepseek', apiKey: 'smoke-only-not-a-real-key', model: 'test', baseUrl: 'https://api.deepseek.com' };
    await saveEncrypted(sample);
    if ((await readEncrypted()).apiKey !== sample.apiKey || fs.readFileSync(settingsFile()).includes(sample.apiKey)) throw new Error('加密存储验证失败');
    fs.rmSync(settingsFile(), { force: true });
    console.log('DESKTOP_SMOKE_OK: window loaded; backend ready; encrypted settings roundtrip passed');
    app.quit();
  }
}
app.on('before-quit', () => { app.isQuitting = true; child?.kill(); });
app.on('window-all-closed', () => app.quit());
app.whenReady().then(start).catch(error => {
  if (!smoke) dialog.showErrorBox('Science Arena 启动失败', error.message);
  console.error(error.message); app.exit(1);
});
