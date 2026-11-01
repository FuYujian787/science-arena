/**
 * Mock 后端：不调用任何模型，返回预置的高质量辩词。
 *
 * 用途有两个，都很重要：
 *  1. 断网/没额度时仍能完整演示产品流程（比赛现场的保险绳）；
 *  2. 开发前端时不必反复烧 token。
 *
 * 预置内容以"菌群—胆汁酸—IBD 抑郁共病"为骨架，其他假设会退化为通用模板。
 */
import { sleep } from '../lib/util.mjs';

const SCRIPT = {
  normalize: {
    subject: '肠道菌群（候选：产丁酸菌、Akkermansia 等，原文未具体化）',
    intervention: '菌群调节干预（益生菌 / FMT / 膳食纤维，原文未明确）',
    mediator: '胆汁酸代谢谱（初级/次级胆汁酸、FXR/TGR5 信号）',
    outcome: 'IBD 疾病活动度 + 抑郁症状（原文未明确量表与判定阈值）',
    population: 'IBD 合并抑郁共病人群（未区分 CD / UC 亚型）',
    studyType: '待定——观察性中介分析还是干预性 RCT，是本次辩论的核心分歧',
    ambiguities: ['“某种菌群”未具体化到属/种/株', '“改善”未明确终点指标与最小临床重要差异', '未说明研究类型与对照设置'],
  },
  evidence: {
    coverage: '就本假设而言，“菌群→胆汁酸→症状”的中间环节缺乏人体证据，属于明显缺口。',
    items: [
    { sourceType: '方法学资料', sourceRef: '【模型知识】STROBE / CONSORT / ARRIVE 报告规范', summary: '观察性研究主张因果、干预性研究声称机制中介时，均需按对应规范报告设计与偏倚控制。', relevance: '决定本假设该用什么设计才有内部效度', confidence: 'high' },
    { sourceType: '方法学资料', sourceRef: '【模型知识】因果中介分析框架（反事实/自然间接效应）', summary: '检验“菌群→胆汁酸→抑郁”的中介链需要时序明确的暴露、中介、结局测量，横断面数据无法识别中介。', relevance: '直接决定中介主张能否成立', confidence: 'high' },
    { sourceType: '文献知识', sourceRef: '【模型知识】肠—脑轴与胆汁酸信号研究', summary: '已有研究报道胆汁酸经 FXR/TGR5 参与肠屏障、免疫与中枢信号调节，但人群层面因果方向未定。', relevance: '支持机制链存在，但不支持单向因果', confidence: 'medium' },
    { sourceType: '临床指南', sourceRef: '【模型知识】IBD 与抑郁共病管理相关共识', summary: 'IBD 患者抑郁患病率高于一般人群，抗抑郁药与激素使用会影响肠道微生态与情绪评估。', relevance: '提示关键混杂因素', confidence: 'medium' },
    ],
  },
  scientist: [
    '【机制链缺环】“菌群→胆汁酸→肠脑轴→抑郁”这条链上，每一跳都需要独立证据。目前普遍缺失的是“特定菌属改变→特定胆汁酸谱改变”的人体剂量—反应证据。没有这一环，整条链就只是并列的关联。',
    '【方向性存疑】抑郁本身会改变饮食结构、肠道通透性与应激激素水平，从而反向改变菌群与胆汁酸谱。观察性数据无法排除反向因果，把相关性写成因果是不可证伪的表述。',
    '【可证伪性不足】必须预先指定中介分子（例如哪一种次级胆汁酸、经哪条受体），否则任何阴性结果都能被解释成“选错了菌或选错了指标”。',
    '【模型外推】若证据主要来自 DSS 结肠炎合并 CUMS 的小鼠模型，需说明从啮齿类到人的跨越前提（菌群组成差异、免疫通路差异、行为学量表不可比），否则动物结论不能支撑人体假说。',
  ],
  statistician: [
    '【无对照】单臂开放设计下，PHQ-9 的 12 周变化无法区分干预效应、安慰剂效应、回归均值与疾病自然波动。这是致命缺陷，不修改则结论不可采信。',
    '【功效未论证】未给出基于效应量的样本量计算。中介分析所需样本量通常显著大于总效应检验（检验间接效应需要更大样本），按总效应估算会严重低估需求。',
    '【多重比较】16S/宏基因组 + 靶向胆汁酸代谢组涉及数百个特征，未做多重比较校正会大量假阳性；建议预设主要中介分子并对次要分析做 FDR 控制。',
    '【混杂未控】饮食结构、抗抑郁药（尤其 SSRI）、糖皮质激素、IBD 活动度、吸烟都会同时影响菌群与胆汁酸谱，必须在纳排标准与分层因子中显式处理。',
    '【缺失数据与预注册】未说明缺失数据机制假设与敏感性分析方案；未见预注册计划，主要终点存在事后调整风险。',
  ],
  clinician: [
    '【人群异质性】克罗恩病与溃疡性结肠炎在免疫机制、治疗路径与微生态特征上差异显著，必须分层，否则组内变异会淹没干预效应。',
    '【终点选择】抑郁症状以主观量表为主，评估者盲法缺失会放大期望效应。建议同时设置客观指标（如血清次级胆汁酸变化、炎症标志物）并明确最小临床重要差异。',
    '【安全性】FMT 或活菌制剂在免疫抑制治疗人群中的感染风险需评估；次级胆汁酸干预的长期代谢影响未知，需设安全性终点与停药规则。',
    '【外推边界】结论只能外推到特定亚型、特定基线活动度与特定用药状态的患者。把结论写成适用于“IBD 患者整体”属于外推过宽。',
    '【伦理】抑郁症人群使用安慰剂对照需要额外论证（是否存在有效治疗被剥夺）；必须说明知情同意、心理支持与危机干预预案。',
  ],
  reviewer: [
    '【最可能被拒的理由】与已有菌群—肠脑轴研究相比，增量不清晰。若只是“再测一次菌群和胆汁酸”，审稿人会直接以缺乏新颖性拒稿。',
    '【可重复性】菌群测序存在批次效应，益生菌/FMT 制剂缺乏标准化（活菌数、菌株鉴定、批次一致性），这些都会导致结果无法独立重复。',
    '【结论与证据不匹配】把“相关性”表述为“通过胆汁酸改善”，属于结论超出数据支持范围。请在摘要与结论中把因果主张降级为待检验假说。',
    '【报告规范】干预性研究需按 CONSORT、观察性研究按 STROBE、动物实验按 ARRIVE 报告；摘要中应给出试验注册号。',
    '【未解决】如果你无法说明“为什么是这条中介通路而不是别的”，我将把这个争议标为 Open Issue 而不是接受你的解释。',
  ],
  innovation: {
    version: 2,
    assessments: Object.fromEntries(['novelty', 'increment', 'rigor', 'translatability', 'feasibility'].map(key => [key, {
      status: 'scored', reason: '离线演示固定样例，非真实评估结果。', confidence: 'low', evidence: ['模拟数据'], missingInformation: [],
    }])),
    novelty: 3,
    increment: 3,
    rigor: 2,
    translatability: 3,
    feasibility: 4,
    comments: '新颖性中等：菌群—胆汁酸—肠脑轴已有报道。增量取决于是否把“特定胆汁酸代谢物”确立为可测量的中介标志物，并按中介水平分层干预——若做到，新颖性与可转化性可各提升 1–2 分。当前设计严谨性偏低（无对照、终点主观、未做功效论证），是主要扣分项。',
    suggestions: [
      '把假设收窄为“某一类次级胆汁酸介导特定菌属对抑郁症状的效应”，使机制主张可证伪。',
      '改为两阶段设计：先做多组学中介分析确立中介链，再做按中介水平分层的随机对照验证干预。',
      '预设主要中介分子与分析计划并做预注册，把探索性分析明确标记为探索性。',
    ],
  },
  cross: [
    '回应统计学家：你指出单臂设计致命，我接受。补充一点——即使加了对照组，如果中介测量与结局测量不同期，中介分析的时序假设依然不成立，所以设计修改必须同时解决配对测量问题。',
    '回应科学家：反向因果的担忧成立，但可用纵向设计部分化解：在干预前设置 2 个时间点的基线测量，观察菌群—胆汁酸—症状三者的时间先后。',
    '回应临床专家：分层会显著增加样本量。我的建议是不要按 CD/UC 和基线 PHQ-9 双重分层，而是以基线抑郁程度为主要分层因子，把亚型作为协变量，避免样本量爆炸。',
    '回应审稿人：关于增量——把“菌群干预”改为“以胆汁酸中介水平分层的精准干预”，差异化就出现了，因为现有研究基本没有做分层富集。',
  ],
  moderator: {
    summary: '五方在“机制链缺环、无对照、终点主观、混杂未控”四点形成共识；在“是否必须做安慰剂对照”与“分层维度选择”上未完全收敛，保留为 Open Issue。',
    revisedProtocol: `【修正版研究方案（演示版）】

一、研究问题
在 IBD 合并轻中度抑郁症状的成人患者中，特定菌群调节干预能否通过改变血清次级胆汁酸谱，进而改善抑郁症状？——把因果主张收窄为可检验的中介假说。

二、总体设计（两阶段）
阶段 1（中介确立）：前瞻性纵向观察队列，干预前设 2 个时间点的基线测量，明确暴露—中介—结局的时序关系，用反事实框架估计自然间接效应。
阶段 2（干预验证）：随机、双盲、安慰剂对照试验，按基线抑郁程度分层，验证阶段 1 锁定的中介通路。

三、研究对象
成人 IBD（克罗恩病 / 溃疡性结肠炎）合并轻中度抑郁症状者；亚型作为协变量而非分层因子；抗抑郁药剂量需稳定 ≥ 8 周方可入组。

四、样本量
基于阶段 1 观测到的中介效应量重新估算；中介效应检验的样本量按检验间接效应的要求单独计算，不以总效应估算替代。

五、终点
共同主要终点：① 抑郁症状量表变化（预设最小临床重要差异）；② 血清次级胆汁酸谱变化。
次要终点：IBD 疾病活动度、炎症标志物、安全性指标。

六、统计分析
预设主要中介分子；多组学分析做多重比较校正（主要分析 + FDR 控制的次要分析）；缺失数据做机制假设与敏感性分析；全部分析计划在研究注册平台预注册。

七、混杂控制
饮食结构、抗抑郁药、糖皮质激素、IBD 活动度、吸烟在纳排标准与协变量中显式处理。

八、伦理与安全
伦理审查与知情同意；抑郁症人群安慰剂对照的额外论证；心理支持与危机干预预案；安全性监测与停药规则。

九、报告规范
干预部分按 CONSORT、观察部分按 STROBE 报告；摘要给出试验注册号。`,
    contentions: [
      { title: '单臂开放设计无法排除安慰剂效应、回归均值与自然波动', level: 'Critical', raisedBy: ['statistician', 'reviewer'], suggestion: '改为随机双盲安慰剂对照设计' },
      { title: '机制链条缺少“菌属改变→胆汁酸谱改变”的人体剂量—反应证据', level: 'Major', raisedBy: ['scientist'], suggestion: '增加中介变量的直接、纵向测量' },
      { title: '多组学特征未做多重比较校正，假阳性风险高', level: 'Major', raisedBy: ['statistician'], suggestion: '预设主要中介分子并对次要分析做 FDR 控制' },
      { title: '关键混杂（饮食、抗抑郁药、激素、疾病活动度、吸烟）未控制', level: 'Major', raisedBy: ['statistician', 'clinician'], suggestion: '纳入标准限制 + 协变量调整 + 敏感性分析' },
      { title: '抑郁终点主观且缺少评估者盲法，测量偏倚大', level: 'Major', raisedBy: ['clinician'], suggestion: '增设客观生物学共同主要终点' },
      { title: '结论外推过宽，未限定人群亚型与基线状态', level: 'Major', raisedBy: ['clinician'], suggestion: '明确外推边界与排除人群' },
      { title: '未说明伦理审查、知情同意与安全性监测', level: 'Critical', raisedBy: ['clinician', 'reviewer'], suggestion: '补充伦理与安全监测方案' },
      { title: '未预注册、分析计划不透明', level: 'Major', raisedBy: ['reviewer'], suggestion: '研究注册平台预注册并公开分析计划' },
      { title: '安慰剂对照在抑郁人群中的伦理可接受性存在分歧', level: 'Open Issue', raisedBy: ['clinician', 'reviewer'], suggestion: '保留双方立场：一方主张加用安慰剂对照以保证内部效度，另一方主张以活性对照降低伦理风险' },
    ],
    changeLog: [
      { originElement: '单臂干预 12 周，主要终点 PHQ-9', contention: 'C-01', revisedElement: '随机双盲安慰剂对照；共同主要终点为抑郁量表变化 + 血清次级胆汁酸变化；样本量按中介效应重新估算', rationale: '排除自然波动与安慰剂效应，并让终点可客观验证' },
      { originElement: '16S 单组学检测', contention: 'C-02/C-03', revisedElement: '增加靶向胆汁酸代谢组与宏基因组，采用反事实框架做中介分析，预设主要中介分子', rationale: '把“相关性”升级为可检验的中介链' },
      { originElement: '未控制抗抑郁药使用', contention: 'C-04', revisedElement: '纳入标准限制抗抑郁药剂量稳定 ≥ 8 周，并作为协变量与分层依据之一', rationale: '控制影响菌群与情绪评估的关键混杂' },
      { originElement: '直接外推到“IBD 患者”整体', contention: 'C-06', revisedElement: '结论限定于特定亚型、特定基线状态与特定用药人群', rationale: '避免外推过宽导致结论失效' },
      { originElement: '未提及伦理审查与知情同意', contention: 'C-07', revisedElement: '补充伦理审查、知情同意、心理支持与危机干预预案、安全性监测与停药规则', rationale: '合规必要前提，且涉及抑郁人群的特殊保护' },
    ],
  },
};

