/**
 * 角色智能体定义：从 prompts/*.md 加载提示词库。
 *
 * 设计要点：提示词是产品资产，不是代码。所以放在 prompts/ 下的 Markdown 里，
 * 带 frontmatter 元数据（名称、学科、颜色），改提示词不需要碰代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.mjs';

/** 极简 frontmatter 解析：只支持 key: value 与 - item 列表 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };

  const meta = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(rawLine);
    if (listItem && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(listItem[1].trim());
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
    if (kv) {
      currentKey = kv[1];
      let value = kv[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      meta[currentKey] = value;
    }
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

/** 辩论场上发言角色的顺序（也是前端左栏顺序） */
export const DEBATER_ORDER = ['scientist', 'statistician', 'clinician', 'reviewer', 'innovator'];

let cache = null;

function load() {
  if (cache) return cache;

  const dir = config.promptsDir;
  const shared = fs.existsSync(path.join(dir, '_shared.md'))
    ? fs.readFileSync(path.join(dir, '_shared.md'), 'utf8').trim()
    : '';

  const agents = new Map();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /^\d{2}-.*\.md$/.test(f)).sort()
    : [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.id) continue;
    const isModerator = meta.id === 'moderator';
    agents.set(meta.id, {
      id: meta.id,
      name: meta.name || meta.id,
      role: meta.role || '',
      discipline: meta.discipline || '',
      short: meta.short || '',
      color: meta.color || '#475569',
      kind: isModerator ? 'moderator' : 'debater',
      // 通用规则对所有角色生效，主持人除外（他不提质疑，只做收敛）
      systemPrompt: isModerator ? body : `${shared}\n\n---\n\n${body}`,
    });
  }

  cache = { agents, shared };
  return cache;
}

export function getAgent(id) {
  const { agents } = load();
  const agent = agents.get(id);
  if (!agent) throw new Error(`未找到角色：${id}`);
  return agent;
}

export function getAllAgents() {
  const { agents } = load();
  return [...agents.values()];
}

/** 给前端用的角色元数据（不含提示词正文） */
export function getAgentProfiles() {
  return getAllAgents().map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    discipline: a.discipline,
    short: a.short,
    color: a.color,
    kind: a.kind,
  }));
}
