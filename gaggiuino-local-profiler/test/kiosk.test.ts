// #1267: pure helpers behind the kiosk page (public-src/kiosk-helpers.ts).
// Kept a separate module from kiosk.ts so importing them here never runs the
// page's DOM bootstrap.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Order, QueueEta } from '../public-src/api/types.js';

// kiosk-helpers -> i18n -> state/index.js, and components/machines-settings.js
// below, read localStorage at module load; vitest's node environment has none,
// so stub a complete-enough Storage before the dynamic imports.
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
});
// components/machines-settings.js also touches window/document at call time —
// same minimal fakes test/theme-contrast.test.ts uses (navigator comes from
// test/setup.ts).
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.document ??= { documentElement: {}, getElementById: () => undefined };

const { etaText, isEinkMode } = await import('../public-src/kiosk-helpers.js');
const { t } = await import('../public-src/i18n.js');
const { resolveAccentInk } = await import('../public-src/components/machines-settings.js');

const KIOSK_CSS = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'public-src', 'kiosk.css'), 'utf8');

// Every field the Order schema requires, so a test only sets the ones it
// exercises (mutating the returned object rather than spreading a Partial,
// which exactOptionalPropertyTypes rejects).
function baseOrder(): Order {
  return {
    id: 'ord_1',
    createdAt: 0,
    customer: 'Ada',
    item: 'Espresso',
    variant: null,
    note: '',
    notifyService: null,
    status: 'pending',
    eta: null,
    acceptedAt: null,
    completedAt: null,
    declineReason: null,
    machine: null,
    machineId: 1,
    beanId: null,
  };
}

function queueEta(positions: Record<string, { position: number; suggestedEta: number }>): QueueEta {
  return { acceptedRemaining: 0, pendingCount: 0, prepTime: 0, positions };
}

describe('etaText', () => {
  it('counts down the remaining minutes for an accepted order', () => {
    const now = 1_000_000;
    const order = baseOrder();
    order.status = 'accepted';
    order.acceptedAt = now - 60_000;
    order.eta = 6; // placed 1 min ago with a 6 min estimate -> 5 left
    expect(etaText(order, null, now)).toBe(t('kiosk_eta_minutes', 5));
  });

  it('falls back to the almost-ready text once an accepted order is due', () => {
    const now = 1_000_000;
    const order = baseOrder();
    order.status = 'accepted';
    order.acceptedAt = now - 5 * 60_000;
    order.eta = 5; // exactly due: no whole minutes left
    expect(etaText(order, null, now)).toBe(t('kiosk_almost_ready'));
  });

  it('uses the queue position for a pending order', () => {
    const order = baseOrder();
    expect(etaText(order, queueEta({ [order.id]: { position: 1, suggestedEta: 3 } }), 0))
      .toBe(t('kiosk_eta_minutes', 3));
  });

  it('is empty when there is no estimate for the order', () => {
    expect(etaText(baseOrder(), null, 0)).toBe('');
    expect(etaText(baseOrder(), queueEta({}), 0)).toBe('');
  });
});

describe('isEinkMode', () => {
  it('is on only for eink=1', () => {
    expect(isEinkMode('?eink=1')).toBe(true);
    expect(isEinkMode('?other=1&eink=1')).toBe(true);
    expect(isEinkMode('')).toBe(false);
    expect(isEinkMode('?eink=0')).toBe(false);
    expect(isEinkMode('?eink')).toBe(false);
    expect(isEinkMode('?other=1')).toBe(false);
  });
});

describe('kiosk light-theme accent ink', () => {
  it('matches resolveAccentInk for the kiosk default amber-americano accent', () => {
    const at = KIOSK_CSS.search(/html\[data-theme="light"\]:not\(\.eink\)\s*\{/);
    expect(at, 'light-theme --accent-ink rule not found in kiosk.css').toBeGreaterThanOrEqual(0);
    const body = KIOSK_CSS.slice(at, KIOSK_CSS.indexOf('}', at));
    const m = /--accent-ink:\s*(#[0-9a-fA-F]{3,6})\b/.exec(body);
    const ink = m?.[1];
    if (ink === undefined) throw new Error('--accent-ink not declared in the kiosk light-theme block');
    expect(ink).toBe(resolveAccentInk('amber-americano', '#f59e0b', true));
    expect(ink).toBe('#905c06');
  });
});
