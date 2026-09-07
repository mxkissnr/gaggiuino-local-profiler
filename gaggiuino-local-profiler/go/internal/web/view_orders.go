package web

import (
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// toOrderRow builds a templates.OrderRow from an orders.Order — the Go-side
// equivalent of public-src/views/orders.js's renderOrderCard's field
// extraction for the "pending"/"accepted" cases (the "history" case isn't
// built here — this queue page only ever shows FindActive's pending/
// accepted orders, see handlers_orders.go's queueRows).
func toOrderRow(o orders.Order) templates.OrderRow {
	row := templates.OrderRow{}
	if id, ok := o["id"].(string); ok {
		row.ID = id
	}
	if item, ok := o["item"].(string); ok {
		row.Item = item
	}
	if variant, ok := o["variant"].(string); ok {
		row.Variant = variant
	}
	if customer, ok := o["customer"].(string); ok {
		row.Customer = customer
	}
	if note, ok := o["note"].(string); ok {
		row.Note = note
	}
	if status, ok := o["status"].(string); ok {
		row.Status = status
	}
	if createdAt, ok := orderNumber(o["createdAt"]); ok {
		row.CreatedAt = time.UnixMilli(int64(createdAt)).Format("15:04")
	}
	if eta, ok := orderNumber(o["eta"]); ok {
		row.EtaMinutes = int(eta)
	}
	return row
}

// orderNumber tolerates both the in-memory int64 a lifecycle mutation just
// set (AcceptOrder's own return value, before its next JSON round trip
// through the DB) and the float64 every value decodes as after a fresh
// Repository.FindActive() read — the same dual-shape tolerance
// internal/orders' own jsNumber helper applies for exactly this reason.
func orderNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int64:
		return float64(t), true
	case int:
		return float64(t), true
	}
	return 0, false
}

// beanOptionID extracts a library.Entity["id"] the same two shapes
// orderNumber tolerates (int64 fresh from a write, float64 after a JSON
// round trip) — see internal/orders/service.go's beanIDOf, which this
// mirrors for the same reason (library.GetActiveBeans' Entity id is
// whatever shape the underlying bean map already carries).
func beanOptionID(v any) (int64, bool) {
	n, ok := orderNumber(v)
	if !ok {
		return 0, false
	}
	return int64(n), true
}
