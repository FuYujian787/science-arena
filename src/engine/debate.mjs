/**
 * 多轮辩论编排器（PRD 第 4 章：S0–S5）。
 *
 * 这是整个产品的心脏。设计上刻意做成"纯函数式编排"：
 * 它只依赖传入的 provider 和 emit 回调，不碰 HTTP、不碰文件、不碰数据库。
 * 所以它既能被命令行驱动（快速验证辩论质量），也能被 HTTP + SSE 驱动。
 */
import { getAgent, DEBATER_ORDER } from './agents.mjs';
import { normalizeHypothesis, cardToText } from './hypothesis.mjs';
import { retrieveEvidence, evidenceToText } from './evidence.mjs';
import {
  parseScorecard,
  parseModeratorOutput,
  checkCriticalCoverage,
  computeInferenceStats,
} from './synthesize.mjs';
import { uid, nowIso, truncate } from '../lib/util.mjs';

/** 阶段元数据：前端进度条与阶段标签都取自这里 */
export const STAGES = [
  { id: 'S0', name: '假设解析与规范化', goal: '把想法变成结构化假设卡' },
  { id: 'S1', name: '独立首轮评审', goal: '五角色并行评审，彼此不可见' },
  { id: 'S2', name: '交叉质疑', goal: '点名回应，禁止复述' },
  { id: 'S3', name: '审稿人质询', goal: '致命性质询，被点名者必须回应' },
  { id: 'S4', name: '创新性评估', goal: '五维评分卡' },
  { id: 'S5', name: '主持人汇总', goal: '争议清单 · 修改对照表 · 修正方案' },
];

const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.name]));

export function agentName(id) {
  try {
    return getAgent(id).name;
  } catch {
    return id;
  }
}

/** 把历史消息压成给模型看的紧凑文本 */
function formatHistory(messages, { limit = 40 } = {}) {
  const recent = messages.slice(-limit);
  return recent
    .map((m) => {
      const roundTag = m.round ? `·第${m.round}轮` : '';
      return `【${m.agentName}｜${STAGE_LABEL[m.stage] || m.stage}${roundTag}】\n${m.content}`;
    })
    .join('\n\n');
}

/**
 * 调用一个角色并流式回传。
 * 失败重试 1 次；仍失败则按 PRD 要求显式披露"角色缺席"，不静默降级。
 */
