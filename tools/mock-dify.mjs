#!/usr/bin/env node
/**
 * 本地模拟的 Dify 服务 API（开发/测试用，不属于交付物）。
 *
 * 为什么需要它：真实 Dify 需要一个 App API Key 才能联调，而 `src/llm/dify.mjs`
 * 这条代码路径在拿到 Key 之前一次都没被执行过——没跑过的代码就是没写过的代码。
 * 这个模拟服务实现了 Dify 服务 API 的两个关键端点，让整条链路可以离线验证：
 *
 *   GET  /v1/parameters     —— 验证密钥 + 返回应用声明的输入变量
 *   POST /v1/workflows/run  —— 阻塞式与流式（SSE）两种响应模式
 *
 * 它按 query 里的关键词判断当前处于哪个阶段，返回结构上正确的响应，
 * 从而让 S0–S5 全流程（含主持人 JSON 解析）都能被端到端跑通。
 *
 * 用法：node tools/mock-dify.mjs [--port=8791] [--key=app-test] [--fail=key|model|empty]
 */
import http from 'node:http';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const PORT = Number(flag('port', 8791));
const EXPECT_KEY = flag('key', 'app-test');
const FAIL = flag('fail', '');

const HYPOTHESIS_CARD = {
  subject: '某种肠道菌群（原文未具体化到属/种/株）',
  intervention: '菌群调节干预（形式未明确）',
  mediator: '胆汁酸代谢谱',
  outcome: 'IBD 疾病活动度与抑郁症状',
  population: 'IBD 合并抑郁共病人群',
  studyType: '待定',
  ambiguities: ['菌株未具体化', '未说明研究类型与对照设置'],
  clarifyingQuestions: ['干预形式是益生菌、FMT 还是膳食调节？'],
};

const EVIDENCE = {
  coverage: '（模拟服务）中间环节缺乏人体证据。',
  items: [
    { sourceType: '方法学资料', sourceRef: '【模型知识】因果中介分析框架', summary: '中介检验需要明确的时序，横断面数据无法识别中介。', relevance: '决定中介主张能否成立', confidence: 'high' },
    { sourceType: '文献知识', sourceRef: '【模型知识】肠—脑轴研究', summary: '人群层面因果方向尚未确定。', relevance: '提示反向因果风险', confidence: 'medium' },
  ],
};

const SCORECARD = {
  version: 2,
  assessments: Object.fromEntries(['novelty', 'increment', 'rigor', 'translatability', 'feasibility'].map(key => [key, {
    status: 'scored', reason: '集成测试固定数据，不是科研结论。', confidence: 'low', evidence: ['模拟数据'], missingInformation: [],
  }])),
  novelty: 3,
  increment: 2,
  rigor: 2,
  translatability: 3,
  feasibility: 4,
  comments: '（模拟服务）新颖性中等，方法严谨性偏低是主要扣分项。',
  suggestions: ['把假设收窄到具体菌株与具体胆汁酸分子', '补做基于中介效应量的功效计算'],
};

const MODERATOR = {
  summary: '（模拟服务）五方在"设计缺少对照"上形成共识，伦理边界未完全收敛。',
  contentions: [
    { title: '单臂开放设计无法排除安慰剂效应与自然波动', level: 'Critical', raisedBy: ['statistician', 'reviewer'], suggestion: '改为随机双盲安慰剂对照' },
    { title: '未说明伦理审查与知情同意', level: 'Critical', raisedBy: ['clinician'], suggestion: '补充伦理与安全监测方案' },
    { title: '安慰剂对照在抑郁人群中的伦理可接受性存在分歧', level: 'Open Issue', raisedBy: ['clinician', 'reviewer'], suggestion: '保留双方立场' },
  ],
  changeLog: [
    { originElement: '单臂干预 12 周', contention: '单臂开放设计无法排除安慰剂效应与自然波动', revisedElement: '改为随机双盲安慰剂对照，共同主要终点', rationale: '排除自然波动与安慰剂效应' },
    { originElement: '未提及伦理', contention: '未说明伦理审查与知情同意', revisedElement: '补充伦理审查、知情同意与安全性监测', rationale: '合规必要前提' },
  ],
  revisedProtocol:
    '（模拟服务）修正版研究方案\n\n' +
    '一、研究问题：把因果主张收窄为可检验的中介假说，明确菌株、胆汁酸分子与结局判定标准。\n' +
    '二、总体设计：两阶段——先做纵向中介分析确立中介链，再做随机双盲安慰剂对照验证干预。\n' +
    '三、研究对象：成人患者，亚型作为协变量而非分层因子，抗抑郁药剂量需稳定。\n' +
    '四、样本量：按检验间接效应的要求单独计算，不以总效应估算替代。\n' +
    '五、终点：共同主要终点为抑郁量表变化与血清次级胆汁酸谱变化。\n' +
    '六、统计分析：预设主要中介分子，多组学做多重比较校正，缺失数据做敏感性分析。\n' +
    '七、混杂控制：饮食、用药、疾病活动度、吸烟在纳排标准与协变量中显式处理。\n' +
    '八、伦理与安全：伦理审查、知情同意、心理支持与危机干预预案、安全性监测与停药规则。\n' +
    '九、报告规范：按 CONSORT / STROBE 报告，摘要给出试验注册号。',
};

