/**
 * 零依赖 DOCX 导出。
 *
 * 为什么手写：DOCX 本质上就是一个 ZIP + 几个 XML。
 * 引入 npm 包会破坏"零依赖"这条比赛现场的生命线，而 shell 出去调用
 * python-docx 又会把服务绑死在这台机器上。手写的代价是约 200 行，
 * 换来的是 `node server.mjs` 在任何有 Node 的机器上都能导出 Word。
 *
 * 验证方式（不是靠"看起来对"）：用 python-docx 反向解析、再用 LibreOffice 渲染成图。
 */
import zlib from 'node:zlib';
import { checkCriticalCoverage } from '../engine/synthesize.mjs';
import { scorecardNotice, assessmentText } from '../../public/scoring.mjs';

/* ============================================================
   ZIP 容器
   ============================================================ */

function crc32(buf) {
  return zlib.crc32(buf) >>> 0;
}

/**
 * 写一个最小但完全合规的 ZIP。
 * 优先用 deflate（体积小），压不动时退回 store（不压缩）。
 */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const crc = crc32(data);

    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    parts.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cd.writeUInt16LE(20, 4); // 创建版本
    cd.writeUInt16LE(20, 6); // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // 扩展字段
    cd.writeUInt16LE(0, 32); // 注释
    cd.writeUInt16LE(0, 34); // 起始磁盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // 注释长度

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/* ============================================================
   OOXML 片段
   ============================================================ */

const E = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Word 里必须剔除的控制字符，否则文档会报"内容有问题"
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** 中文字体必须同时设 ascii/hAnsi/eastAsia，否则中文会掉字 */
function runProps({ bold, italic, size, color, mono } = {}) {
  const parts = [];
  const fonts = mono
    ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体"/>'
    : '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>';
  parts.push(fonts);
  if (bold) parts.push('<w:b/>');
  if (italic) parts.push('<w:i/>');
  if (color) parts.push(`<w:color w:val="${color}"/>`);
  if (size) parts.push(`<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>`);
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

function run(text, opts = {}) {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<w:r>${runProps(opts)}<w:t${preserve}>${E(text)}</w:t></w:r>`;
}

function para(text, { style, align, size, bold, color, italic, mono, before, after, indent } = {}) {
  const pPr = [];
  if (style) pPr.push(`<w:pStyle w:val="${style}"/>`);
  if (align) pPr.push(`<w:jc w:val="${align}"/>`);
  if (before != null || after != null) {
    pPr.push(`<w:spacing${before != null ? ` w:before="${before}"` : ''}${after != null ? ` w:after="${after}"` : ''}/>`);
  }
  if (indent != null) pPr.push(`<w:ind w:left="${indent}"/>`);
  const runs = String(text ?? '')
    .split('\n')
    .flatMap((line, i) => (i === 0 ? [run(line, { bold, size, color, italic, mono })] : ['<w:br/>', run(line, { bold, size, color, italic, mono })]))
    .join('');
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runs}</w:p>`;
}

/** 表格：borders 全框线，首行加底纹 */
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const grid = widths.map((w) => `<w:gridCol w:w="${Math.round((w / total) * 9000)}"/>`).join('');

  const cell = (content, { bold, bg, size = 9 } = {}) => {
    const shd = bg ? `<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>` : '';
    const paras = String(content ?? '')
      .split('\n')
      .map((line) => para(line, { size: size, bold }))
      .join('');
    return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shd}<w:vAlign w:val="top"/></w:tcPr>${paras}</w:tc>`;
  };

  const border =
    '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('') +
    '</w:tblBorders>';

  const headRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headers.map((h) => cell(h, { bold: true, bg: 'EEF3FB' })).join('')}</w:tr>`;
  const bodyRows = rows.map((r) => `<w:tr>${r.map((c) => cell(c)).join('')}</w:tr>`).join('');

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${border}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${headRow}${bodyRows}</w:tbl>` +
    para('', { after: 120 })
  );
}

/* ============================================================
   文档装配
   ============================================================ */

function stylesXml() {
  const s = (id, name, opts) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:qFormat/>${opts}</w:style>`;
  return (
    XML_HEAD +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    // w:default="1" 不能省：否则没有显式 pStyle 的段落解析不到默认样式
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    s('Title', 'Title', '<w:pPr><w:spacing w:before="240" w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/><w:color w:val="1F3864"/></w:rPr>') +
    s('Heading1', 'heading 1', '<w:pPr><w:spacing w:before="320" w:after="140"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:color w:val="1F3864"/></w:rPr>') +
    s('Heading2', 'heading 2', '<w:pPr><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="2E5C9A"/></w:rPr>') +
    s('Heading3', 'heading 3', '<w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr>') +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:ind w:left="240"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="8EAADB"/></w:pBdr></w:pPr>' +
    '<w:rPr><w:color w:val="595959"/></w:rPr></w:style>' +
    '</w:styles>'
  );
}

