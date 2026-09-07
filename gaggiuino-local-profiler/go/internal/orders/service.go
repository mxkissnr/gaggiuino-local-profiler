package orders

import (
	"context"
	"fmt"
	"math"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports lib/services/OrderService.js.

// randomToken ports the trailing `Math.random().toString(36).slice(2, 6)`
// half of OrderService.js's id generation: 4 lowercase base-36 characters,
// disambiguating two orders placed in the same millisecond.
func randomToken(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, n)
	for i := range b {
		b[i] = alphabet[rand.Intn(len(alphabet))]
	}
	return string(b)
}

// defaultPrepTime mirrors OrderService.js's DEFAULT_PREP_TIME (minutes per
// order, used when there's no historical completed-order data yet).
const defaultPrepTime = 4.0

// Service composes Repository with the shots/library/machines repositories
// OrderService.js's lifecycle methods cross-call, plus the HA client the
// customer status-change notification (notifyOrderStatus below) needs.
type Service struct {
	repo      *Repository
	shotsRepo *shots.Repository
	libRepo   *library.Repository
	registry  *machines.Registry
	ha        *ha.Client

	// OnQueueChanged, if set, is called after PlaceOrder/AcceptOrder/
	// CompleteOrder/DeclineOrder successfully change which orders are
	// active or what state one is in — internal/web's OrdersHandlers wires
	// this (#901) to re-render and SSE-publish the barista queue fragment,
	// the same "callback field, not a direct import" seam
	// internal/library's SetOnGrinderDeleted and internal/system's
	// PreheatInfoFunc already establish for the identical reason: this
	// package can't import internal/web (which already imports this one)
	// without a cycle. nil is a valid, common case (no live-update
	// consumer wired, e.g. every test in this package) — every call site
	// below is nil-checked.
	OnQueueChanged func()
}

// fireQueueChanged calls OnQueueChanged if set — shared by every lifecycle
// method's success path below.
func (s *Service) fireQueueChanged() {
	if s.OnQueueChanged != nil {
		s.OnQueueChanged()
	}
}

// NewService wires repo against the cross-domain repositories every
// lifecycle method needs: shotsRepo (fulfillment shot matching + bean-stock
// math), libRepo (bean/milk resolution + stock deduction), registry
// (machine name -> id resolution), haClient (the customer accept/complete/
// decline notification every consumer of AcceptOrder/CompleteOrder/
// DeclineOrder gets for free — #901 code review: this used to be a private
// method on internal/orders' own REST *Handlers, which meant
// internal/web's separate *OrdersHandlers had no way to call it and
// silently shipped without customer notifications).
func NewService(repo *Repository, shotsRepo *shots.Repository, libRepo *library.Repository, registry *machines.Registry, haClient *ha.Client) *Service {
	return &Service{repo: repo, shotsRepo: shotsRepo, libRepo: libRepo, registry: registry, ha: haClient}
}

// notifyOrderStatus ports routes/orders.js's _notifyOrderStatus: shared by
// AcceptOrder/CompleteOrder/DeclineOrder below, gated by the single
// notify_order_status toggle (#603). Best-effort — fired in a goroutine,
// matching Node's fire-and-forget sendHaNotify() (no caller awaits it
// either). Lives on Service (not the REST-only *Handlers it used to be a
// method of) so every caller of these three lifecycle methods — the REST
// API and internal/web's htmx queue actions alike — gets the same customer
// notification without having to remember to trigger it separately.
func (s *Service) notifyOrderStatus(order Order, title, body string) {
	if s.ha == nil {
		return
	}
	settings, err := s.repo.GetSettings()
	if err != nil {
		return
	}
	if v, ok := settings["notify_order_status"].(bool); ok && !v {
		return
	}
	svc, _ := order["notifyService"].(string)
	if svc == "" {
		mapping, err := s.repo.GetNotifyMapping()
		if err != nil {
			return
		}
		haUserID, _ := order["haUserId"].(string)
		svc = mapping[haUserID]
	}
	id, _ := order["id"].(string)
	go s.ha.SendNotify(context.Background(), svc, title, body, id)
}

// OrderError carries an HTTP status the way ShotService's ErrShotNotFound /
// OrderService.js's `Object.assign(new Error(...), {status})` pattern does
// — handlers.go type-asserts this to pick the response code.
type OrderError struct {
	Status  int
	Message string
}

