/**
 * 会话持久化。
 *
 * V1 用文件存储就够：一场辩论一个 JSON，天然可归档、可 diff、可当案例库。
 * 关键是接口要收窄——只用 save / load / list / remove 四个方法，
 * 之后换 SQLite 或数据库时，调用方一行都不用改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function fileOf(id) {
  // id 由系统生成（arena_xxx），这里仍做一次白名单校验，避免路径穿越
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(config.dataDir, `${safe}.json`);
}

export function save(session) {
  ensureDir();
  session.updatedAt = new Date().toISOString();
  fs.writeFileSync(fileOf(session.id), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

export function load(id) {
  const file = fileOf(id);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function remove(id) {
  const file = fileOf(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * 服务启动时回收"上次没跑完"的会话。
 *
 * 辩论过程中会增量落盘，所以进程被杀之后磁盘上会留下 state='running' 的半成品。
 * 那场辩论已经不可能继续了（事件流在内存里），但**已经吵出来的内容是有价值的**——
 * 把它标成 interrupted 让用户能看、能导出，而不是留一个永远"进行中"的僵尸会话。
 */
export function markInterrupted() {
  ensureDir();
  const recovered = [];
  for (const file of fs.readdirSync(config.dataDir).filter((f) => f.endsWith('.json'))) {
    const full = path.join(config.dataDir, file);
    try {
      const session = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (session.state !== 'running') continue;
      session.state = 'interrupted';
      session.updatedAt = new Date().toISOString();
      session.interruptedAt = session.updatedAt;
      session.notices = [
        ...(session.notices || []),
        { level: 'warn', message: '服务在辩论进行中被停止，这是一份中断的会话记录；已完成的内容已保留。' },
      ];
      fs.writeFileSync(full, JSON.stringify(session, null, 2), 'utf8');
      recovered.push({ id: session.id, messages: (session.messages || []).length });
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return recovered;
}

/** 会话列表（不带完整发言，避免列表接口过大） */
export function list({ limit = 50, owner } = {}) {  ensureDir();
  const files = fs
    .readdirSync(config.dataDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(config.dataDir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const items = [];
  for (const { full } of files) {
    try {
      const s = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (owner !== undefined && s._owner !== owner) continue;
      items.push({
        id: s.id,
        name: s.hypothesis?.name || s.rawText?.slice(0, 24) || s.id,
        rawText: s.rawText,
        state: s.state,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages?.length ?? 0,
        contentionCount: s.contentions?.length ?? 0,
        criticalCount: (s.contentions ?? []).filter((c) => c.level === 'Critical').length,
        scoreTotal: s.scorecard?.total ?? null,
      });
      if (items.length >= limit) break;
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return items;
}
