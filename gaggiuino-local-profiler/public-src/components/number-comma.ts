// Lets every number field accept a comma as decimal separator (#1962,
// docs/DESIGN.md "Numbers"). Firefox otherwise empties the field on "8,3".
export function installNumberComma(doc: Document = document): void {
  doc.addEventListener('beforeinput', e => {
    const input = e.target as HTMLInputElement | null;
    const typed = e.data;
    if (input?.type !== 'number' || !typed?.includes(',')) return;
    e.preventDefault();
    doc.execCommand('insertText', false, typed.replace(/,/g, '.'));
  });
}