const LEVEL_CN = { Critical: '致命', Major: '重要', Minor: '次要', 'Open Issue': '未解决' };

/**
 * 把一个会话渲染成 Word 文档。
 * 章节顺序与 HTML / Markdown 导出保持一致，保证三份产出对得上。
 */
export function toDocx(session, rubric = []) {
  const h = session.hypothesis || {};
  const body = [];

  body.push(para('Science Arena 评审报告', { style: 'Title', align: 'center' }));
  body.push(para('多智能体科研假说辩论与方案修正平台', { align: 'center', size: 11, color: '595959' }));
  const realEvidence = (session.evidence || []).filter((e) => e.modelKnowledge === false).length;
  const totalEvidence = (session.evidence || []).length;
  body.push(
    para(
      '本内容为科研方案辅助建议，由多智能体辩论系统生成，不替代导师指导、伦理审查与临床决策。' +
        (realEvidence
          ? `其中 ${realEvidence}/${totalEvidence} 条证据来自 PubMed 真实检索（附 PMID，可核对原文），其余来自模型知识并已逐条标注。`
          : '本次未取得真实文献检索结果，全部证据来自模型知识，已逐条标注【模型知识】。'),
      { style: 'Quote', size: 9 },
    ),
  );

  body.push(para('研究假设', { style: 'Heading1' }));
  body.push(para(session.rawText || '', { size: 11, bold: true }));

  body.push(para('一、假设卡', { style: 'Heading1' }));
  body.push(
    table(
      ['要素', '内容'],
      [
        ['研究对象', h.subject || ''],
        ['干预 / 暴露', h.intervention || ''],
        ['中介变量', h.mediator || '（未指定）'],
        ['结局指标', h.outcome || ''],
        ['目标人群', h.population || ''],
        ['研究类型', h.studyType || ''],
      ],
      [18, 82],
    ),
  );
  if (h.ambiguities?.length) {
    body.push(para(`歧义提示：${h.ambiguities.join('；')}`, { size: 9, color: 'B54708' }));
  }

  if (session.summary) {
    body.push(para('二、主持人总结', { style: 'Heading1' }));
    body.push(para(session.summary, { size: 10.5 }));
  }

  body.push(para('三、争议清单', { style: 'Heading1' }));
  if (session.contentions?.length) {
    body.push(
      table(
        ['编号', '争议点', '等级', '提出者', '建议修改'],
        session.contentions.map((c) => [
          c.id,
          c.title,
          LEVEL_CN[c.level] || c.level,
          (c.raisedBy || []).join('、') || '—',
          c.suggestion || '—',
        ]),
        [6, 34, 8, 14, 38],
      ),
    );
  } else {
    body.push(para('未生成争议清单。', { size: 10, color: '808080' }));
  }

  body.push(para('四、创新性评分卡', { style: 'Heading1' }));
  if (session.scorecard) {
    const sc = session.scorecard;
    body.push(para(scorecardNotice(sc), { size: 10 }));
    const dims = rubric.length
      ? rubric
      : [
          { key: 'novelty', label: '新颖性', weight: 0.3 },
          { key: 'increment', label: '增量贡献', weight: 0.25 },
          { key: 'rigor', label: '方法严谨性', weight: 0.2 },
          { key: 'translatability', label: '可转化性', weight: 0.15 },
          { key: 'feasibility', label: '可行性', weight: 0.1 },
        ];
    body.push(
      table(
        ['维度', '权重', '得分', '评分含义'],
        [
          ...dims.map((d) => [d.label, `${d.weight * 100}%`, String(sc[d.key] ?? '待评估'), assessmentText(sc, d.key) || d.anchor || '']),
          [sc.version === 2 ? '综合初评' : '旧版加权总分', '100%', String(sc.total ?? '待评估'), ''],
        ],
        [16, 10, 10, 64],
      ),
    );
    if (sc.version === 2) body.push(para(`创新潜力（新颖性与增量贡献）：${sc.innovationTotal ?? '待评估'} / 5`, { size: 10 }));
    if (sc.comments) body.push(para(sc.comments, { size: 10 }));
    if (sc.suggestions?.length) {
      body.push(para('提升路径', { style: 'Heading3' }));
      sc.suggestions.forEach((s, i) => body.push(para(`${i + 1}. ${s}`, { size: 10 })));
    }
  } else {
    body.push(para('未生成评分卡。', { size: 10, color: '808080' }));
  }

  body.push(para('五、修改对照表', { style: 'Heading1' }));
  if (session.changeLog?.length) {
    body.push(
      table(
        ['原方案要素', '对应争议', '修改后设计', '修改理由'],
        session.changeLog.map((l) => [l.originElement, l.contention, l.revisedElement, l.rationale]),
        [22, 14, 34, 30],
      ),
    );
  } else {
    body.push(para('未生成修改对照表。', { size: 10, color: '808080' }));
  }
  // 覆盖率按当前算法重算，保证导出的 Word 与系统结论一致（与 report.mjs 同处理）
  const coverage = session.contentions?.length
    ? checkCriticalCoverage(session.contentions, session.changeLog || [])
    : null;
  if (coverage) {
    body.push(
      para(
        `关键建议文本回应：${coverage.covered}/${coverage.total}` +
          (coverage.uncovered?.length ? `（未覆盖：${coverage.uncovered.join(', ')}）` : '（已有文本对应，不代表问题已解决）'),
        { size: 10, bold: true, color: coverage.ratio >= 1 ? '067647' : 'B42318' },
      ),
    );
  }

  body.push(para('六、修正版研究方案', { style: 'Heading1' }));
  body.push(
    para(session.revisedProtocol || '未生成', {
      size: 10.5,
      indent: 240,
    }),
  );

  body.push(para('七、证据卡', { style: 'Heading1' }));
  if (session.evidence?.length) {
    if (session.evidenceCoverage) body.push(para(session.evidenceCoverage, { size: 9, color: '595959' }));
    body.push(
      table(
        ['编号', '类型', '置信度', '要点', '与假设的关联', '出处'],
        session.evidence.map((e) => [
      e.id,
      e.sourceType,
      e.confidence,
      e.summary,
      e.relevance,
      // 真实检索的证据把 PubMed 链接一并写进 Word，拿到纸面也能回查
      e.modelKnowledge === false && e.url ? `${e.sourceRef}\n${e.url}` : e.sourceRef,
    ]),
        [6, 12, 8, 34, 22, 18],
      ),
    );
  } else {
    body.push(para('未检索到证据。', { size: 10, color: '808080' }));
  }

  body.push(para('八、诚实披露', { style: 'Heading1' }));
  const st = session.inferenceStats || {};
  body.push(
    table(
      ['指标', '数值'],
      [
        [
          (st.retrievedCount ?? 0) > 0
            ? `证据卡数量（其中 ${st.retrievedCount} 条来自 PubMed 真实检索）`
            : '证据卡数量（全部来自模型知识，非真实文献检索）',
          String(st.evidenceCount ?? 0),
        ],
        ['正文中引用标注次数', String(st.citationMarks ?? 0)],
        ['【模型知识】标注次数', String(st.knowledgeMarks ?? 0)],
        ['【推断】标注次数', String(st.inferenceMarks ?? 0)],
      ],
      [70, 30],
    ),
  );

  body.push(para('九、完整辩论记录', { style: 'Heading1' }));
  const stageNames = { S0: '假设解析与规范化', S1: '独立首轮评审', S2: '交叉质疑', S3: '审稿人质询', S4: '创新性评估', S5: '主持人汇总' };
  let lastStage = null;
  for (const m of session.messages || []) {
    if (m.stage !== lastStage) {
      body.push(para(`${m.stage}　${stageNames[m.stage] || ''}`, { style: 'Heading2' }));
      lastStage = m.stage;
    }
    body.push(
      para(
        `${m.agentName}${m.round ? `（第 ${m.round} 轮）` : ''}${m.absent ? '　⚠ 缺席' : ''}　${((m.elapsedMs || 0) / 1000).toFixed(1)}s`,
        { style: 'Heading3' },
      ),
    );
    body.push(para(m.content, { size: 10 }));
  }

  const document =
    XML_HEAD +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body.join('')}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1361" w:right="1418" w:bottom="1361" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';

  const contentTypes =
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const docRels =
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/document.xml', data: document },
  ]);
}
