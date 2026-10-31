package library

import (
	"errors"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// DefaultLowStockThresholdG is the remaining-grams threshold below which a
// bean's current bag triggers the one-time "bean running low" notification
// (#228, restored in Go for #1671), used when the ui-prefs store holds no valid
// `bean_low_stock_g` (#1835). Same value the legacy Node backend used.
const DefaultLowStockThresholdG int64 = 100

// ResolveLowStockBeanIDs resolves the library bean ids a shot's annotation
// refers to, beanId-first with a coffee-name fallback (ResolveBeanForShot),
// skipping parts that match no bean. A mixed shot (#1837) yields one id per
// bean-mix part, deduplicated (two parts may name the same bean); a
// single-bean shot yields its one bean, exactly as before. cmd/server's
// annotation-saved hook runs CheckLowStock once per returned id.
func ResolveLowStockBeanIDs(shot shots.Shot, beans []Entity) []int64 {
	ann, _ := shot["annotation"].(map[string]any)
	parts := shots.BeanMix(ann)
	if len(parts) == 0 {
		id := resolveLowStockBeanID(ann, beans)
		if id == 0 {
			return nil
		}
		return []int64{id}
	}
	ids := make([]int64, 0, len(parts))
	seen := make(map[int64]bool, len(parts))
	for _, part := range parts {
		partAnn := map[string]any{"coffee": part.Coffee}
		if part.BeanID != nil {
			partAnn["beanId"] = *part.BeanID
		}
		id := resolveLowStockBeanID(partAnn, beans)
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

// resolveLowStockBeanID resolves one annotation map to its library bean id,
// or 0 when it matches no bean.
func resolveLowStockBeanID(ann map[string]any, beans []Entity) int64 {
	if ann == nil {
		return 0
	}
	bean := ResolveBeanForShot(shots.Shot{"annotation": ann}, beans)
	if bean == nil {
		return 0
	}
	id, _ := idOf(bean, "id")
	return id
}

// CheckLowStock sends the one-time "bean running low" HA notification for
// beanID's current bag (#228, restored in Go for #1671). It notifies only
// when the bean is stock-tracked, its current bag has never been notified,
// and the bean's remaining grams are below thresholdG; notify reports
// whether the push was delivered, and only then is the bag's
// lowStockNotifiedAt stamped so a second annotation does not re-notify. A new
// current bag carries no stamp, so it re-arms automatically.
//
// The decision is a read-only GetLibrary and the push runs before any write
// lock is taken, so an unreachable Home Assistant can no longer block every
// other library write for the notify timeout. Only a delivered push is
// followed by a repo.Update that re-finds the same bag by id and stamps it,
// skipping the stamp if a concurrent check already set it. ErrSkipSave means
// "nothing to notify" and is reported as a nil result, like the other library
// bookkeeping helpers.
func CheckLowStock(repo *Repository, doses func() ([]shots.AnnotatedDose, error), beanID int64, thresholdG int64, notify func(beanName string, remainingG int64) bool) error {
	if beanID <= 0 {
		return nil
	}
	doseRows, err := doses()
	if err != nil {
		return err
	}
	lib, err := repo.GetLibrary()
	if err != nil {
		return err
	}
	idx := findEntityIndex(lib.Beans, beanID)
	if idx == -1 {
		return nil
	}
	bean := lib.Beans[idx]
	bag := currentBag(bean, doseRows, lib.Beans)
	if bag == nil || lowStockNotified(bag) {
		return nil
	}
	remaining, tracked := ComputeBeanRemaining(bean, doseRows, lib.Beans)
	if !tracked || remaining >= thresholdG {
		return nil
	}
	bagID, ok := idOf(bag, "id")
	if !ok || bagID <= 0 {
		return nil
	}
	name, _ := bean["name"].(string)
	if !notify(name, max(remaining, 0)) {
		return nil
	}
	err = repo.Update(func(l *Library) error {
		bi := findEntityIndex(l.Beans, beanID)
		if bi == -1 {
			return ErrSkipSave
		}
		for _, raw := range bagsOf(l.Beans[bi]) {
			b, ok := raw.(Entity)
			if !ok {
				continue
			}
			if id, _ := idOf(b, "id"); id != bagID {
				continue
			}
			if lowStockNotified(b) {
				return ErrSkipSave
			}
			b["lowStockNotifiedAt"] = time.Now().UnixMilli()
			return nil
		}
		return ErrSkipSave
	})
	if errors.Is(err, ErrSkipSave) {
		return nil
	}
	return err
}

// lowStockNotified reports whether bag already carries the one-time
// low-stock stamp. A missing, null or zero value reads as "not yet notified",
// matching the legacy Node truthiness check.
func lowStockNotified(bag Entity) bool {
	v, present := bag["lowStockNotifiedAt"]
	if !present || v == nil {
		return false
	}
	ts, ok := jsParseIntLoose(v)
	return ok && ts != 0
}