async function callAgent({ provider, agentId, user, stage, round, maxTokens, emit, isCancelled, task, compact }) {
  const agent = getAgent(agentId);
  const messageId = uid('msg');
  const startedAt = Date.now();

  emit({
    type: 'agent_start',
    agentId,
    agentName: agent.name,
    color: agent.color,
    stage,
    round: round ?? null,
    messageId,
  });

  const runOnce = async (budget) => {
    let content = '';
    let finishReason = null;
    for await (const chunk of provider.stream({
      system: agent.systemPrompt,
      user,
      maxTokens: budget,
      meta: { task: task || 'agent', agentId },
    })) {
      if (chunk.type === 'content') {
        content += chunk.text;
        emit({ type: 'agent_delta', agentId, messageId, kind: 'content', text: chunk.text });
      } else if (chunk.type === 'reasoning') {
        emit({ type: 'agent_delta', agentId, messageId, kind: 'reasoning', text: chunk.text });
      } else if (chunk.type === 'done') {
        finishReason = chunk.finishReason ?? null;
      }
    }
    return { content: content.trim(), finishReason };
  };

  // 重试策略分两种，性质完全不同，必须区别对待：
  //   1. 网络/接口报错 —— 原样重试；
  //   2. 输出被 token 上限截断，或正文为空（推理模型把预算全花在 reasoning 上）
  //      —— 这不是失败，是预算不够，要按倍数加预算重来。
  // 第 2 种在实测中出现过：主持人要输出完整的修正方案 JSON，6000 token 直接被推理吃光，
  // 结果整场辩论最关键的产出变成空。不做这层处理，现场演示会直接翻车。
  const MAX_BUDGET = 40000;
  let budget = maxTokens;
  let content = '';
  let finishReason = null;
  let error = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    content = '';
    finishReason = null;
    try {
      const r = await runOnce(budget);
      content = r.content;
      finishReason = r.finishReason;
      error = null;
    } catch (err) {
      error = err;
      if (attempt < 3) {
        emit({
          type: 'notice',
          level: 'warn',
          message: `${agent.name} 调用失败，正在重试（第 ${attempt} 次）：${err.message}`,
        });
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      break;
    }

    // 输出被截断或正文为空，都可能是"输出上限不够"。但只有在还能往上加的时候才重试——
    // 之前踩过：预算已经顶到 MAX_BUDGET 时仍然打印"提升到 40000 重试"，
    // 数字一模一样、实际毫无变化，纯属误导，还白烧一次调用。
    const canEscalate = budget < MAX_BUDGET;
    const next = Math.min(budget * 3, MAX_BUDGET);

    if (finishReason === 'length' && attempt < 3 && canEscalate) {
      emit({
        type: 'notice',
        level: 'warn',
        message: `${agent.name} 输出被 token 上限截断（${budget}），自动提升到 ${next} 重试。`,
      });
      budget = next;
      continue;
    }

    if (content) break;

    if (attempt < 3 && canEscalate) {
      emit({
        type: 'notice',
        level: 'warn',
        message: `${agent.name} 未返回正文（推理可能耗尽了 token 预算），提升到 ${next} 重试。`,
      });
      budget = next;
      continue;
    }

    // 已经加到顶还是空的：说明瓶颈不在引擎这边
    error = new Error(
      provider.name === 'dify'
        ? `模型只返回了推理过程，未返回正文。Dify 节点的输出上限（当前 ${budget} 或节点自身设置）不够——请到 Dify 打开该 LLM 节点，把「最大标记数」调到 8000 以上`
        : `模型只返回了推理过程，未返回正文（token 上限 ${budget}）`,
    );
    break;
  }

  const absent = !!error || !content;

  // 兜底再试一次：只给"精简版"指令。
  // 这一层是给能力受限的后端准备的——比如经 Dify 调用时，输出上限由 Dify 节点配置决定，
  // 引擎这边调大 token 预算根本不起作用；此时唯一能做的就是让模型少说点。
  if (absent && compact) {
    emit({
      type: 'notice',
      level: 'warn',
      message: `${agent.name} 未产出正文，改用精简指令再试一次（自动兜底，无需操作）。`,
    });
    try {
      content = '';
      for await (const chunk of provider.stream({
        system: agent.systemPrompt,
        user: `${user}\n\n【重要】上一次输出被截断了。这一次请**直接给出最终结果**，不要复述推理过程，内容压到最短（不超过 600 字）。`,
        maxTokens: budget,
        meta: { task: task || 'agent', agentId },
      })) {
        if (chunk.type === 'content') {
          content += chunk.text;
          emit({ type: 'agent_delta', agentId, messageId, kind: 'content', text: chunk.text });
        } else if (chunk.type === 'done') {
          finishReason = chunk.finishReason ?? finishReason;
        }
      }
      if (content.trim()) {
        // 兜底成功要说出来，否则用户只看到一串警告，会以为这场废了
        emit({
          type: 'notice',
          level: 'info',
          message: `${agent.name} 已用精简指令产出正文（${content.trim().length} 字），内容完整可用。`,
        });
      }
    } catch (err) {
      error = err;
    }
  }

  const finalContent = content.trim();
  const stillAbsent = !finalContent;
  if (stillAbsent) {
    const why = error ? error.message : '模型未返回内容';
    const advice =
      provider.name === 'dify'
        ? '请到 Dify 打开该 LLM 节点，把「最大标记数 / Max Tokens」调到 8000 以上并重新发布。'
        : '可尝试降低该角色的输出要求，或换用其他模型。';
    content = `（${agent.name}本次缺席：${why}）`;
    emit({
      type: 'notice',
      level: 'error',
      message: `${agent.name} 本次缺席，产出中会显式披露。${advice}`,
    });
  }

  const message = {
    id: messageId,
    agentId,
    agentName: agent.name,
    color: agent.color,
    stage,
    round: round ?? null,
    content: stillAbsent ? content : finalContent,
    absent: stillAbsent,
    finishReason,
    tokenBudget: budget,
    elapsedMs: Date.now() - startedAt,
    createdAt: nowIso(),
  };
  emit({ type: 'message', message });
  return { message, absent: stillAbsent, cancelled: !!(isCancelled && isCancelled()) };
}