/** 判断是否命中演示案例，命中则用预置脚本，否则退化为通用模板 */
function isDemoCase(text = '') {
  return /菌群|胆汁酸|IBD|抑郁|肠道/.test(text);
}

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

function generic(role, hypothesis) {
  const name = { scientist: '科学家', statistician: '统计学家', clinician: '临床专家', reviewer: '审稿人' }[role] || '评审人';
  return `【${name}视角·演示模式】当前处于 mock 离线模式，未调用真实模型。针对假设“${hypothesis}”，本角色会从${
    { scientist: '机制合理性与因果链完整性', statistician: '设计类型、功效计算与混杂控制', clinician: '人群代表性、终点临床意义与伦理边界', reviewer: '致命缺陷、可重复性与增量贡献' }[role]
  }三个角度提出质疑，并要求给出可追溯的证据或明确标注为推断。配置 DEEPSEEK_API_KEY 后可获得针对本假设的真实评审意见。`;
}

const state = { counter: 0 };

/**
 * mock 的发言也要带上证据标注，否则"诚实披露"面板全是 0，
 * 演示时反而看不出这个机制在起作用。
 */
const FOOTNOTE_MODEL = '\n\n【依据】以上判断基于本领域通行认识【模型知识】，未引用具体文献，请结合专业判断使用。';
const FOOTNOTE_INFERENCE = '\n\n【依据】上述链路推断【推断】，需要补充直接证据后才能作为设计依据。';

