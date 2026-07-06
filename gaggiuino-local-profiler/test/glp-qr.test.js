import { describe, it, expect } from 'vitest';
import { generateBeanQR, parseGlpQrParams } from '../public-src/glp-qr.js';

describe('generateBeanQR', () => {
  it('encodes name, roaster, roastDate and notes as glp:// URL params', () => {
    const url = generateBeanQR({ name: 'Bombe', roaster: 'Elbgold', roastDate: '01.03.2026', notes: 'Süß' });
    expect(url).toMatch(/^glp:\/\/coffee\?/);
    const params = new URLSearchParams(url.replace('glp://coffee?', ''));
    expect(params.get('name')).toBe('Bombe');
    expect(params.get('roaster')).toBe('Elbgold');
    expect(params.get('roastDate')).toBe('01.03.2026');
    expect(params.get('notes')).toBe('Süß');
  });

  it('omits unset fields entirely rather than encoding empty params', () => {
    const url = generateBeanQR({ name: 'Bombe' });
    expect(url).toBe('glp://coffee?name=Bombe');
  });

  it('truncates long notes so the encoded payload stays reasonably scannable', () => {
    // Heavy umlaut content roughly triples in length once percent-encoded —
    // the worst case for QR capacity, not just raw character count.
    const longNotes = 'ö'.repeat(1000);
    const url = generateBeanQR({ name: 'Bombe', notes: longNotes });
    // Well under version-40-L's ~2953 byte hard cap, and short enough to
    // stay reliably scannable at a normal print/screen size.
    expect(url.length).toBeLessThan(1500);
  });
});

describe('parseGlpQrParams', () => {
  it('returns null for non-glp URLs (e.g. a plain EAN/UPC barcode)', () => {
    expect(parseGlpQrParams('4006381333931')).toBeNull();
    expect(parseGlpQrParams('https://example.com')).toBeNull();
  });

  it('round-trips a bean through generateBeanQR -> parseGlpQrParams', () => {
    const bean = { name: 'Yirgacheffe', roaster: 'Kaffee Braun', roastDate: '15.06.2026', notes: 'Jasmin, Zitrone' };
    const parsed = parseGlpQrParams(generateBeanQR(bean));
    expect(parsed).toEqual(bean);
  });

  it('missing fields come back as empty strings, not undefined', () => {
    const parsed = parseGlpQrParams(generateBeanQR({ name: 'Bombe' }));
    expect(parsed).toEqual({ name: 'Bombe', roaster: '', roastDate: '', notes: '' });
  });
});