func (e *OrderError) Error() string { return e.Message }

func newOrderError(status int, message string) *OrderError {
	return &OrderError{Status: status, Message: message}
}

// resolveMachineID ports OrderService.js's resolveMachineId(machineName)
// (#326): resolves an order's `machine` display name/slug into the
// registry's actual numeric id, case-insensitively, falling back to the
// default machine (never 0) when unmatched/empty.
func (s *Service) resolveMachineID(machineName string) (int64, error) {
	fallback := int64(1)
	if def, err := s.registry.GetDefaultMachine(); err == nil && def != nil {
		fallback = def.ID
	} else if err != nil {
		return 0, err
	}
	needle := strings.ToLower(strings.TrimSpace(machineName))
	if needle == "" {
		return fallback, nil
	}
	all, err := s.registry.ListMachines()
	if err != nil {
		return 0, err
	}
	for _, m := range all {
		if strings.ToLower(m.Name) == needle {
			return m.ID, nil
		}
	}
	return fallback, nil
}

// resolveBeanID ports OrderService.js's resolveBeanId(rawBeanId) (#563): a
// stale/fabricated bean id silently becomes (0, false) rather than failing
// order placement.
func (s *Service) resolveBeanID(raw any) (int64, bool, error) {
	id, ok := jsParseIntAny(raw)
	if !ok {
		return 0, false, nil
	}
	lib, err := s.libRepo.GetLibrary()
	if err != nil {
		return 0, false, err
	}
	for _, b := range lib.Beans {
		if bid, ok := beanIDOf(b); ok && bid == id {
			return id, true, nil
		}
	}
	return 0, false, nil
}

func beanIDOf(b library.Entity) (int64, bool) {
	switch v := b["id"].(type) {
	case int64:
		return v, true
	case float64:
		return int64(v), true
	}
	return 0, false
}

// jsParseIntAny handles both a JSON-decoded number (float64) and a string
// query/body value, mirroring JS's `parseInt(rawBeanId, 10)` being called
// on either shape depending on caller (body field vs. query param).
func jsParseIntAny(v any) (int64, bool) {
	switch t := v.(type) {
	case nil:
		return 0, false
	case string:
		if t == "" {
			return 0, false
		}
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		if err != nil {
			return 0, false
		}
		return n, true
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case int:
		return int64(t), true
	default:
		return 0, false
	}
}

// QueueEta mirrors computeQueueEta's return shape.
type QueueEta struct {
	AcceptedRemaining float64                  `json:"acceptedRemaining"`
	PendingCount      int                      `json:"pendingCount"`
	PrepTime          float64                  `json:"prepTime"`
	Positions         map[string]QueuePosition `json:"positions"`
}

// QueuePosition mirrors one entry of computeQueueEta's `positions` map.
type QueuePosition struct {
	Position     int `json:"position"`
	SuggestedEta int `json:"suggestedEta"`
}

// ComputeQueueEta ports OrderService.js's computeQueueEta(orders, now):
// pure over its inputs, no I/O — queue position + suggested ETA for every
// pending order, plus a rolling prep-time estimate from the last 10
// completed orders.
func ComputeQueueEta(orders []Order, now time.Time) QueueEta {
	nowMs := float64(now.UnixMilli())

	var accepted, pending []Order
	for _, o := range orders {
		status, _ := o["status"].(string)
		switch status {
		case "accepted":
			accepted = append(accepted, o)
		case "pending":
			pending = append(pending, o)
		}
	}
	sortByCreatedAt(pending)

	var acceptedRemaining float64
	for _, o := range accepted {
		acceptedAt, _ := jsNumber(o["acceptedAt"])
		eta, _ := jsNumber(o["eta"])
		remaining := (acceptedAt + eta*60000 - nowMs) / 60000
		if remaining > 0 {
			acceptedRemaining += remaining
		}
	}

	var recentDone []Order
	for _, o := range orders {
		status, _ := o["status"].(string)
		if status != "done" {
			continue
		}
		if eta, ok := jsNumber(o["eta"]); !ok || eta == 0 {
			continue
		}
		recentDone = append(recentDone, o)
	}
	if len(recentDone) > 10 {
		recentDone = recentDone[len(recentDone)-10:]
	}
	prepTime := defaultPrepTime
	if len(recentDone) > 0 {
		var sum float64
		for _, o := range recentDone {
			eta, _ := jsNumber(o["eta"])
			sum += eta
		}
		prepTime = sum / float64(len(recentDone))
	}

	positions := make(map[string]QueuePosition, len(pending))
	for i, o := range pending {
		id, _ := o["id"].(string)
		suggested := acceptedRemaining + float64(i)*prepTime + prepTime
		suggested = math.Ceil(suggested)
		if suggested < 1 {
			suggested = 1
		}
		if suggested > 60 {
			suggested = 60
		}
		positions[id] = QueuePosition{Position: i + 1, SuggestedEta: int(suggested)}
	}

	return QueueEta{
		AcceptedRemaining: roundTo1(acceptedRemaining),
		PendingCount:      len(pending),
		PrepTime:          roundTo1(prepTime),
		Positions:         positions,
	}
}

