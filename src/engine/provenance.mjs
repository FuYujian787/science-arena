/** 只核对文字是否来自用户输入，不判断用户材料本身的科学正确性。 */
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();
export function isInputQuote(rawText, quote) {
  const q = compact(quote);
  return q.length >= 8 && compact(rawText).includes(q);
}

export function userContext(rawText, proposedFacts = [], proposedFocus = '') {
  const block = /【已完成的研究】\s*([\s\S]*?)(?=\n\s*【|$)/.exec(rawText)?.[1];
  const numbered = block?.split(/\r?\n/).map(s => s.replace(/^\s*\d+[.、]\s*/, '').trim()).filter(Boolean) || [];
  const candidates = [...numbered, ...(Array.isArray(proposedFacts) ? proposedFacts : [])];
  const facts = [...new Set(candidates.filter(s => typeof s === 'string' && isInputQuote(rawText, s)))].slice(0, 12)
    .map((quote, i) => ({ id: `U-${String(i + 1).padStart(2, '0')}`, quote }));
  const focusBlock = /【(?:本轮唯一焦点|本轮焦点|本轮问题)】\s*([\s\S]*?)(?=\n\s*(?:【|请围绕)|$)/.exec(rawText)?.[1]?.trim();
  const focus = focusBlock || (isInputQuote(rawText, proposedFocus) ? proposedFocus : '');
  return { userFacts: facts, focus: focus.slice(0, 800) };
}

export function anchorChanges(changes, rawText) {
  return changes.map(change => {
    const quoted = typeof change.originQuote === 'string' ? change.originQuote.trim() : '';
    const matched = isInputQuote(rawText, quoted);
    return {
      ...change,
      originElement: matched ? quoted : '输入未明确／待核查；本条为角色建议，不认定为原研究缺陷。',
      originQuote: matched ? quoted : '',
      originAnchored: matched,
      ...(matched ? {} : { unverifiedOriginClaim: change.originElement }),
    };
  });
}
