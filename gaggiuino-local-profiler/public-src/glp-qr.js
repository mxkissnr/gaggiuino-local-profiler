// GLP QR schema: glp://coffee?name=...&roaster=...&notes=...&roastDate=...
// Deliberately separated from views/library.js (which imports state.js,
// touching localStorage at module scope — not importable under vitest's
// node environment) so this pure encode/decode logic stays unit-testable.

// Notes can be up to 1000 characters and German text with umlauts roughly
// triples in length once percent-encoded (e.g. "ö" -> "%C3%B6") — long
// enough to exceed practical QR scanability. Truncated conservatively so the
// code stays reliably scannable rather than merely "technically encodable".
export const QR_NOTES_MAX = 200;

export function generateBeanQR(bean) {
  const params = new URLSearchParams();
  if (bean.name)      params.set('name',      bean.name);
  if (bean.roaster)   params.set('roaster',   bean.roaster);
  if (bean.roastDate) params.set('roastDate', bean.roastDate);
  if (bean.notes)     params.set('notes',     bean.notes.slice(0, QR_NOTES_MAX));
  return `glp://coffee?${params.toString()}`;
}

export function parseGlpQrParams(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('glp://coffee')) return null;
  const params = new URLSearchParams(raw.replace('glp://coffee?', ''));
  return {
    name: params.get('name') || '', roaster: params.get('roaster') || '',
    roastDate: params.get('roastDate') || '', notes: params.get('notes') || '',
  };
}
