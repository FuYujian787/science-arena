#!/usr/bin/env node
/**
 * 轻量单元测试（零依赖）。
 *
 * 覆盖的都是"实测踩过坑"的地方——这些坑在真实模型输出下会静默产生错误结果，
 * 不写测试根本发现不了：
 *   1. extractJson 遇到裸数组时被切成单个对象 → 证据卡全丢
 *   2. 致命争议覆盖率用关键词匹配 → 顿号截断导致假阴性
 *   3. 评分卡 JSON 被代码围栏包裹 / 字段缺失
 *   4. 主持人输出字段类型不规范
 *
 * 用法：node tools/test.mjs
 */
import { extractJson } from '../src/lib/util.mjs';
import {
  parseScorecard,
  parseModeratorOutput,
  checkCriticalCoverage,
  computeTotal,
  RUBRIC,
} from '../src/engine/synthesize.mjs';
import { toDocx } from '../src/export/docx.mjs';
import zlib from 'node:zlib';
import { normalizeScorecard, computeInnovation, validScore } from '../public/scoring.mjs';
import { toMarkdown, toHtml } from '../src/export/report.mjs';
import { normalizeHypothesis } from '../src/engine/hypothesis.mjs';
import { userContext, anchorChanges } from '../src/engine/provenance.mjs';
import { retrieveEvidence } from '../src/engine/evidence.mjs';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}\n      期望 ${e}\n      实际 ${a}`);
  }
}

function checkTrue(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const TICK = String.fromCharCode(96); // 反引号
const FENCE = TICK + TICK + TICK;

console.log('\nextractJson —— 容错解析');
check('裸数组保持为数组', Array.isArray(extractJson('[{"a":1},{"a":2}]')), true);
check(
  '带 items 的对象',
  extractJson('{"items":[{"a":1}],"coverage":"x"}').items.length,
  1,
);
check('代码围栏包裹的对象', extractJson(`${FENCE}json\n{"novelty":3}\n${FENCE}`).novelty, 3);
check('前后有解释文字', extractJson('结果如下：\n{"novelty":3}\n以上。').novelty, 3);
check('围栏包裹的数组', Array.isArray(extractJson(`${FENCE}json\n[{"sourceType":"A"}]\n${FENCE}`)), true);
check('嵌套对象不被截断', extractJson('{"a":{"b":{"c":1}},"d":2}').a.b.c, 1);
check('字符串里的括号不干扰', extractJson('{"note":"含有 } 和 { 的文本","v":1}').v, 1);
check('无法解析返回 null', extractJson('完全没有 JSON'), null);

console.log('\nparseScorecard —— 评分卡解析');
const sc = parseScorecard(
  `${FENCE}json\n${JSON.stringify({novelty:4,increment:3,rigor:2,translatability:3,feasibility:5,comments:'ok',suggestions:['a','b'],assessments:Object.fromEntries(RUBRIC.map(d=>[d.key,{status:'scored',reason:'测试中的具体评分依据',confidence:'low'}]))})}\n${FENCE}`,
);
check('各维度取值', [sc.novelty, sc.increment, sc.rigor, sc.translatability, sc.feasibility], [4, 3, 2, 3, 5]);
check('加权总分（一位小数）', sc.total, 3.3);
check('未标记为不完整', sc.incomplete, undefined);
check('建议列表', sc.suggestions.length, 2);
check('中文档位等级被归一到英文', parseModeratorOutput('{"contentions":[{"title":"x","level":"致命"}]}').contentions[0].level, 'Critical');
check('越界分数不伪装成有效5分', parseScorecard('{"novelty":9}').novelty, null);
check('缺失维度标记为不完整', parseScorecard('{"novelty":3}').incomplete, true);
check('缺项不归一伪装完整总分', computeTotal({ novelty: 3 }), null);
check('null不转成1分', validScore(null), null);
check('空串不转成1分', validScore(''), null);
check('布尔不转成1分', validScore(true), null);
check('NaN不污染总分', computeTotal({...sc, rigor:NaN}), null);
check('数值字符串可解析', validScore(' 3.5 '), 3.5);
check('创新潜力独立于严谨性', computeInnovation(sc), 3.5);
const uncertain = normalizeScorecard({...sc, assessments:{...sc.assessments,rigor:{status:'insufficient',reason:'仅有假说，未提供设计',missingInformation:['研究设计']}}});
check('待评估覆盖模型强填数字', uncertain.rigor, null);
check('待评估不产生综合分', uncertain.total, null);
check('其他完整创新维度仍可单独计算', uncertain.innovationTotal, 3.5);
check('缺少逐维理由不能接受数字', parseScorecard('{"novelty":5}').novelty, null);
check('缺失信息保留', uncertain.assessments.rigor.missingInformation, ['研究设计']);
check('不允许高确定性初评', normalizeScorecard({...sc,assessments:{...sc.assessments,novelty:{status:'scored',reason:'有限比较',confidence:'high'}}}).assessments.novelty.confidence, 'low');

console.log('\nparseModeratorOutput —— 主持人输出');
const mod = parseModeratorOutput(
  JSON.stringify({
    summary: '总结',
    contentions: [
      { title: '次要问题', level: 'Minor', raisedBy: ['scientist'], suggestion: 's' },
      { title: '致命问题', level: 'Critical', raisedBy: ['reviewer', '伪造角色'], suggestion: 's' },
      { title: '分歧', level: 'Open Issue', raisedBy: ['clinician'], suggestion: 's' },
    ],
    changeLog: [{ originElement: 'a', contention: 'b', revisedElement: 'c', rationale: 'd' }],
    revisedProtocol: '方案全文',
  }),
);
check('按等级排序（致命在前，次要在后）', mod.contentions.map((c) => c.level), ['Critical', 'Open Issue', 'Minor']);
check('非法 raisedBy 被过滤', mod.contentions[0].raisedBy, ['reviewer']);
check('编号自动生成', mod.contentions[0].id, 'C-01');
check('修改对照表', mod.changeLog.length, 1);
check('方案全文', mod.revisedProtocol, '方案全文');

console.log('\ncheckCriticalCoverage —— 致命争议覆盖率');
// 这个用例就是当时的假阴性：标题含顿号，关键词匹配会断裂
const contentions = [
  { id: 'C-01', level: 'Critical', title: '单臂开放设计无法排除安慰剂效应、回归均值与自然波动' },
  { id: 'C-02', level: 'Critical', title: '未说明伦理审查、知情同意与安全性监测' },
  { id: 'C-03', level: 'Major', title: '次要问题' },
];
const changeLog = [
  {
    originElement: '单臂干预 12 周',
    contention: 'C-01',
    revisedElement: '改为随机双盲安慰剂对照设计',
    rationale: '排除自然波动与安慰剂效应',
  },
  {
    originElement: '未提及伦理',
    contention: '',
    revisedElement: '补充伦理审查、知情同意、心理支持与安全性监测方案',
    rationale: '合规必要前提',
  },
];
const cov = checkCriticalCoverage(contentions, changeLog);
check('只统计致命级', cov.total, 2);
check('全部覆盖（含顿号标题）', cov.covered, 2);
check('覆盖率', cov.ratio, 1);
check('未覆盖列表为空', cov.uncovered, []);
checkTrue('编号引用被识别', cov.details[0].byId === true);
checkTrue('无编号时靠相似度识别', cov.details[1].similarity > 0.16, `sim=${cov.details[1].similarity}`);

const cov2 = checkCriticalCoverage(
  [{ id: 'C-01', level: 'Critical', title: '样本量完全没有做功效计算' }],
  [{ originElement: 'x', contention: '', revisedElement: '调整随访频次', rationale: 'y' }],
);
check('真正未覆盖时能识别', cov2.uncovered, ['C-01']);

// 真实场景：主持人被要求"去重合并"，一条修改对照会同时回应多条争议，
// 此时整条标题的 Dice 会偏低，必须靠子句包含度兜住。
const mergedLog = [
  {
    originElement: '「通过胆汁酸」的中介主张',
    contention: '胆汁酸中介的方向与测量层次未定义，导致主张不可证伪；机制主张缺人体可证伪判据',
    revisedElement: '中介降为探索性，标题与摘要删除因果措辞',
    rationale: '不可证伪的主张不应写进标题',
  },
];
const merged = checkCriticalCoverage(
  [{ id: 'C-05', level: 'Critical', title: '机制主张缺人体可证伪判据：剂量梯度被判无效，效应修饰交互检验功效不足' }],
  mergedLog,
);
check('合并写作的长标题仍被判为已覆盖', merged.covered, 1);
checkTrue(
  '其 Dice 确实低于阈值（说明是子句信号救回来的）',
  merged.details[0].similarity < 0.42,
  `dice=${merged.details[0].similarity}`,
);
checkTrue('子句包含度高于阈值', merged.details[0].clauseCoverage >= 0.5, `clause=${merged.details[0].clauseCoverage}`);

const notCovered = checkCriticalCoverage(
  [{ id: 'C-99', level: 'Critical', title: '作者利益冲突声明缺失且数据可得性未说明' }],
  mergedLog,
);
check('无关内容不会被子句信号误判为覆盖', notCovered.covered, 0);

console.log('\ntoDocx —— 手写 ZIP + OOXML');
/** 极简 ZIP 读取：只认本地文件头 + deflate/store，够用来断言内容 */
function unzip(buf) {
  const out = {};
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
    const dataStart = p + 30 + nameLen + extraLen;
    const payload = buf.slice(dataStart, dataStart + size);
    out[name] = method === 8 ? zlib.inflateRawSync(payload) : payload;
    p = dataStart + size;
  }
  return out;
}

const sampleSession = {
  id: 'arena_test',
  createdAt: '2026-01-01T00:00:00.000Z',
  rawText: '某种菌群能否通过胆汁酸改善IBD抑郁共病',
  hypothesis: { name: '测试', subject: '菌群', intervention: '益生菌', mediator: '胆汁酸', outcome: '抑郁', population: '患者', studyType: '待定', ambiguities: ['未具体化'] },
  evidence: [{ id: 'E-01', sourceType: '方法学资料', sourceRef: '【模型知识】X', summary: '要点 <含尖括号>', relevance: '关联', confidence: 'high' }],
  messages: [{ id: 'm1', agentId: 'scientist', agentName: '科学家', color: '#123', stage: 'S1', round: null, content: '含特殊字符 & < > " 的发言', absent: false, elapsedMs: 1200 }],
  contentions: [{ id: 'C-01', title: '争议点', level: 'Critical', raisedBy: ['scientist'], suggestion: '建议' }],
  changeLog: [{ id: 'L-01', originElement: '原', contention: 'C-01', revisedElement: '改', rationale: '理由' }],
  scorecard: { novelty: 3, increment: 3, rigor: 2, translatability: 3, feasibility: 4, total: 3, comments: '总评', suggestions: ['建议一'] },
  revisedProtocol: '修正版方案全文',
  summary: '总结',
  inferenceStats: { evidenceCount: 1, citationMarks: 2, knowledgeMarks: 3, inferenceMarks: 4 },
};

const docx = toDocx(sampleSession, RUBRIC);
checkTrue('输出是 Buffer', Buffer.isBuffer(docx));
checkTrue('是合法 ZIP（PK\\x03\\x04）', docx.readUInt32LE(0) === 0x04034b50);
checkTrue('以中央目录结束记录收尾', docx.readUInt32LE(docx.length - 22) === 0x06054b50);

const parts = unzip(docx);
checkTrue('包含 [Content_Types].xml', !!parts['[Content_Types].xml']);
checkTrue('包含 _rels/.rels', !!parts['_rels/.rels']);
checkTrue('包含 word/document.xml', !!parts['word/document.xml']);
checkTrue('包含 word/styles.xml', !!parts['word/styles.xml']);
checkTrue('包含 word/_rels/document.xml.rels', !!parts['word/_rels/document.xml.rels']);

const docXml = parts['word/document.xml'].toString('utf8');
const stylesXml = parts['word/styles.xml'].toString('utf8');
checkTrue('document.xml 是合法 XML 头', docXml.startsWith('<?xml'));
checkTrue('含 w:document 根节点', docXml.includes('<w:document'));
checkTrue('含 sectPr 页面设置', docXml.includes('<w:sectPr>'));
checkTrue('特殊字符已转义', docXml.includes('&amp;') && docXml.includes('&lt;') && docXml.includes('&gt;'));
checkTrue('未出现未转义裸尖括号', !/发言/.test(docXml) || !docXml.includes('<含尖括号>'));
checkTrue('标题段落存在', docXml.includes('Science Arena'));
checkTrue('争议清单表头存在', docXml.includes('争议点'));
checkTrue('表格有表头重复设置', docXml.includes('<w:tblHeader/>'));
checkTrue('中文字体已设 eastAsia', docXml.includes('w:eastAsia="宋体"'));
checkTrue('Normal 样式标了 default', stylesXml.includes('w:default="1"'));
checkTrue('引用了 Normal 之外的样式', stylesXml.includes('w:styleId="Heading1"'));

// 空会话不能崩（新建但没跑完的会话也要能导出）
const emptyDocx = toDocx({ id: 'x', createdAt: new Date().toISOString(), rawText: '', messages: [] }, RUBRIC);
const newScoreDocx = toDocx({...sampleSession, scorecard:uncertain}, RUBRIC);
checkTrue('新版待评估评分也能导出Word', Buffer.isBuffer(newScoreDocx) && newScoreDocx.length > 0);
const scoreMd = toMarkdown({...sampleSession, scorecard:uncertain});
checkTrue('Markdown导出保留待评估和独立创新分', scoreMd.includes('待评估') && scoreMd.includes('创新潜力') && scoreMd.includes('仅有假说'));
checkTrue('HTML导出声明初评范围', toHtml({...sampleSession,scorecard:uncertain}).includes('非论文质量或录用预测'));
checkTrue('旧版导出标明不按新规则倒算', toMarkdown(sampleSession).includes('旧版评分记录'));
checkTrue('空会话也能生成文档', Buffer.isBuffer(emptyDocx) && emptyDocx.length > 500);

console.log('\ndifySelftest —— 配置自检（离线分支）');
const { selftest: difySelftest } = await import('../src/llm/dify.mjs');
const { config } = await import('../src/config.mjs');
const st = await difySelftest({ dryRun: true });
checkTrue('返回 ok 字段', typeof st.ok === 'boolean');
checkTrue('返回步骤列表', Array.isArray(st.steps) && st.steps.length > 0);
checkTrue(
  '每步都带 name/ok/detail',
  st.steps.every((s) => typeof s.name === 'string' && typeof s.ok === 'boolean' && typeof s.detail === 'string'),
);
if (!config.dify.appKey) {
  checkTrue('未配置 Key 时给出可执行指引', st.ok === false && /app-/.test(st.hint || ''));
} else {
  console.log('  · 已配置 DIFY_APP_KEY，跳过"未配置"分支断言（避免测试触发真实网络请求）');
}

console.log('\nclassifyDifyError —— 把 Dify 报错翻译成该改什么');
const { classifyDifyError } = await import('../src/llm/dify.mjs');

// 这是现场真实撞到的错误：工作流跑通了，但它调模型时供应商拒绝鉴权
const realErr =
  '[models] Error: API request failed with status code 401: {"error":{"message":"Authentication Fails, Your api key: ****6501 is invalid","type":"authentication_error"}}';
const c1 = classifyDifyError(realErr);
check('供应商密钥失效被识别', c1.kind, 'provider-key');
checkTrue('提示指向「模型供应商」而不是「选模型」', /模型供应商/.test(c1.hint));
checkTrue('从错误里提取出密钥尾号', /6501/.test(c1.hint));
checkTrue('给出两条可执行的修法', /A\./.test(c1.hint) && /B\./.test(c1.hint));

check('模型不存在被单独识别', classifyDifyError('Model not found in provider').kind, 'model-missing');
check('限流被识别', classifyDifyError('rate limit exceeded, 429').kind, 'rate-limit');
check('超时被识别', classifyDifyError('Request timed out after 30s').kind, 'timeout');
check('未知错误兜底', classifyDifyError('something odd happened').kind, 'unknown');
check('空消息不崩', classifyDifyError('').kind, 'unknown');
check('非字符串输入不崩', classifyDifyError(undefined).kind, 'unknown');

console.log('\nsplitThink —— 剥离 Dify 的 <think> 推理段');
const { splitThink } = await import('../src/llm/dify.mjs');

// 现场真实返回的长这样（推理里带一个 Dify 特有的 HTML 注释标记）
const realDify = '<think>\n<!--dify-deepseek-reasoning-->我们需要回答中文，只输出一句质疑。\n</think>单臂设计无法排除安慰剂效应。';
const sp1 = splitThink(realDify);
check('正文与推理被切开', [sp1.content, sp1.reasoning], ['单臂设计无法排除安慰剂效应。', '我们需要回答中文，只输出一句质疑。']);
checkTrue('正文里没有 think 标记残留', !/<\/?think>|dify-deepseek-reasoning/.test(sp1.content));

const sp2 = splitThink('没有推理标签的普通回答');
check('无标签时原样返回正文', sp2.content, '没有推理标签的普通回答');
check('无标签时推理为空', sp2.reasoning, '');

const sp3 = splitThink('<think>只有开标签没有闭标签');
check('缺闭标签时整段归推理', sp3.reasoning, '只有开标签没有闭标签');
check('缺闭标签时正文为空', sp3.content, '');

check('空输入不崩', splitThink('').content, '');
check('undefined 不崩', splitThink(undefined).content, '');
check('只有标记没有内容时正文为空', splitThink('<think><!--dify-deepseek-reasoning--></think>').content, '');

console.log('\nrepairJson —— 抢救被截断的 JSON');
const { repairJson } = await import('../src/lib/util.mjs');

// 真实场景：主持人输出到一半被 token 上限切断
const truncated = `{"summary":"共识与分歧","contentions":[{"title":"单臂设计无法排除安慰剂","level":"Critical","raisedBy":["statistician"]},{"title":"未说明伦理审查","level":"Critical","raisedBy":["clini`;
const salvaged = repairJson(truncated);
checkTrue('截断的 JSON 能被救回来', salvaged !== null);
// 被截断的第二条补齐引号后也是合法对象，标题与等级完整，
// 只有被切断的 raisedBy 不可用（后续解析会过滤掉非法角色名）。
// 能多救一条就是多一条，总比整份丢掉强。
check('抢回的条目数', salvaged?.contentions?.length, 2);
check('已完成的字段内容正确', salvaged?.contentions?.[0]?.level, 'Critical');
check('截断条目仍保留了标题', salvaged?.contentions?.[1]?.title, '未说明伦理审查');
check('非 JSON 文本返回 null', repairJson('完全没有 JSON'), null);

// 截在数组中间
const cutArray = '{"changeLog":[{"originElement":"a","revisedElement":"b"},{"originElement":"c","revi';
const salvaged2 = repairJson(cutArray);
checkTrue('截在数组中间也能救', salvaged2 !== null);
check('数组里完成的条目保留', salvaged2?.changeLog?.length, 2);

console.log('\nparseRecords —— PubMed 纯文本摘要解析');
const { parseRecords } = await import('../src/engine/retriever/pubmed.mjs');

// 真实返回的两个坑：期刊引用跨行、DOI 后面跟句号
const SAMPLE = `1. Transl Psychiatry. 2024 Dec 24;14(1):511. doi: 10.1038/s41398-024-03211-4.

Gut microbiota dysbiosis promotes cognitive impairment via bile acid metabolism.

Zhang Y, Li H, Wang Q.

BACKGROUND: Short-chain and bile acid metabolism have been implicated.
RESULTS: The authors found a significant association.

PMID: 39719433

2. mSystems. 2024 Feb 8:e0129923. doi: 10.1128/msystems.01299-23.

The function of the gut microbiota-bile acid-TGR5 axis.

Chen L.

Abstract text here.

PMID: 38329942`;

const recs = parseRecords(SAMPLE, ['39719433', '38329942']);
check('解析出 2 条记录', recs.length, 2);
check('第一条标题正确', recs[0].title, 'Gut microbiota dysbiosis promotes cognitive impairment via bile acid metabolism.');
check('第一条 PMID 正确', recs[0].pmid, '39719433');
check('第一条年份正确', recs[0].year, '2024');
check('第一条期刊正确', recs[0].journal, 'Transl Psychiatry');
check('DOI 尾部句号被剥掉', recs[0].doi, '10.1038/s41398-024-03211-4');
// 这条的期刊引用跨了行，早期版本会把标题解析成 "Feb 8."
check('跨行引用的标题不再被吞掉', recs[1].title, 'The function of the gut microbiota-bile acid-TGR5 axis.');
check('第二条期刊正确', recs[1].journal, 'mSystems');
check('第二条 DOI 正确', recs[1].doi, '10.1128/msystems.01299-23');
checkTrue('摘要取的是最长段而不是标题', recs[0].abstract.includes('bile acid metabolism'), recs[0].abstract.slice(0, 40));

console.log('\n检索器注册表');
const { getRetriever } = await import('../src/engine/retriever/index.mjs');
check('pubmed 可取', getRetriever('pubmed').name, 'pubmed');
check('none 可取', getRetriever('none').name, 'none');
check('未知名字回退到 none（不会意外联网）', getRetriever('cnki').name, 'none');

console.log('\n材料锚点、解析重试与检索筛选');
const material = '【已完成的研究】\n1. 已使用三队列完成前瞻性分析。\n【本轮焦点】\n六蛋白是否反映临床前状态？\n\n请围绕该点讨论';
const uc = userContext(material, ['作者使用了保险理赔数据。'], '不存在的焦点');
check('原文事实自动摘录', uc.userFacts.map(f=>f.quote), ['已使用三队列完成前瞻性分析。']);
check('本轮焦点单独提取', uc.focus, '六蛋白是否反映临床前状态？');
const anchors = anchorChanges([{originElement:'原研究分母错误',originQuote:'作者使用了保险理赔数据。'}, {originElement:'任意改写',originQuote:'已使用三队列完成前瞻性分析。'}], material);
check('捏造原方案被降为待核查', anchors[0].originAnchored, false);
checkTrue('未锚定判断不显示为原方案', !anchors[0].originElement.includes('分母错误'));
check('有效锚点使用用户原文', anchors[1].originElement, '已使用三队列完成前瞻性分析。');
let parseCalls = 0;
const hypo = await normalizeHypothesis({rawText:material,provider:{chat:async()=>({content:++parseCalls===1 ? '' : JSON.stringify({subject:'成人',intervention:'夜班',outcome:'IBD',providedFacts:['作者使用保险理赔数据。']}),usage:{},model:'test'})}});
check('空输出提高预算重试', parseCalls, 2);
check('重试成功状态正确', hypo.parseStatus, 'ok');
check('解析后不纳入捏造的事实', hypo.userFacts.length, 1);
let emptyCalls=0;
const emptyHypo=await normalizeHypothesis({rawText:'长期夜班与炎症性肠病风险',provider:{chat:async()=>{emptyCalls++;return {content:'[]'};}}});
check('持续失败不无限重试', emptyCalls, 2);
check('解析失败显式标记', emptyHypo.parseStatus, 'fallback');
const calls=[];
const record=(name)=>({pmid:name,title:name,abstract:'Abstract',journal:'Test',year:'2026',url:'https://pubmed.ncbi.nlm.nih.gov/1/'});
const testProvider={chat:async({meta,user})=>({content:JSON.stringify(meta.task==='rag-query'
  ? {query:'narrow question',fallbackQueries:['broad question']}
  : meta.task==='rag-annotate'
    ? {items:[{i:0,relevance:'相关性说明',confidence:'medium',relevanceLevel:user.includes('unrelated-record')?'irrelevant':'indirect'}]}
    : {items:[{summary:'仅供核查的一般方法提示',sourceRef:'方法',confidence:'high'}]})})};
const evidenceResult=await retrieveEvidence({provider:testProvider,cardText:'研究背景',rag:{provider:'pubmed'},retriever:{retrieve:async({query})=>{calls.push(query);return {ok:true,total:1,items:[record(query.startsWith('narrow')?'unrelated-record':'related-record')]};}}});
check('首轮不相关时使用备选检索式', calls, ['narrow question','broad question']);
check('不相关条目不作为评审依据', evidenceResult.items.map(e=>e.title), ['related-record']);
check('排除理由保留便于复核', evidenceResult.rag.excludedRecords.length, 1);
check('每次查询均记录', evidenceResult.rag.attempts.length, 2);
const failedEvidence=await retrieveEvidence({provider:testProvider,cardText:'研究背景',rag:{provider:'pubmed'},retriever:{retrieve:async()=>({ok:true,total:1,items:[record('unrelated-record')]})}});
check('全不相关时显式无匹配证据', failedEvidence.rag.searchStatus, 'no_usable_evidence');
check('回退仍保留检索式', failedEvidence.rag.query, 'broad question');
check('模型概述不允许自评高把握', failedEvidence.items[0].confidence, 'low');
check('模型概述来源显式区分', failedEvidence.items[0].evidenceStatus, 'unverified_model_generated');
checkTrue('回退不推断领域缺乏证据', failedEvidence.coverage.includes('不能据此判断'));
console.log(`\n${failed === 0 ? '通过' : '失败'}：${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
