/** 通用小工具：零依赖 */

let seq = 0;

/** 短 ID，够用且可读 */
export function uid(prefix = 'id') {
  seq = (seq + 1) % 100000;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${t}${r}${seq.toString(36)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从模型输出里稳健地抽取 JSON。
 * 依次尝试：整体解析 → 去代码围栏 → 截取第一个平衡的 {...} 或 [...]。
 */
export function extractJson(text, { repair = false } = {}) {
  if (!text || typeof text !== 'string') return null;

  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const unfenced = text
    .replace(/^\s*```(?:json|JSON)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  const fromFence = tryParse(unfenced);
  if (fromFence !== undefined) return fromFence;

  // 扫描平衡括号。
  // 关键：必须按"最先出现的括号类型"优先，否则模型直接返回数组时
  // （[{...},{...}]），会先找到数组内部第一个对象的 { 并把它切成单个对象，
  // 导致 items 字段丢失。这是实测踩过的坑。
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const order = [];
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) order.push(['[', ']']);
  if (firstBrace !== -1) order.push(['{', '}']);
  if (firstBracket !== -1) order.push(['[', ']']);

  for (const [open, close] of order) {
    const start = text.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const candidate = tryParse(text.slice(start, i + 1));
          if (candidate !== undefined) return candidate;
          break;
        }
      }
    }
  }

  // 常规解析全失败时才尝试抢救——通常意味着输出被截断了
  if (repair) {
    const salvaged = repairJson(text);
    if (salvaged !== null) return salvaged;
  }
  return null;
}

/**
 * 修复被截断的 JSON。
 *
 * 为什么需要：输出上限不够时（典型场景是经 Dify 调用，上限由节点配置决定，
 * 引擎这边加预算无效），主持人那份大 JSON 会被从中间切断，`JSON.parse` 直接失败，
 * 结果四件产出里最核心的「争议清单」和「修改对照表」变成空的——
 * 明明已经生成了一多半，却全部丢掉。
 *
 * 做法：从第一个括号开始，补齐未闭合的字符串与括号；解析不通就退到上一个逗号处再试。
 * 属于"抢救式解析"：只保证尽量多地把已生成的结构拿回来，不保证语义完美。
 */
function closeUnbalanced(s) {
  const stack = [];
  let inStr = false;
  let esc = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let out = s;
  if (inStr) out += '"'; // 截在字符串中间：先把引号补上
  // 末尾是冒号或逗号时补一个占位值，否则不是合法 JSON
  const tail = out.replace(/\s+$/, '');
  if (/[:,]$/.test(tail)) out += ' null';
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}

export function repairJson(text) {
  const raw = String(text ?? '');
  const first = raw.search(/[{[]/);
  if (first === -1) return null;

  let body = raw.slice(first);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      return JSON.parse(closeUnbalanced(body));
    } catch {
      /* 继续回退 */
    }
    // 退到上一个逗号处，把最后一个不完整的片段丢掉再试
    const cut = body.lastIndexOf(',');
    if (cut <= 0) break;
    body = body.slice(0, cut);
  }
  return null;
}

/** 中文场景下按"字"截断，避免切坏词 */
export function truncate(text, max) {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** 去掉模型爱加的多余前缀，比如"质疑：" */
export function stripLabel(text, labels = []) {
  let out = (text || '').trim();
  for (const l of labels) {
    if (out.startsWith(l)) out = out.slice(l.length).trim();
  }
  return out;
}

/** 并发限流执行（保持结果顺序） */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 用统一 id 递增器生成 E-01 / C-01 这类编号 */
export function makeCounter(prefix, pad = 2) {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(pad, '0')}`;
}
