// #1267: pure helpers behind the kiosk page (public-src/kiosk-helpers.ts).
// Kept a separate module from kiosk.ts so importing them here never runs the
// page's DOM bootstrap.
import { describe, it, expect, vi } from 'vitest';
import type { Order, QueueEta } from '../public-src/api/types.js';

// kiosk-helpers -> i18n -> state/index.js reads localStorage at module load;
// vitest's node environment has none, so stub it before the dynamic import.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });

const { etaText, isEinkMode } = await import('../public-src/kiosk-helpers.js');
const { t } = await import('../public-src/i18n.js');

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
