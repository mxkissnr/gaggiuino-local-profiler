package orders

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// This file ports lib/repositories/OrderRepository.js's DB access — the
// `orders` table plus the three kv-table keys (menu/orders_settings/
// notify_mapping) this domain owns.

// ordersHistoryTTL mirrors lib/constants.js's ORDERS_HISTORY_TTL_MS (7
// days): findActive()'s cutoff for how long a done/declined order stays in
// the "live queue" view before FindActive stops returning it (FindAll
// still returns it — see that method's doc comment).
const ordersHistoryTTL = 7 * 24 * time.Hour

// Order is one order record: a map, not a struct, for the same reason
// shots.Shot and library.Entity are maps — routes/orders.js and
// OrderService.js never declare a fixed shape either, they read/write
// plain JS objects straight into/out of the `orders` table's JSON blob.
type Order = map[string]any

// Repository wraps an already-open *sql.DB (see internal/db.Open).
type Repository struct {
	db *sql.DB
}

// NewRepository wraps db.
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

func decodeOrder(data string) (Order, error) {
	var o Order
	if err := json.Unmarshal([]byte(data), &o); err != nil {
		return nil, fmt.Errorf("orders: decoding order: %w", err)
	}
	return o, nil
}

// FindActive ports OrderRepository.js's findActive(): pending/accepted
// orders, plus done/declined orders completed within the last
// ordersHistoryTTL — the "live queue" view every route except stats/
// history-delete reads from.
func (r *Repository) FindActive() ([]Order, error) {
	all, err := r.FindAll()
	if err != nil {
		return nil, err
	}
	out := make([]Order, 0, len(all))
	for _, o := range all {
		if isActiveOrder(o) {
			out = append(out, o)
		}
	}
	return out, nil
}

// isActiveOrder is FindActive's per-order inclusion test, factored out so
// FindActiveByID can apply the identical rule to a single row without
// loading/decoding every order in the table.
func isActiveOrder(o Order) bool {
	status, _ := o["status"].(string)
	if status == "pending" || status == "accepted" {
		return true
	}
	completedAt, ok := jsNumber(o["completedAt"])
	if !ok {
		return false
	}
	cutoff := time.Now().Add(-ordersHistoryTTL).UnixMilli()
	return completedAt > float64(cutoff)
}

// FindActiveByID ports the "locate one order within the same active-queue
// view FindActive returns" lookup AcceptOrder/CompleteOrder/DeclineOrder
// each need (#901 code review): a single indexed SELECT by id followed by
// isActiveOrder's check, instead of loading and decoding the whole active
// set just to find one row by id. An id that exists in the table but has
// aged out of the active window (done/declined beyond ordersHistoryTTL)
// still reports as "not found" here, matching OrderService.js's own
// `repo.findActive().find(o => o.id === id)` lookup exactly — this is a
// narrower, indexed version of that same check, not a behavior change.
func (r *Repository) FindActiveByID(id string) (Order, error) {
	o, err := r.FindByID(id)
	if err != nil || o == nil {
		return nil, err
	}
	if !isActiveOrder(o) {
		return nil, nil
	}
	return o, nil
}

func jsNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int64:
		return float64(t), true
	}
	return 0, false
}

// FindAll ports OrderRepository.js's findAll(): every order, unfiltered by
// age — used by /api/orders/stats (#321, true lifetime totals) and
// /api/orders/history's delete (which must reach done/declined orders
// older than the 7-day TTL window FindActive applies).
func (r *Repository) FindAll() ([]Order, error) {
	rows, err := r.db.Query(`SELECT data FROM orders`)
	if err != nil {
		return nil, fmt.Errorf("orders: listing: %w", err)
	}
	defer rows.Close()
	out := []Order{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			return nil, fmt.Errorf("orders: scanning row: %w", err)
		}
		o, err := decodeOrder(data)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// FindByID ports OrderRepository.js's findById.
func (r *Repository) FindByID(id string) (Order, error) {
	var data string
	err := r.db.QueryRow(`SELECT data FROM orders WHERE id = ?`, id).Scan(&data)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("orders: getting %s: %w", id, err)
	}
	return decodeOrder(data)
}

func orderMachineID(o Order) int64 {
	if v, ok := jsNumber(o["machineId"]); ok {
		return int64(v)
	}
	return 1
}

// Save ports OrderRepository.js's save(order): upserts one order.
func (r *Repository) Save(order Order) error {
	data, err := json.Marshal(order)
	if err != nil {
		return fmt.Errorf("orders: encoding order: %w", err)
	}
	id, _ := order["id"].(string)
	if _, err := r.db.Exec(
		`INSERT OR REPLACE INTO orders (id, data, machine_id) VALUES (?,?,?)`,
		id, string(data), orderMachineID(order),
	); err != nil {
		return fmt.Errorf("orders: saving %s: %w", id, err)
	}
	return nil
}

// SaveAll ports OrderRepository.js's saveAll(orders): upserts every order
// in one transaction — used by the lifecycle mutations (place/accept/
// complete/decline), each of which reads the whole active set, mutates one
// entry, and writes the whole set back.
func (r *Repository) SaveAll(orders []Order) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("orders: starting save tx: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO orders (id, data, machine_id) VALUES (?,?,?)`)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("orders: preparing save: %w", err)
	}
	defer stmt.Close()
	for _, o := range orders {
		data, err := json.Marshal(o)
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("orders: encoding order: %w", err)
		}
		id, _ := o["id"].(string)
		if _, err := stmt.Exec(id, string(data), orderMachineID(o)); err != nil {
			tx.Rollback()
			return fmt.Errorf("orders: saving %s: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("orders: committing save: %w", err)
	}
	return nil
}

