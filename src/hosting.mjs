import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.mjs';

const buckets = new Map();
const quota = Math.max(1, Number(process.env.ARENA_HOURLY_LIMIT) || 12);
export const publicMode = config.mode === 'public';
const desktopToken = process.env.ARENA_DESKTOP_TOKEN || '';
const hash = text => createHash('sha256').update(text).digest('hex');
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1);

export function guardRequest(req, res, url) {
  const expected = process.env.ARENA_PUBLIC_ORIGIN || `http://${req.headers.host}`;
  // Host validation also prevents DNS rebinding against the desktop loopback service.
  if (!publicMode && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && config.host === '127.0.0.1') {
    return { error: '不允许的访问地址', status: 403 };
  }
  if (desktopToken) {
    if (url.pathname === '/desktop-entry' && url.searchParams.get('token') === desktopToken) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': `arena_desktop=${desktopToken}; HttpOnly; SameSite=Strict; Path=/` });
      res.end();
      return { handled: true };
    }
    if (cookieValue(req, 'arena_desktop') !== desktopToken) return { error: '请从桌面应用打开', status: 403 };
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    if (req.headers.origin && req.headers.origin !== expected) return { error: '不允许跨站请求', status: 403 };
    if (req.headers['sec-fetch-site'] === 'cross-site') return { error: '不允许跨站请求', status: 403 };
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return { error: '需要 JSON 请求', status: 415 };
  }
  if (!publicMode) return { owner: 'local' };
  let token = cookieValue(req, 'arena_visitor');
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = randomBytes(32).toString('hex');
    const secure = expected.startsWith('https:') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `arena_visitor=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
  }
  return { owner: hash(token) };
}

export function consumeQuota(req) {
  // Only trust the actual socket peer; forwarded headers are user-controlled unless a proxy is configured.
  const key = req.socket.remoteAddress;
  const now = Date.now();
  for (const [id, b] of buckets) if (now - b.start > 3600000) buckets.delete(id);
  const bucket = buckets.get(key) || { start: now, count: 0 };
  if (bucket.count >= quota || (!buckets.has(key) && buckets.size >= 10000)) return false;
  bucket.count++;
  buckets.set(key, bucket);
  return true;
}

export function modelOverrides(input, providerName) {
  const source = input && typeof input === 'object' ? input : {};
  if (providerName === 'mock') return {};
  if (!input && !publicMode && config.mode !== 'desktop') return {};
  const apiKey = String(source.apiKey || '').trim();
  if (!apiKey || apiKey.length > 4096) throw new Error('请先在「模型设置」填写本人的 API Key。');
  if (providerName === 'deepseek') {
    const baseUrl = checkedUrl(source.baseUrl || 'https://api.deepseek.com');
    if (publicMode && baseUrl !== 'https://api.deepseek.com') throw new Error('公网版只允许 DeepSeek 官方地址；自定义地址请使用桌面版。');
    const model = String(source.model || config.deepseek.model).trim();
    if (!model || model.length > 150) throw new Error('模型名称无效');
    return { deepseek: { ...config.deepseek, apiKey, baseUrl, model } };
  }
  if (providerName === 'dify') {
    const baseUrl = checkedUrl(source.baseUrl);
    if (publicMode && (!process.env.ARENA_DIFY_ALLOWED_URL || baseUrl !== checkedUrl(process.env.ARENA_DIFY_ALLOWED_URL))) {
      throw new Error('该站点尚未开放此 Dify 地址，请使用桌面版或联系部署者。');
    }
    return { dify: { baseUrl, appKey: apiKey, pinIp: '' } };
  }
  throw new Error('未知模型后端');
}

function checkedUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址格式无效');
  if (publicMode && url.protocol !== 'https:') throw new Error('公网模型地址必须使用 HTTPS');
  return url.href.replace(/\/+$/, '');
}
