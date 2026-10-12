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
// The whole decision runs inside one repo.Update so the stamp lands with the
// notification it gates; ErrSkipSave means "nothing to notify" and is
// reported as a nil result, like the other library bookkeeping helpers.
func CheckLowStock(repo *Repository, doses func() ([]shots.AnnotatedDose, error), beanID int64, notify func(beanName string, remainingG int64) bool) error {
	if beanID <= 0 {
		return nil
	}
	doseRows, err := doses()
	if err != nil {
		return err
	}
	err = repo.Update(func(lib *Library) error {
		idx := findBeanIndex(*lib, beanID)
		if idx == -1 {
			return ErrSkipSave
		}
		bean := lib.Beans[idx]
		bag := currentBag(bean, doseRows, lib.Beans)
		if bag == nil || lowStockNotified(bag) {
			return ErrSkipSave
		}
		remaining, tracked := ComputeBeanRemaining(bean, doseRows, lib.Beans)
		if !tracked || remaining >= lowStockThresholdG {
			return ErrSkipSave
		}
		name, _ := bean["name"].(string)
		if !notify(name, max(remaining, 0)) {
			return ErrSkipSave
		}
		bag["lowStockNotifiedAt"] = time.Now().UnixMilli()
		return nil
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