// Delete ports OrderRepository.js's delete(id).
func (r *Repository) Delete(id string) error {
	if _, err := r.db.Exec(`DELETE FROM orders WHERE id = ?`, id); err != nil {
		return fmt.Errorf("orders: deleting %s: %w", id, err)
	}
	return nil
}

// ReplaceAll ports OrderRepository.js's replaceAll(orders): restore-only —
// wipes the whole table and re-inserts, unlike SaveAll's upsert-only
// semantics, so an order that existed locally but isn't in the restored
// set is actually removed. Used by the backup domain (see
// go/internal/backup/doc.go); not called by anything in this phase's own
// handlers.
func (r *Repository) ReplaceAll(orders []Order) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("orders: starting replace tx: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM orders`); err != nil {
		tx.Rollback()
		return fmt.Errorf("orders: clearing table: %w", err)
	}
	stmt, err := tx.Prepare(`INSERT OR REPLACE INTO orders (id, data, machine_id) VALUES (?,?,?)`)
	if err != nil {
		tx.Rollback()
		return fmt.Errorf("orders: preparing replace: %w", err)
	}
	defer stmt.Close()
	for _, o := range orders {
		data, err := json.Marshal(o)
		if err != nil {
			tx.Rollback()
			return fmt.Errorf("orders: encoding order: %w", err)
		}
		id, _ := o["id"].(string)
		if _, err := stmt.Exec(id, string(data), orderMachineID(o)); err != nil {
			tx.Rollback()
			return fmt.Errorf("orders: replacing %s: %w", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("orders: committing replace: %w", err)
	}
	return nil
}

// defaultMenu mirrors lib/constants.js's DEFAULT_MENU — the seed menu a
// fresh install (no `menu` kv row yet) returns.
func defaultMenu() []MenuItem {
	return []MenuItem{
		{"id": "espresso", "name": "Espresso", "emoji": "☕"},
		{"id": "ristretto", "name": "Ristretto", "emoji": "☕"},
		{"id": "lungo", "name": "Lungo", "emoji": "☕"},
		{"id": "cappuccino", "name": "Cappuccino", "emoji": "🥛"},
		{"id": "latte", "name": "Latte Macchiato", "emoji": "🥛"},
		{"id": "flat_white", "name": "Flat White", "emoji": "🥛"},
	}
}

// MenuItem mirrors MenuItem in openapi.yaml — a map for the same reason
// Order is.
type MenuItem = map[string]any

func (r *Repository) getKV(key string, out any) (bool, error) {
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&value)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("orders: reading kv %s: %w", key, err)
	}
	if err := json.Unmarshal([]byte(value), out); err != nil {
		return false, fmt.Errorf("orders: decoding kv %s: %w", key, err)
	}
	return true, nil
}

func (r *Repository) saveKV(key string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("orders: encoding kv %s: %w", key, err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, string(data)); err != nil {
		return fmt.Errorf("orders: saving kv %s: %w", key, err)
	}
	return nil
}

// GetMenu ports OrderRepository.js's getMenu(): DEFAULT_MENU when no
// `menu` kv row exists yet.
func (r *Repository) GetMenu() ([]MenuItem, error) {
	var menu []MenuItem
	found, err := r.getKV("menu", &menu)
	if err != nil {
		return nil, err
	}
	if !found {
		return defaultMenu(), nil
	}
	return menu, nil
}

// SaveMenu ports OrderRepository.js's saveMenu(menu).
func (r *Repository) SaveMenu(menu []MenuItem) error {
	return r.saveKV("menu", menu)
}

// Settings mirrors OrdersSettings in openapi.yaml — a map for the same
// reason Order is (arbitrary notify_* toggle keys, see NOTIFY_TOGGLE_KEYS
// in service.go).
type Settings = map[string]any

func defaultSettings() Settings {
	return Settings{"enabled": true, "broadcastRecipients": []any{}}
}

// GetSettings ports OrderRepository.js's getSettings().
func (r *Repository) GetSettings() (Settings, error) {
	var s Settings
	found, err := r.getKV("orders_settings", &s)
	if err != nil {
		return nil, err
	}
	if !found {
		return defaultSettings(), nil
	}
	return s, nil
}

// SaveSettings ports OrderRepository.js's saveSettings(settings).
func (r *Repository) SaveSettings(s Settings) error {
	return r.saveKV("orders_settings", s)
}

// NotifyMapping mirrors NotifyMapping in openapi.yaml: haUserId -> notify
// service name.
type NotifyMapping = map[string]string

// GetNotifyMapping ports OrderRepository.js's getNotifyMapping().
func (r *Repository) GetNotifyMapping() (NotifyMapping, error) {
	var m NotifyMapping
	found, err := r.getKV("notify_mapping", &m)
	if err != nil {
		return nil, err
	}
	if !found {
		return NotifyMapping{}, nil
	}
	return m, nil
}

// SaveNotifyMapping ports OrderRepository.js's saveNotifyMapping(mapping).
func (r *Repository) SaveNotifyMapping(m NotifyMapping) error {
	return r.saveKV("notify_mapping", m)
}
