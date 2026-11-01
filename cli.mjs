#!/usr/bin/env node
/**
 * 命令行驱动：不启动服务，直接跑一场辩论。
 *
 * 用途：调提示词时不必反复点前端；也方便把辩论质量单独拿出来评估。
 *
 * 用法：
 *   node cli.mjs "某种菌群能否通过胆汁酸改善IBD抑郁共病"
 *   node cli.mjs "假设内容" --provider=mock --rounds=1
 *   node cli.mjs "假设内容" --json > result.json
 */
import { config, describeProvider } from './src/config.mjs';
import { getProvider } from './src/llm/provider.mjs';
import { runDebate, STAGES } from './src/engine/debate.mjs';
import fs from 'node:fs';
import path from 'node:path';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

/** 这些开关一定带值，所以 --out path 和 --out=path 都支持 */
const VALUE_FLAGS = new Set(['provider', 'rounds', 'out']);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) {
      args._.push(a);
      continue;
    }
    const [, key, inlineValue] = m;
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (VALUE_FLAGS.has(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[++i];
    } else {
      args[key] = true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const rawText = args._.join(' ').trim() || '某种菌群能否通过胆汁酸改善IBD抑郁共病';
const providerName = args.provider || config.provider;
const rounds = args.rounds ? Number(args.rounds) : config.crossRounds;
const asJson = !!args.json;
const quiet = !!args.quiet;

const provider = getProvider(providerName);

if (!asJson) {
  console.log(`${C.bold}${C.cyan}Science Arena${C.reset} ${C.dim}· 命令行干跑${C.reset}`);
  // 注意用实际生效的后端，而不是 .env 里的默认值——带 --provider 时两者可能不同
  const modelLabel = provider.model ? provider.model() : '';
  console.log(`${C.dim}后端：${provider.label}${modelLabel ? ` · ${modelLabel}` : ''}${C.reset}`);
  console.log(`${C.dim}假设：${rawText}${C.reset}`);
  console.log(`${C.dim}交叉质疑轮数：${rounds}${C.reset}\n`);
}

let currentAgent = null;
const startedAt = Date.now();

// S1 是并行调用，五个角色的 token 会交错到达。
// 直接往 stdout 写会糊成一团，所以并行阶段先按消息缓冲，等整条发言结束再一次性输出。
const parallelBuffers = new Map();
let parallelMode = false;

const emit = (event) => {
  if (asJson || quiet) return;
  switch (event.type) {
    case 'stage':
      if (event.status === 'start') {
        parallelMode = event.stage === 'S1';
        console.log(`\n${C.bold}${C.blue}▶ ${event.stage} ${event.name}${C.reset}${event.goal ? ` ${C.dim}— ${event.goal}${C.reset}` : ''}`);
      } else if (event.elapsedMs != null) {
        console.log(`${C.dim}  ✓ ${event.name} 用时 ${(event.elapsedMs / 1000).toFixed(1)}s${C.reset}`);
      }
      break;
    case 'agent_start':
      if (parallelMode) {
        parallelBuffers.set(event.messageId, { name: event.agentName, text: '' });
      } else {
        process.stdout.write(`\n${C.bold}${C.magenta}【${event.agentName}】${C.reset} `);
      }
      currentAgent = event.agentId;
      break;
    case 'agent_delta':
      if (event.kind !== 'content') break;
      if (parallelMode) {
        const buf = parallelBuffers.get(event.messageId);
        if (buf) buf.text += event.text;
      } else {
        process.stdout.write(event.text);
      }
      break;
    case 'message':
      if (parallelMode && parallelBuffers.has(event.message.id)) {
        const buf = parallelBuffers.get(event.message.id);
        parallelBuffers.delete(event.message.id);
        console.log(`\n${C.bold}${C.magenta}【${buf.name}】${C.reset} ${buf.text.trim()}`);
      }
      break;
    case 'notice': {
      const color = event.level === 'error' ? C.red : event.level === 'info' ? C.green : C.yellow;
      const mark = event.level === 'error' ? '✗' : event.level === 'info' ? '✓' : '⚠';
      console.log(`\n${color}${mark} ${event.message}${C.reset}`);
      break;
    }
    case 'error':
      // 以前没有这个分支，导致整场失败时终端一片沉默，只能靠退出码猜
      console.log(`\n${C.red}${C.bold}✗ 辩论中止：${event.message}${C.reset}`);
      break;
    case 'hypothesis':
      console.log(`\n${C.dim}研究对象：${event.hypothesis.subject}`);
      console.log(`干预/暴露：${event.hypothesis.intervention}`);
      console.log(`中介变量：${event.hypothesis.mediator || '（未指定）'}`);
      console.log(`结局指标：${event.hypothesis.outcome}`);
      console.log(`目标人群：${event.hypothesis.population}${C.reset}`);
      if (event.hypothesis.ambiguities?.length) {
        console.log(`${C.yellow}歧义提示：${event.hypothesis.ambiguities.join('；')}${C.reset}`);
      }
      break;
    case 'evidence':
      console.log(`\n${C.dim}证据卡 ${event.items.length} 条（${event.disclaimer}）${C.reset}`);
      for (const e of event.items) console.log(`${C.dim}  [${e.id}] ${e.sourceType} · ${e.summary.slice(0, 60)}…${C.reset}`);
      break;
    case 'scorecard': {
      const s = event.scorecard;
      console.log(`\n${C.bold}创新性评分卡${C.reset}`);
      const dims = [
        ['新颖性', s.novelty, 0.3],
        ['增量贡献', s.increment, 0.25],
        ['方法严谨性', s.rigor, 0.2],
        ['可转化性', s.translatability, 0.15],
        ['可行性', s.feasibility, 0.1],
      ];
      for (const [label, v, w] of dims) console.log(`  ${label.padEnd(6)} ${String(v ?? '—').padStart(4)}  ${C.dim}(权重 ${w * 100}%)${C.reset}`);
      console.log(`  ${C.bold}加权总分 ${s.total ?? '—'}${C.reset}`);
      break;
    }
    case 'contentions':
      console.log(`\n${C.bold}争议清单（${event.contentions.length} 条）${C.reset}`);
      for (const c of event.contentions) {
        const color = c.level === 'Critical' ? C.red : c.level === 'Open Issue' ? C.yellow : C.reset;
        console.log(`  ${color}[${c.id}] ${c.level}${C.reset} ${c.title}`);
      }
      break;
    default:
      break;
  }
};

const session = await runDebate({ provider, rawText, emit, crossRounds: rounds, rag: config.rag });
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

// --out 直接落文件：PowerShell 的 > 重定向默认是 UTF-16，会把中文 JSON 写坏
if (args.out && typeof args.out === 'string') {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(session, null, 2), 'utf8');
  if (!asJson && !quiet) console.log(`\n${C.dim}会话数据已写入 ${outPath}${C.reset}`);
}

if (asJson) {
  console.log(JSON.stringify(session, null, 2));
} else {
  console.log(`\n${C.bold}${C.green}════════ 辩论完成 ════════${C.reset}`);
  console.log(`总用时 ${elapsed}s ｜ 发言 ${session.messages.length} 条 ｜ 争议 ${session.contentions.length} 条`);

  if (session.summary) console.log(`\n${C.bold}主持人总结${C.reset}\n${session.summary}`);

  if (session.coverage) {
    const ok = session.coverage.ratio >= 1;
    console.log(
      `\n${C.bold}致命争议覆盖率${C.reset} ${ok ? C.green : C.red}${session.coverage.covered}/${session.coverage.total}${C.reset}` +
        (session.coverage.uncovered.length ? ` ${C.red}未覆盖：${session.coverage.uncovered.join(', ')}${C.reset}` : ''),
    );
  }

  if (session.inferenceStats) {
    const s = session.inferenceStats;
    console.log(
      `\n${C.dim}诚实披露：证据卡 ${s.evidenceCount} 条（全部来自模型知识）｜引用标注 ${s.citationMarks} 次｜` +
        `【模型知识】标注 ${s.knowledgeMarks} 次｜【推断】标注 ${s.inferenceMarks} 次${C.reset}`,
    );
  }

  console.log(`\n${C.bold}阶段用时${C.reset}`);
  for (const st of session.stages) {
    console.log(`  ${st.id.padEnd(4)} ${st.name.padEnd(14)} ${((st.elapsedMs || 0) / 1000).toFixed(1)}s`);
  }

  if (session.revisedProtocol) {
    console.log(`\n${C.bold}${C.cyan}──────── 修正版研究方案 ────────${C.reset}\n`);
    console.log(session.revisedProtocol);
  }

  console.log(`\n${C.dim}提示：加 --json 可导出完整会话数据${C.reset}`);
  void STAGES;
}

process.exit(session.state === 'failed' ? 1 : 0);
