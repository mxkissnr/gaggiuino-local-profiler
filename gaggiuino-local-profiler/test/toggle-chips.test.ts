// #2093: the GaggiMate editor toggles, the dial-in symptom buttons and the order menu toggles are shared chips; their state is aria-pressed only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MenuItem } from '../public-src/api/types.js';

const g = globalThis as unknown as Record<string, unknown>;
const store = new Map<string, string>();
g.localStorage ??= {
  getItem: (k: string) => (store.has(k) ? store.get(k) ?? null : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
g.navigator ??= { language: 'en-US' };
g.window ??= globalThis;

const { S } = await import('../public-src/state/index.js');
const apiModule = await import('../public-src/api/transport.js');
const fetchSpy = vi.spyOn(apiModule, 'apiFetch');
const { openGaggiMateProfileEditor } = await import('../public-src/views/gaggimate-profile-editor.js');
const { renderProfileDialinWizard, profileDialinToggleSymptom } = await import('../public-src/views/profile-dialin-wizard.js');
const { renderOrdersMenuAdmin } = await import('../public-src/views/orders.js');

const ACTIVE_CLASS = /class="[^"]*\bactive\b/;
const CHIP_BUTTON = /<button type="button" class="chip" aria-pressed="(true|false)"/g;

interface FakeEl {
  innerHTML: string;
  style: Record<string, string>;
  textContent: string;
  addEventListener(): void;
}

function fakeDocument(ids: string[], absent: string[] = []) {
  const els: Record<string, FakeEl> = {};
  for (const id of ids) els[id] = { innerHTML: '', style: {}, textContent: '', addEventListener() {} };
  const getElementById = (id: string): FakeEl | undefined => {
    if (absent.includes(id)) return undefined;
    return (els[id] ??= { innerHTML: '', style: {}, textContent: '', addEventListener() {} });
  };
  return { els, document: { getElementById, querySelectorAll: () => [] } };
}

function chipState(html: string, action: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = new RegExp(`<button[^>]*data-action="${action}"[^>]*data-val="([^"]+)"[^>]*>`, 'g');
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    out[m[1] ?? ''] = /aria-pressed="true"/.test(tag) ? 'true' : 'false';
  }
  return out;
}

describe('GaggiMate editor toggle groups', () => {
  beforeEach(() => { fetchSpy.mockReset(); });

  it('renders every segmented choice as a chip pressed through aria-pressed', async () => {
    const { els, document: doc } = fakeDocument(['gmEditorBody'], ['gmProfileChart']);
    g.document = doc;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: 'p1', label: 'Chips', description: '', type: 'standard', utility: false, favorite: false,
        temperature: 93,
        phases: [{ name: 'Brew', phase: 'brew', valve: 1, pump: 100, duration: 30, targets: [] }],
      }),
    } as unknown as Response);

    await openGaggiMateProfileEditor('p1');
    const html = els.gmEditorBody?.innerHTML ?? '';

    const groups = html.match(/<div class="gm-toggle-group">[\s\S]*?<\/div>/g) ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const buttons = group.match(/<button[^>]*>/g) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button).toMatch(/^<button type="button" class="chip" aria-pressed="(true|false)"/);
      }
    }

    expect(chipState(html, 'gm-type')).toEqual({ standard: 'true', pro: 'false' });
    expect(chipState(html, 'gm-std-valve')).toEqual({ '0': 'false', '1': 'true' });
    expect(html).not.toMatch(ACTIVE_CLASS);
  });
});

describe('dial-in symptom chips', () => {
  it('presses each picked symptom through aria-pressed and clears the others', () => {
    const { els, document: doc } = fakeDocument(['pdwBody']);
    g.document = doc;
    S.profileDialinSession = {
      status: 'active',
      profileId: 42,
      profileName: 'P',
      profile: { waterTemperature: 92 },
      rounds: [],
      reviewRound: { shotId: 1, score: 70, suggestion: null },
      pendingSymptoms: ['sour', 'bitter'],
      candidateShotId: null,
    };

    renderProfileDialinWizard();
    let html = els.pdwBody?.innerHTML ?? '';

    const buttons = html.match(CHIP_BUTTON) ?? [];
    expect(buttons).toHaveLength(5);
    expect(html.match(/aria-pressed="true" data-action="profile-dialin-symptom" data-symptom="([^"]+)"/g))
      .toEqual([
        'aria-pressed="true" data-action="profile-dialin-symptom" data-symptom="sour"',
        'aria-pressed="true" data-action="profile-dialin-symptom" data-symptom="bitter"',
      ]);
    expect(html).not.toMatch(ACTIVE_CLASS);

    profileDialinToggleSymptom('balanced');
    html = els.pdwBody?.innerHTML ?? '';

    expect(html.match(/aria-pressed="true" data-action="profile-dialin-symptom" data-symptom="([^"]+)"/g))
      .toEqual(['aria-pressed="true" data-action="profile-dialin-symptom" data-symptom="balanced"']);
    expect(html.match(CHIP_BUTTON) ?? []).toHaveLength(5);
    expect(html).not.toMatch(ACTIVE_CLASS);
  });
});

describe('order menu toggles', () => {
  it('renders the beans, milks and trending toggles as chips pressed through aria-pressed', () => {
    const { els, document: doc } = fakeDocument(['ordersMenuList']);
    g.document = doc;

    renderOrdersMenuAdmin([
      { id: 'a', name: 'Latte', emoji: 'L', useBeans: true, useMilks: false, trending: false, variants: [] },
      { id: 'b', name: 'Flat', emoji: 'F', useBeans: false, useMilks: true, trending: true, variants: [] },
    ] as unknown as MenuItem[]);
    const html = els.ordersMenuList?.innerHTML ?? '';

    expect(html).toContain('class="chip" aria-pressed="true" data-menu-use-beans="a"');
    expect(html).toContain('class="chip" aria-pressed="false" data-menu-use-milks="a"');
    expect(html).toContain('class="chip" aria-pressed="false" data-menu-trend="a"');
    expect(html).toContain('class="chip" aria-pressed="false" data-menu-use-beans="b"');
    expect(html).toContain('class="chip" aria-pressed="true" data-menu-use-milks="b"');
    expect(html).toContain('class="chip" aria-pressed="true" data-menu-trend="b"');
    expect(html).not.toMatch(ACTIVE_CLASS);
  });
});
