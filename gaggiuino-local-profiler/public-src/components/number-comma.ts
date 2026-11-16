// Lets every number field accept a comma as decimal separator (#1962,
// docs/DESIGN.md "Numbers"). Firefox otherwise empties the field on "8,3".
// #2026: a value pasted from a locale that writes "1.000,5" is normalised the
// same way, instead of being rejected by the browser.

/**
 * Normalises a pasted number to the dot decimal separator. Spaces (including
 * U+00A0 and U+202F) are dropped; when both separators occur, the one that
 * comes last is the decimal separator and the other is grouping, so it goes.
 */
export function normalizePastedNumber(text: string): string {
  let out = text.replace(/[\s\u00a0\u202f]/g, '');
  const lastDot = out.lastIndexOf('.');
  const lastComma = out.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    out = lastDot > lastComma ? out.replace(/,/g, '') : out.replace(/\./g, '');
  }
  const comma = out.lastIndexOf(',');
  if (comma === -1) return out;
  return `${out.slice(0, comma).replace(/,/g, '')}.${out.slice(comma + 1)}`;
}

export function installNumberComma(doc: Document = document): void {
  doc.addEventListener('beforeinput', e => {
    const input = e.target as HTMLInputElement | null;
    const typed = e.data;
    if (input?.type !== 'number' || !typed?.includes(',')) return;
    e.preventDefault();
    doc.execCommand('insertText', false, typed.replace(/,/g, '.'));
  });
  doc.addEventListener('paste', e => {
    const input = e.target as HTMLInputElement | null;
    if (input?.type !== 'number') return;
    const pasted = e.clipboardData?.getData('text');
    if (!pasted?.includes(',')) return;
    e.preventDefault();
    doc.execCommand('insertText', false, normalizePastedNumber(pasted));
  });
}
