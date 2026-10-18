package library

import (
	"errors"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// lowStockThresholdG is the remaining-grams threshold below which a bean's
// current bag triggers the one-time "bean running low" notification (#228,
// restored in Go for #1671). Same constant the legacy Node backend used.
const lowStockThresholdG = 100

// ResolveLowStockBeanID resolves the library bean id a shot's annotation
// refers to, beanId-first with a coffee-name fallback (ResolveBeanForShot),
// or 0 when the annotation matches no bean. cmd/server's annotation-saved
// hook uses it to pick the bean CheckLowStock inspects.
func ResolveLowStockBeanID(shot shots.Shot, beans []Entity) int64 {
	bean := ResolveBeanForShot(shot, beans)
	if bean == nil {
		return 0
	}
	id, _ := idOf(bean, "id")
	return id
}

// CheckLowStock sends the one-time "bean running low" HA notification for
// beanID's current bag (#228, restored in Go for #1671). It notifies only
// when the bean is stock-tracked, its current bag has never been notified,
// and the bean's remaining grams are below lowStockThresholdG; notify reports
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
func CheckLowStock(repo *Repository, doses func() ([]shots.AnnotatedDose, error), beanID int64, notify func(beanName string, remainingG int64) bool) error {
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
	if !tracked || remaining >= lowStockThresholdG {
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