/**
 * 角色由引擎显式传入（meta.agentId / meta.task），不靠正则猜系统提示词——
 * 猜法太脆，一旦提示词里提到别的角色就会串味。
 */
async function chat({ system = '', user = '', meta = {} } = {}) {
  await sleep(320 + Math.random() * 260);
  const { task, agentId } = meta;
  const hypothesis = user.match(/假设[：:]\s*([^\n]+)/)?.[1] ?? user.slice(0, 60);
  const demo = isDemoCase(user);

  let content;
  if (task === 'hypothesis') {
    content = JSON.stringify(SCRIPT.normalize);
  } else if (task === 'evidence') {
    content = JSON.stringify(SCRIPT.evidence);
  } else if (task === 'scorecard' || agentId === 'innovator') {
    content = JSON.stringify(SCRIPT.innovation);
  } else if (agentId === 'moderator' || task === 'moderator') {
    content = JSON.stringify(SCRIPT.moderator);
  } else if (agentId === 'scientist') {
    content = (demo ? SCRIPT.scientist.join('\n') : generic('scientist', hypothesis)) + FOOTNOTE_INFERENCE;
  } else if (agentId === 'statistician') {
    content = (demo ? SCRIPT.statistician.join('\n') : generic('statistician', hypothesis)) + FOOTNOTE_MODEL;
  } else if (agentId === 'clinician') {
    content = (demo ? SCRIPT.clinician.join('\n') : generic('clinician', hypothesis)) + FOOTNOTE_MODEL;
  } else if (agentId === 'reviewer') {
    content = (demo ? SCRIPT.reviewer.join('\n') : generic('reviewer', hypothesis)) + FOOTNOTE_MODEL;
  } else {
    content = (demo ? pick(SCRIPT.cross, state.counter++) : generic('reviewer', hypothesis)) + FOOTNOTE_MODEL;
  }

  return {
    content,
    reasoning: '',
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, mock: true },
    model: 'mock',
    finishReason: 'stop',
  };
}

async function* stream(opts) {
  const { content, reasoning } = await chat(opts);
  if (reasoning) yield { type: 'reasoning', text: reasoning };
  // 按 ~24 字切块，模拟真实流式观感
  for (let i = 0; i < content.length; i += 24) {
    yield { type: 'content', text: content.slice(i, i + 24) };
    await sleep(28);
  }
}

export const mockProvider = {
  name: 'mock',
  label: 'Mock 离线干跑',
  chat,
  stream,
  model: () => 'mock',
};