func roundTo1(f float64) float64 {
	return math.Round(f*10) / 10
}

func sortByCreatedAt(orders []Order) {
	for i := 1; i < len(orders); i++ {
		for j := i; j > 0; j-- {
			a, _ := jsNumber(orders[j-1]["createdAt"])
			b, _ := jsNumber(orders[j]["createdAt"])
			if a <= b {
				break
			}
			orders[j-1], orders[j] = orders[j], orders[j-1]
		}
	}
}

// PlaceOrderInput mirrors POST /api/orders's request body fields, already
// picked apart by the handler (item/customer presence + menu-item lookup
// are request-shape checks the handler owns — see routes/orders.js's own
// split between route validation and OrderService.placeOrder's domain
// logic).
type PlaceOrderInput struct {
	Item          string
	Note          string
	Customer      string
	NotifyService string
	Variant       string
	Machine       string
	HAUserID      string
	BeanID        any
}

// PlaceOrder ports OrderService.js's placeOrder(...): builds and persists
// a new pending order.
func (s *Service) PlaceOrder(in PlaceOrderInput) (Order, error) {
	active, err := s.repo.FindActive()
	if err != nil {
		return nil, err
	}
	machineID, err := s.resolveMachineID(in.Machine)
	if err != nil {
		return nil, err
	}
	beanID, hasBeanID, err := s.resolveBeanID(in.BeanID)
	if err != nil {
		return nil, err
	}

	order := Order{
		"id":            fmt.Sprintf("ord_%d_%s", time.Now().UnixMilli(), randomToken(4)),
		"createdAt":     time.Now().UnixMilli(),
		"customer":      truncate(strings.TrimSpace(in.Customer), 50),
		"haUserId":      in.HAUserID,
		"item":          in.Item,
		"variant":       nilIfEmpty(truncate(strings.TrimSpace(in.Variant), 50)),
		"note":          truncate(in.Note, 200),
		"notifyService": nilIfEmpty(notifyServiceOrEmpty(in.NotifyService)),
		"machine":       nilIfEmpty(truncate(strings.TrimSpace(in.Machine), 100)),
		"machineId":     machineID,
		"status":        "pending",
		"eta":           nil, "acceptedAt": nil, "completedAt": nil, "declineReason": nil,
	}
	if hasBeanID {
		order["beanId"] = beanID
	} else {
		order["beanId"] = nil
	}

	active = append(active, order)
	if err := s.repo.SaveAll(active); err != nil {
		return nil, err
	}
	s.fireQueueChanged()
	return order, nil
}

func notifyServiceOrEmpty(svc string) string {
	if strings.HasPrefix(svc, "notify.") {
		return truncate(svc, 100)
	}
	return ""
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) > max {
		return string(r[:max])
	}
	return s
}

