// #551: shared bean consumption math — mirrors
// lib/services/LibraryService.js's computeBeanRemaining()/matching rule
// exactly (same signature, same beanId-first-with-name-fallback precedence,
// same double-round pattern) so backend and frontend can never drift apart
// again. `doseRows` here is any array of { coffee, beanId, dose, timestamp }
// — the backend gets those from ShotRepository.getAnnotatedDoses() (SQL),
// the frontend maps them off S.shots (see public-src/views/library.js).

// A dose row's beanId, when it still resolves to SOME currently-existing
// bean (checked against `allBeans`), is trusted exclusively — that dose
// genuinely belongs to whichever bean the id points at, even if this bean's
// name happens to coincide. Only when the row's beanId is null, or points
// at a bean that no longer exists anywhere (deleted), does it fall back to
// name matching against `bean`. This is what lets a bean deleted and
// reimported under the same name recover its own consumption history,
// while never misattributing a dose that legitimately belongs to a
// different, still-existing bean that happens to share a name (#456).
export function matchesBean(doseRow, bean, idExists) {
  const beanId = doseRow.beanId;
  return beanId != null && idExists.has(beanId)
    ? beanId === bean.id
    : String(doseRow.coffee || '').toLowerCase() === String(bean.name || '').toLowerCase();
}

// Which bag was active when a dose (shot) was pulled — same "bag active at
// shot time" resolution used for roast-date/frozen-portion lookups
// (shots/utils.js, annotation.js). A dose that predates every recorded bag
// (bean/bag added to the library only after the shot was already pulled,
// then assigned to it retroactively) still belongs to the oldest bag on
// record — there was nothing else it could have come from, so it must not
// be silently dropped from the sum. This single-bag LIFO resolution is only
// used by computeBeanRemaining's bean-wide total now (attribution-
// independent — see its own doc comment); per-bag consumption/current-bag
// determination moved server-side to SimulateBagQueue's proper queue
// replay (go/internal/library/orders_support.go, #sortOrder rework).
export function resolveBagAtShotTime(bags, shotMs) {
  return bags
    .filter(b => (b.openedAt || 0) <= shotMs)
    .sort((a, b) => b.openedAt - a.openedAt)[0] || bags[0];
}

// Remaining grams for a stock-tracked bean — FIFO model: totalStock minus
// all doses consumed during tracked-bag periods, clamped at 0.
//
// "Tracked bags" are bags that carry a positive stock_g (either explicitly
// on the bag object, or via the bean.stock_g fallback for the active bag
// when it predates per-bag stock tracking). Doses attributed by
// resolveBagAtShotTime to an *untracked* bag are excluded — they came from a
// bag whose capacity we never recorded, so they must not reduce tracked stock.
//
// No per-bag clamping: overflow from one bag's period carries forward to the
// next (true FIFO), so a recorded dose cannot exceed the total remaining even
// if it individually exceeds one bag's stock_g.
//
// The active bag (last element) falls back to bean.stock_g when it has no
// explicit stock_g (bags created before per-bag stock tracking was added).
// With no bags at all, all matching doses count against bean.stock_g.
// Returns null when no tracked bag has positive stock_g.
export function computeBeanRemaining(bean, doseRows, allBeans) {
  const bags     = Array.isArray(bean.bags) ? bean.bags : [];
  const idExists = new Set((allBeans || []).map(b => b.id));

  if (bags.length === 0) {
    if (!(bean.stock_g > 0)) return null;
    const consumed = (doseRows || []).reduce((sum, r) => {
      const d = parseFloat(r.dose);
      return d && matchesBean(r, bean, idExists) ? sum + d : sum;
    }, 0);
    return Math.round(bean.stock_g - Math.round(consumed));
  }

  // Build set of tracked bags (have stock) and sum their total stock.
  let totalStock = 0;
  const trackedBags = new Set();
  for (let i = 0; i < bags.length; i++) {
    const bg = bags[i];
    const raw = bg.stock_g ?? (i === bags.length - 1 ? bean.stock_g : null);
    const s = parseFloat(raw);
    if (isFinite(s) && s > 0) { totalStock += s; trackedBags.add(bg); }
  }
  if (!(totalStock > 0)) return null;

  // Sum doses resolved to tracked bags only (FIFO: no per-bag clamping).
  const consumed = (doseRows || []).reduce((sum, r) => {
    const d = parseFloat(r.dose);
    if (!d || !matchesBean(r, bean, idExists)) return sum;
    return trackedBags.has(resolveBagAtShotTime(bags, r.timestamp * 1000)) ? sum + d : sum;
  }, 0);

  return Math.round(Math.max(0, totalStock - Math.round(consumed)));
}