/** 按 query 关键词判断阶段，返回结构正确的响应 */
function respondFor(payload) {
  const q = `${payload?.inputs?.system_prompt || ''}\n${payload?.inputs?.query || payload?.query || ''}`;

  if (/抽取成结构化假设卡|结构化要素/.test(q)) return JSON.stringify(HYPOTHESIS_CARD);
  if (/列出 4–6 条|关键依据/.test(q)) return JSON.stringify(EVIDENCE);
  if (/创新性五维评分|五维评分|研究潜力五维初评/.test(q)) return JSON.stringify(SCORECARD);
  if (/主持人身份汇总|汇总这场辩论/.test(q)) return JSON.stringify(MODERATOR);

  // 各角色的辩论发言
  const role =
    /科学家/.test(q) ? '科学家' : /统计学家/.test(q) ? '统计学家' : /临床专家/.test(q) ? '临床专家' : /审稿人/.test(q) ? '审稿人' : /创新性评估员/.test(q) ? '创新性评估员' : '评审人';

  return [
    `【问题】${role}视角·模拟意见：主要终点未事先锁定，难以判断成败。`,
    '【为什么是问题】没有预设的主要终点，阳性结果可能是事后挑选出来的。',
    '【建议修改】在分析计划中预设唯一主要终点与最小临床重要差异。',
    '【依据】【模型知识】',
    '【严重程度：重要】',
  ].join('\n');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';

  const sendJson = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  const unauthorized = () => sendJson(401, { code: 'unauthorized', message: 'Access token is invalid' });

  if (req.method === 'GET' && url.pathname === '/v1/parameters') {
    if (FAIL === 'key') return unauthorized();
    if (auth !== `Bearer ${EXPECT_KEY}`) return unauthorized();
    return sendJson(200, {
      introduction: '（模拟 Dify 服务）',
      user_input_form: [
        { paragraph: { label: 'system_prompt', variable: 'system_prompt', required: true, max_length: 40000 } },
        { paragraph: { label: 'query', variable: 'query', required: true, max_length: 50000 } },
      ],
      file_upload: { enabled: false },
    });
  }

  if (req.method === 'POST' && url.pathname === '/v1/workflows/run') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        return sendJson(400, { code: 'invalid_param', message: 'body is not JSON' });
      }

      if (FAIL === 'model') {
        return sendJson(400, { code: 'invalid_param', message: 'Model not found in provider' });
      }
      if (auth !== `Bearer ${EXPECT_KEY}`) return unauthorized();

      const text = FAIL === 'empty' ? '' : respondFor(payload);
      const runId = `mock-run-${Date.now().toString(36)}`;

      if (payload.response_mode === 'streaming') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const ev = (event, data) => res.write(`data: ${JSON.stringify({ event, data })}\n\n`);
        ev('workflow_started', { id: runId, workflow_id: 'mock-wf' });
        ev('node_started', { node_id: 'llm', title: 'LLM' });
        // 分块吐字，模拟真实流式
        for (let i = 0; i < text.length; i += 40) {
          ev('text_chunk', { text: text.slice(i, i + 40) });
        }
        ev('node_finished', { node_id: 'llm', status: 'succeeded' });
        ev('workflow_finished', { id: runId, status: 'succeeded', outputs: { text } });
        return res.end();
      }

      return sendJson(200, {
        workflow_run_id: runId,
        task_id: runId,
        data: { id: runId, workflow_id: 'mock-wf', status: 'succeeded', outputs: { text }, total_tokens: 0 },
      });
    });
    return;
  }

  return sendJson(404, { code: 'not_found', message: `${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-dify listening on http://127.0.0.1:${PORT}  key=${EXPECT_KEY}${FAIL ? `  fail=${FAIL}` : ''}`);
});