// AcceptOrder ports OrderService.js's acceptOrder(id, rawEta). Reads and
// writes only this one order row (#901 code review) rather than
// FindActive()+SaveAll()'s whole-queue read-modify-write, which scaled
// every accept/complete/decline with the total size of the active queue.
func (s *Service) AcceptOrder(id string, rawEta any) (Order, error) {
	order, err := s.repo.FindActiveByID(id)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, newOrderError(404, "not found")
	}
	if status, _ := order["status"].(string); status != "pending" {
		return nil, newOrderError(400, "not pending")
	}
	// Mirrors JS's `parseInt(rawEta) || 5`: 0 is falsy in JS too, so an
	// explicit `eta: 0` must also default to 5, not merely an
	// unparseable/absent value (#901 code review).
	eta, ok := jsParseIntAny(rawEta)
	if !ok || eta == 0 {
		eta = 5
	}
	if eta < 1 {
		eta = 1
	}
	if eta > 60 {
		eta = 60
	}
	order["status"] = "accepted"
	order["eta"] = eta
	order["acceptedAt"] = time.Now().UnixMilli()
	if err := s.repo.Save(order); err != nil {
		return nil, err
	}
	item, _ := order["item"].(string)
	s.notifyOrderStatus(order, "☕ "+item+" wird zubereitet", "Fertig in ~"+strconv.FormatInt(eta, 10)+" Min!")
	s.fireQueueChanged()
	return order, nil
}

// CompleteOrder ports OrderService.js's completeOrder(id): status, milk
// stock deduction, matching the latest shot on the order's own target
// machine (#326), and writing an orderedBy annotation back onto that shot.
// Each side effect is independently best-effort, matching Node's try/catch-
// per-step structure — a failure in one must not stop the order from
// completing.
func (s *Service) CompleteOrder(id string) (Order, error) {
	order, err := s.repo.FindActiveByID(id)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, newOrderError(404, "not found")
	}
	order["status"] = "done"
	order["completedAt"] = time.Now().UnixMilli()

	if variant, _ := order["variant"].(string); variant != "" {
		item, _ := order["item"].(string)
		menu, err := s.repo.GetMenu()
		if err == nil {
			for _, m := range menu {
				name, _ := m["name"].(string)
				if name != item {
					continue
				}
				if ml, ok := jsNumber(m["milkMl"]); ok && ml > 0 {
					library.DeductMilkByName(s.libRepo, variant, ml)
				}
				break
			}
		}
	}

	if shotID, ok, err := s.shotsRepo.GetLatestID(orderMachineID(order)); err == nil && ok {
		order["shotId"] = shotID
		if ann, err := s.shotsRepo.GetAnnotation(shotID); err == nil {
			ann["orderedBy"] = map[string]any{
				"customer": order["customer"], "haUserId": order["haUserId"], "orderId": order["id"],
				"item": order["item"], "variant": order["variant"], "note": order["note"],
			}
			s.shotsRepo.SaveAnnotation(shotID, ann)
		}
	} else {
		order["shotId"] = nil
	}

	if err := s.repo.Save(order); err != nil {
		return nil, err
	}
	item, _ := order["item"].(string)
	s.notifyOrderStatus(order, "✓ "+item+" ist fertig!", "Hol dir deinen "+item+" ab — guten Genuss!")
	s.fireQueueChanged()
	return order, nil
}

// DeclineOrder ports OrderService.js's declineOrder(id, rawReason).
func (s *Service) DeclineOrder(id string, rawReason string) (Order, error) {
	order, err := s.repo.FindActiveByID(id)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, newOrderError(404, "not found")
	}
	status, _ := order["status"].(string)
	if status != "pending" && status != "accepted" {
		return nil, newOrderError(400, "cannot decline")
	}
	order["status"] = "declined"
	order["declineReason"] = truncate(rawReason, 200)
	order["completedAt"] = time.Now().UnixMilli()
	if err := s.repo.Save(order); err != nil {
		return nil, err
	}
	item, _ := order["item"].(string)
	declineReason, _ := order["declineReason"].(string)
	msg := "Deine Bestellung wurde leider abgelehnt."
	if declineReason != "" {
		msg = "Grund: " + declineReason
	}
	s.notifyOrderStatus(order, "✕ "+item+" abgelehnt", msg)
	s.fireQueueChanged()
	return order, nil
}

// matchesMachine ports routes/orders.js's _matchesMachine(order,
// machineIdParam): machineIdParam == 0 means "no filter" (query param
// omitted).
func matchesMachine(order Order, machineIDParam int64) bool {
	if machineIDParam == 0 {
		return true
	}
	return orderMachineID(order) == machineIDParam
}
