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
// be silently dropped from the sum. Shared by computeBeanRemaining and
// sumConsumedDoses's bag-scoped total so the two can never resolve a dose's
// bag differently again (#788).
function resolveBagAtShotTime(bags, shotMs) {
  return bags
    .filter(b => (b.openedAt || 0) <= shotMs)
    .sort((a, b) => b.openedAt - a.openedAt)[0] || bags[0];
}

// Sums matching dose rows for `bean`. With `bags` omitted (or empty), every
// matching dose counts — an unscoped lifetime total. With `bags` given, only
// doses that resolveBagAtShotTime() attributes to the last bag in the array
// (the active bag, same convention as computeBeanRemaining) count — a
// bag-scoped total that resolves each dose's bag exactly like
// computeBeanRemaining does, instead of a flat openedAt timestamp cutoff
// that disagreed with it on doses predating the only recorded bag (#788).
export function sumConsumedDoses(bean, doseRows, allBeans, bags = null) {
  const idExists  = new Set((allBeans || []).map(b => b.id));
  const bagList   = Array.isArray(bags) && bags.length ? bags : null;
  const activeBag = bagList ? bagList[bagList.length - 1] : null;
  return (doseRows || []).reduce((sum, r) => {
    const d = parseFloat(r.dose);
    if (!d) return sum;
    if (!matchesBean(r, bean, idExists)) return sum;
    if (activeBag && resolveBagAtShotTime(bagList, r.timestamp * 1000) !== activeBag) return sum;
    return sum + d;
  }, 0);
}

// Remaining grams for a stock-tracked bean — consumed = sum of annotated
// doses of shots matching this bean and belonging to the active bag; without
// bags, all matching shots count. Returns null when stock is untracked
// (mirrors the backend's `bean.stock_g > 0` guard).
export function computeBeanRemaining(bean, doseRows, allBeans) {
  if (!(bean.stock_g > 0)) return null;
  const bags      = Array.isArray(bean.bags) ? bean.bags : [];
  const activeBag = bags.length ? bags[bags.length - 1] : null;
  const idExists  = new Set((allBeans || []).map(b => b.id));
  const consumed  = (doseRows || []).reduce((sum, r) => {
    const d = parseFloat(r.dose);
    if (!d) return sum;
    if (!matchesBean(r, bean, idExists)) return sum;
    if (activeBag && resolveBagAtShotTime(bags, r.timestamp * 1000) !== activeBag) return sum;
    return sum + d;
  }, 0);
  return Math.round(bean.stock_g - Math.round(consumed));
}

// Inverse of computeBeanRemaining (#930): stock-editing UI (the bean edit form's "Stock
// (g)" field and the "Adjust stock" button) lets a user type in how much coffee is
// actually left, not the bag's original weight. Since stock_g is the source of truth and
// remaining is always derived from it, that entered value has to be translated into the
// stock_g that makes computeBeanRemaining() report it back — i.e. the desired remaining
// plus whatever the active bag has already consumed. For a bag with nothing consumed yet
// this is a no-op (desiredRemaining in, same value out), so it's also safe to use
// unconditionally for the bean-creation form.
export function remainingToStockG(bean, doseRows, allBeans, desiredRemaining) {
  const bags     = Array.isArray(bean.bags) ? bean.bags : [];
  const consumed = sumConsumedDoses(bean, doseRows, allBeans, bags);
  return Math.round(desiredRemaining + consumed);
}