/**
 * 跑完一整场辩论。
 *
 * @param {object}   opts
 * @param {object}   opts.provider    LLM 后端（见 src/llm/provider.mjs）
 * @param {string}   opts.rawText     用户输入的研究假设
 * @param {function} opts.emit        事件回调（SSE 推给前端）
 * @param {number}   [opts.crossRounds] 交叉质疑轮数，默认取配置
 * @param {function} [opts.isCancelled] 返回 true 时中止，已产出的内容保留
 */
export async function runDebate({
  provider,
  rawText,
  emit: rawEmit = () => {},
  crossRounds,
  isCancelled,
  initialEvidence = null,
  id,
  onProgress,
  // RAG 默认关闭：引擎不读全局配置，由调用方显式传入。
  // 这样单元测试天然不会去访问 PubMed（离线可跑）。
  rag = { provider: 'none' },
}) {
  const session = {
    // 允许调用方指定 id。HTTP 层要先返回 id 让前端订阅事件流，
    // 如果不把同一个 id 传进来，就会出现"返回给客户端的 id"和"落盘的 id"不一致——
    // 之后按前者查会话一律 404。（实测踩过）
    id: id || uid('arena'),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    state: 'running',
    rawText,
    provider: provider.name,
    model: provider.model ? provider.model() : '',
    hypothesis: null,
    evidence: [],
    evidenceCoverage: '',
    rag: null,
    messages: [],
    scorecard: null,
    summary: '',
    contentions: [],
    changeLog: [],
    revisedProtocol: '',
    coverage: null,
    inferenceStats: null,
    stages: [],
    notices: [],
  };

  const history = session.messages;
  const rounds = Number.isFinite(crossRounds) ? crossRounds : 2;

  /**
   * 进度回调：把当前会话快照交给调用方落盘。
   *
   * 为什么需要：一场真实辩论要 4–5 分钟，如果这期间服务被 Ctrl+C 或者崩了，
   * 之前所有模型输出都会丢。PRD F2 的验收标准是"任意阶段中止后已完成内容不丢失"，
   * 显式中止能保住，进程死掉也应该能保住。
   *
   * 回调本身抛错绝不能影响辩论——持久化失败是次要问题，辩不完才是主要问题。
   */
  const report = () => {
    if (!onProgress) return;
    try {
      onProgress(session);
    } catch {
      /* 忽略：落盘失败不应该中断辩论 */
    }
  };

  // 包一层 emit：消息与阶段边界是天然的持久化时机，不用在每个调用点手动插桩
  const emit = (event) => {
    // 警告落进 session.notices，否则只在界面上闪一下就没了，
    // 事后翻会话文件根本查不到"当时为什么回退到模型知识"
    if (event.type === 'notice') session.notices.push({ level: event.level || 'info', message: event.message, at: nowIso() });
    rawEmit(event);
    if (event.type === 'message' || event.type === 'stage') report();
  };

  const startStage = (id) => {
    const meta = STAGES.find((s) => s.id === id);
    const record = { id, name: meta?.name || id, startedAt: nowIso(), endedAt: null, elapsedMs: null };
    session.stages.push(record);
    emit({ type: 'stage', stage: id, status: 'start', name: record.name, goal: meta?.goal || '' });
    return record;
  };
  const endStage = (record) => {
    record.endedAt = nowIso();
    record.elapsedMs = new Date(record.endedAt) - new Date(record.startedAt);
    emit({ type: 'stage', stage: record.id, status: 'end', name: record.name, elapsedMs: record.elapsedMs });
  };

  const cancelled = () => !!(isCancelled && isCancelled());

  try {
    // ---------------- S0 假设解析 ----------------
    const s0 = startStage('S0');
    session.hypothesis = await normalizeHypothesis({ provider, rawText });
    session.reviewVersion = 3;
    if (session.hypothesis.parseStatus === 'fallback') emit({ type: 'notice', level: 'warn', message: '研究信息两次解析均未成功；本轮仅按原话讨论，结构化字段待核查，请勿据此认定研究缺陷。' });
    emit({ type: 'hypothesis', hypothesis: session.hypothesis });
    endStage(s0);
    const cardText = cardToText(session.hypothesis);

    // ---------------- 证据检索 ----------------
    emit({ type: 'stage', stage: 'EVIDENCE', status: 'start', name: '证据检索', goal: '为质疑提供可溯源依据' });
    if (initialEvidence) {
      session.evidence = initialEvidence.items || [];
      session.evidenceCoverage = initialEvidence.coverage || '';
      session.rag = initialEvidence.rag || { enabled: false, provider: 'none', total: 0, retrieved: 0 };
    } else {
      const evidence = await retrieveEvidence({ provider, card: session.hypothesis, cardText, rag });
      session.evidence = evidence.items;
      session.evidenceCoverage = evidence.coverage;
      session.rag = evidence.rag || { enabled: false, provider: 'none', total: 0, retrieved: 0 };

      if (evidence.retrievalError) {
        emit({
          type: 'notice',
          level: 'warn',
          message:
            `文献检索没成功（${evidence.retrievalError}），已回退到模型知识。` +
            '本次所有依据都会标注【模型知识】，不会被当成真实文献。',
        });
      }
    }

    const retrieved = (session.evidence || []).filter((e) => e.modelKnowledge === false);
    emit({
      type: 'evidence',
      items: session.evidence,
      coverage: session.evidenceCoverage,
      rag: session.rag,
      disclaimer: retrieved.length
        ? `其中 ${retrieved.length} 条来自 PubMed 真实检索（附 PMID，可点开核对原文），其余为模型知识并已标注。`
        : '本次证据来自模型知识，已强制标注【模型知识】，非真实文献检索结果。',
    });
    emit({ type: 'stage', stage: 'EVIDENCE', status: 'end', name: '证据检索' });

    const evidenceText = evidenceToText(session.evidence);
    const common = `# 研究假设卡\n\n${cardText}\n\n# 可用证据卡\n\n${evidenceText}`;

    // ---------------- S1 独立首轮评审（并行，互不可见）----------------
    const s1 = startStage('S1');
    const firstRoundPrompt = (agentId) =>
      `${common}\n\n# 你的任务\n\n现在是**独立首轮评审**。你**看不到**其他角色的意见，请给出独立判断。\n\n按你的维度提出有依据的具体问题，使用五字段格式。信息不足写成待澄清问题，不认定为已证实缺陷；无需凑够条数。创新性评估员本阶段讨论可比先例与潜在增量，不提前打分。`;

    await Promise.all(
      DEBATER_ORDER.map(async (agentId) => {
        const { message } = await callAgent({
          provider,
          agentId,
          user: firstRoundPrompt(agentId),
          stage: 'S1',
          maxTokens: 6000,
          emit,
          isCancelled,
        });
        history.push(message);
      }),
    );
    // 并行返回顺序不定，按固定角色顺序重排，保证时间轴可读
    const s1Messages = history.filter((m) => m.stage === 'S1');
    for (const id of DEBATER_ORDER) {
      const idx = history.findIndex((m) => m.stage === 'S1' && m.agentId === id);
      if (idx !== -1) history.push(history.splice(idx, 1)[0]);
    }
    void s1Messages;
    endStage(s1);

    if (cancelled()) return finish(session, emit, 'cancelled');

    // ---------------- S2 交叉质疑 ----------------
    for (let round = 1; round <= rounds; round++) {
      const s2 = startStage('S2');
      emit({ type: 'round', stage: 'S2', round, total: rounds });

      for (const agentId of DEBATER_ORDER) {
        if (cancelled()) return finish(session, emit, 'cancelled');
        const prompt = `${common}

# 到目前为止的发言

${formatHistory(history)}

# 你的任务

现在是**第 ${round} 轮交叉质疑**（共 ${rounds} 轮）。

硬性要求：
1. 你必须**点名回应**至少一位其他角色的观点，写法为"回应 XXX：……"。
2. 你必须提出**至少 1 条全新的质疑**，或者明确指出上面某个争议你已经接受。
3. **禁止复述**已经说过的观点。如果你没有任何新东西可说，直接写"本轮无新增意见"，不要凑字数。
4. 与其他角色产生实质分歧时，请写清你的成立条件是什么。
5. **本轮总长控制在 400 字以内**——交叉质疑的价值在于交锋密度，不在于篇幅。`;

        const { message, cancelled: wasCancelled } = await callAgent({
          provider,
          agentId,
          user: prompt,
          stage: 'S2',
          round,
          maxTokens: 5000,
          emit,
          isCancelled,
        });
        history.push(message);
        if (wasCancelled) return finish(session, emit, 'cancelled');
      }
      endStage(s2);
    }

    if (cancelled()) return finish(session, emit, 'cancelled');

    // ---------------- S3 审稿人质询 ----------------
    const s3 = startStage('S3');
    const reviewerPrompt = `${common}

# 到目前为止的发言

${formatHistory(history)}

# 你的任务

现在进入**审稿人质询**阶段。请集中提出你认为最致命、且**必须在修改方案中回应**的质询（2–4 条）。

要求：
- 不要重复你在首轮已经说过的内容，除非你要进一步加剧它并说明为什么之前的回应不足以说服你。
- 对每条质询，明确写出"需要补充什么才能说服我"。
- 如果某个问题在辩论中已经被回应且你认为仍未解决，标注【状态：Open Issue】。`;

    const reviewerCall = await callAgent({
      provider,
      agentId: 'reviewer',
      user: reviewerPrompt,
      stage: 'S3',
      maxTokens: 5000,
      emit,
      isCancelled,
    });
    history.push(reviewerCall.message);
    if (reviewerCall.cancelled) return finish(session, emit, 'cancelled');

    const challengeText = reviewerCall.message.content;
    for (const agentId of ['scientist', 'statistician', 'clinician']) {
      if (cancelled()) return finish(session, emit, 'cancelled');
      const prompt = `${common}

# 到目前为止的发言

${formatHistory(history)}

# 审稿人对你所在领域的质询

${challengeText}

# 你的任务

请**逐条回应**审稿人的质询。

要求：
1. 每条回应必须说明：是否可以修改方案来解决、具体怎么改。
2. 如果你**无法**给出足以说服审稿人的回应，必须明确写出"此问题为未解决（Open Issue）"，并说明为什么现在无法解决。
3. 不要替其他角色的领域作答。`;

      const { message, cancelled: wasCancelled } = await callAgent({
        provider,
        agentId,
        user: prompt,
        stage: 'S3',
        maxTokens: 5000,
        emit,
        isCancelled,
      });
      history.push(message);
      if (wasCancelled) return finish(session, emit, 'cancelled');
    }
    endStage(s3);

    // ---------------- S4 创新性评估 ----------------
    const s4 = startStage('S4');
    const innovatorPrompt = `${common}

# 到目前为止的发言

${formatHistory(history)}

# 你的任务

请对**用户已提供的假说/方案**做研究潜力五维初评，不评完整论文。
先核对用户原话与证据卡；角色自行提出的设计、数字、门槛不能变成用户方案事实。
未说明方法或资源是信息不足，不是低创新；不由多数意见或前轮分数替代证据。
检索仅有 ${(session.evidence || []).length} 张证据卡，不能据此确定全球首创或全面重复。
只输出含version:2、五维分数、assessments、comments、suggestions的JSON。
assessments每维提供status(scored/insufficient)、reason、confidence(low/medium)、evidence、missingInformation。
信息不足的分数必须为null；没有逐维理由的分数不会被采纳。不要自行输出总分。`;

    const innovatorCall = await callAgent({
      provider,
      agentId: 'innovator',
      user: innovatorPrompt,
      stage: 'S4',
      maxTokens: 6000,
      emit,
      isCancelled,
      task: 'scorecard',
    });
    history.push(innovatorCall.message);
    session.scorecard = parseScorecard(innovatorCall.message.content);
    emit({ type: 'scorecard', scorecard: session.scorecard });
    endStage(s4);

    if (cancelled()) return finish(session, emit, 'cancelled');

    // ---------------- S5 主持人汇总 ----------------
    const s5 = startStage('S5');
    const moderatorPrompt = `${common}

# 完整辩论记录

${formatHistory(history, { limit: 60 })}

# 你的任务

请以主持人身份汇总这场辩论，输出规定的 JSON 对象：
- summary：哪些点形成共识，哪些没有收敛
- contentions：争议清单（去重合并、定级）
- changeLog：修改对照表
- revisedProtocol：修正版研究方案全文（九节）

这是待核查的评审建议，不是事实核验报告。先对照用户原话和U编号材料，分开已说明、未提供和角色新建议。
changeLog每条originQuote逐字引用用户输入，不得引用角色假设；无锚点留空并标待核查。不能将推断当成已实施设计或已证实缺陷。
有本轮焦点时围绕该点给核查与建议，不强制重写整项已完成研究。忽略无事实支持的多数共识。

硬性要求：
1. **全部 Critical 级争议必须在 changeLog 与 revisedProtocol 中被覆盖。**
2. 未收敛的分歧必须保留为 "Open Issue"，写明双方立场，不许抹平。
3. 不得引入辩论中没有出现过的新观点。
4. **控制篇幅**：revisedProtocol 不超过 1000 字，contentions 不超过 8 条，changeLog 不超过 8 条。
   宁可精炼也不要用重复表述凑字数——输出越长越容易被截断，反而丢掉最关键的内容。
5. 直接给结论，不要在正文里复述你的推理过程。`;

    const moderatorCall = await callAgent({
      provider,
      agentId: 'moderator',
      user: moderatorPrompt,
      stage: 'S5',
      maxTokens: 16000,
      emit,
      isCancelled,
      task: 'moderator',
      // 主持人要点最多、最容易撞输出上限，兜底走精简重试
      compact: true,
    });
    history.push(moderatorCall.message);

    const parsed = parseModeratorOutput(moderatorCall.message.content, { rawText });
    session.summary = parsed.summary;
    session.contentions = parsed.contentions;
    session.changeLog = parsed.changeLog;
    session.revisedProtocol = parsed.revisedProtocol;
    session.coverage = checkCriticalCoverage(session.contentions, session.changeLog);

    // 抢救式解析：JSON 被截断，但结构大部分救回来了。必须如实告知，不能假装完整。
    if (parsed.salvaged) {
      session.salvaged = true;
      emit({
        type: 'notice',
        level: 'warn',
        message:
          `主持人输出被输出上限截断，已从残缺 JSON 中抢救出 ${parsed.contentions.length} 条争议、` +
          `${parsed.changeLog.length} 条修改对照。内容可用，但可能不完整——` +
          (provider.name === 'dify'
            ? '把 Dify 里该 LLM 节点的「最大标记数」调到 8000 以上可避免截断。'
            : '可尝试提高输出上限或精简要求。'),
      });
    }

    // 主持人 JSON 解析失败时，至少把原文留作修正方案，别让用户什么都拿不到
    if (!session.revisedProtocol && !session.contentions.length) {
      emit({
        type: 'notice',
        level: 'warn',
        message: '主持人结构化输出解析失败，已将原文保留为修正方案。',
      });
      session.revisedProtocol = moderatorCall.message.content;
    }

    emit({
      type: 'contentions',
      contentions: session.contentions,
      changeLog: session.changeLog,
      summary: session.summary,
      coverage: session.coverage,
    });
    emit({ type: 'protocol', revisedProtocol: session.revisedProtocol });
    endStage(s5);

    return finish(session, emit, 'done');
  } catch (err) {
    session.state = 'failed';
    session.error = err.message;
    emit({ type: 'error', message: err.message });
    return finish(session, emit, 'failed');
  }
}

function finish(session, emit, state) {
  session.state = state === 'done' ? 'done' : state;
  session.updatedAt = nowIso();
  session.inferenceStats = computeInferenceStats(session.messages, session.evidence);
  session.totalElapsedMs = session.stages.reduce((acc, s) => acc + (s.elapsedMs || 0), 0);
  emit({ type: 'done', state, session });
  return session;
}

export { truncate };
