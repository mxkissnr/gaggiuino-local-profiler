package machines

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Registry ports lib/machines/registry.js: one row per configured espresso
// machine, backed by the `machines` table internal/db already creates
// (see internal/db/db.go). Deliberately NOT ported here: restoreMachines()
// (routes/backup.js's POST /api/restore path — belongs to the not-yet-built
// backup domain, same deferral pattern internal/library used for its own
// backup-only repository methods, see internal/library/repository.go) and
// options-adoption.js's legacy-options reconciliation (also backup-restore-
// triggered). ensureDefaultMachine's #718 seed-from-legacy-options behavior
// is ported in a reduced form — see its own doc comment below.
type Registry struct {
	db *sql.DB
}

// NewRegistry wraps an already-open *sql.DB (see internal/db.Open).
func NewRegistry(db *sql.DB) *Registry {
	return &Registry{db: db}
}

type machineRow struct {
	ID             int64
	Name           string
	Type           string
	Host           string
	SwitchEntity   sql.NullString
	Theme          sql.NullString
	HasWaterSensor bool
	IsDefault      bool
	Enabled        bool
	CreatedAt      int64
}

func (r machineRow) toMachine() Machine {
	m := Machine{
		ID: r.ID, Name: r.Name, Type: r.Type, Host: r.Host,
		HasWaterSensor: r.HasWaterSensor,
		IsDefault:      r.IsDefault, Enabled: r.Enabled, CreatedAt: r.CreatedAt,
	}
	if r.SwitchEntity.Valid {
		s := r.SwitchEntity.String
		m.SwitchEntity = &s
	}
	if r.Theme.Valid {
		m.Theme = parseTheme(&r.Theme.String)
	}
	return m
}

const selectMachineColumns = `id, name, type, host, switch_entity, theme, has_water_sensor, is_default, enabled, created_at`

func scanMachineRow(scanner interface{ Scan(...any) error }) (machineRow, error) {
	var r machineRow
	err := scanner.Scan(&r.ID, &r.Name, &r.Type, &r.Host, &r.SwitchEntity, &r.Theme, &r.HasWaterSensor, &r.IsDefault, &r.Enabled, &r.CreatedAt)
	return r, err
}

// EnsureDefaultMachine ports ensureDefaultMachine(): idempotent, seeds
// machine #1 if the registry is still empty. registry.js seeds it from
// config.yaml's legacy machine_host/switch_entity add-on options
// (lib/data.js's loadOptions()) — go/internal/system (the options.json
// facade) doesn't exist yet in this phase, so this Go port seeds an empty
// "not configured yet" machine #1 instead (empty host/switchEntity, #718's
// same "empty is a valid not-configured state" convention Node itself
// falls back to when no legacy option is set). A future system-domain
// package can extend this to read real options.json once it exists; no
// currently-shipped behavior regresses since this binary isn't wired into
// the add-on yet (see go/README.md).
func (r *Registry) EnsureDefaultMachine() error {
	var count int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM machines`).Scan(&count); err != nil {
		return fmt.Errorf("machines: counting registry: %w", err)
	}
	if count > 0 {
		return nil
	}
	_, err := r.db.Exec(
		`INSERT INTO machines (id, name, type, host, switch_entity, is_default, enabled, created_at)
		 VALUES (1, 'Gaggiuino', 'gaggiuino', '', NULL, 1, 1, ?)`,
		time.Now().UnixMilli(),
	)
	if err != nil {
		return fmt.Errorf("machines: seeding default machine: %w", err)
	}
	return nil
}

// ListMachines ports listMachines(): ordered default-first, then by id.
func (r *Registry) ListMachines() ([]Machine, error) {
	rows, err := r.db.Query(`SELECT ` + selectMachineColumns + ` FROM machines ORDER BY is_default DESC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("machines: listing: %w", err)
	}
	defer rows.Close()
	out := []Machine{}
	for rows.Next() {
		row, err := scanMachineRow(rows)
		if err != nil {
			return nil, fmt.Errorf("machines: scanning row: %w", err)
		}
		out = append(out, row.toMachine())
	}
	return out, rows.Err()
}

// GetMachine ports getMachine(id): nil, nil (not an error) when not found.
func (r *Registry) GetMachine(id int64) (*Machine, error) {
	row := r.db.QueryRow(`SELECT `+selectMachineColumns+` FROM machines WHERE id = ?`, id)
	mr, err := scanMachineRow(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("machines: getting #%d: %w", id, err)
	}
	m := mr.toMachine()
	return &m, nil
}

// GetDefaultMachine ports getDefaultMachine(): ensures the registry is
// seeded, then returns the is_default row, falling back to the first row
// by id if (unexpectedly) none is flagged default.
func (r *Registry) GetDefaultMachine() (*Machine, error) {
	if err := r.EnsureDefaultMachine(); err != nil {
		return nil, err
	}
	row := r.db.QueryRow(`SELECT ` + selectMachineColumns + ` FROM machines WHERE is_default = 1 LIMIT 1`)
	mr, err := scanMachineRow(row)
	if err == nil {
		m := mr.toMachine()
		return &m, nil
	}
	if err != sql.ErrNoRows {
		return nil, fmt.Errorf("machines: getting default: %w", err)
	}
	all, err := r.ListMachines()
	if err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return nil, nil
	}
	return &all[0], nil
}

// CreateMachine ports createMachine(): input has already been validated by
// the caller (handlers.go) via MachineInput.validate(true) — Name/Type/Host
// are guaranteed non-nil there.
func (r *Registry) CreateMachine(in MachineInput) (*Machine, error) {
	themeStr, err := themeJSON(in.Theme)
	if err != nil {
		return nil, fmt.Errorf("machines: encoding theme: %w", err)
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	hasWaterSensor := false
	if in.HasWaterSensor != nil {
		hasWaterSensor = *in.HasWaterSensor
	}
	res, err := r.db.Exec(
		`INSERT INTO machines (name, type, host, switch_entity, theme, has_water_sensor, is_default, enabled, created_at)
		 VALUES (?,?,?,?,?,?,0,?,?)`,
		*in.Name, *in.Type, *in.Host, nullableString(in.SwitchEntity), nullableString(themeStr),
		boolToInt(hasWaterSensor), boolToInt(enabled), time.Now().UnixMilli(),
	)
	if err != nil {
		return nil, fmt.Errorf("machines: creating: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("machines: reading new id: %w", err)
	}
	return r.GetMachine(id)
}

// UpdateMachine ports updateMachine(id, fields): partial update, omitted
// fields (nil pointers) keep their current value. Returns (nil, nil) if id
// doesn't exist. onHostChanged is invoked with the OLD host string whenever
// Host changes OR Type changes (even with Host unchanged) — the caller
// wires this to live-session eviction (registry.js's
// evictLiveSession(existing.host)), kept as an injected callback here
// instead of a direct dependency so this package's data layer doesn't need
// to import its own WS-client file (avoids a needless internal coupling;
// ws.go's evictSession has the same signature). The Type-change trigger
// (#901 code review) matters even when Host stays the same: switching a
// machine from "gaggiuino" to "gaggimate" must tear down the old
// gaggiuinoLiveClient session for that host too, or its reconnect goroutine
// keeps retrying forever against a host nothing identifies as Gaggiuino
// anymore (GaggiMateAdapter never calls live.Disconnect on its own).
func (r *Registry) UpdateMachine(id int64, fields MachineInput, onHostChanged func(oldHost string)) (*Machine, error) {
	existing, err := r.GetMachine(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, nil
	}

	name := existing.Name
	if fields.Name != nil {
		name = *fields.Name
	}
	typ := existing.Type
	if fields.Type != nil {
		typ = *fields.Type
	}
	host := existing.Host
	if fields.Host != nil {
		host = *fields.Host
	}
	switchEntity := existing.SwitchEntity
	if fields.SwitchEntity != nil {
		switchEntity = fields.SwitchEntity
	}
	theme := existing.Theme
	if fields.Theme != nil {
		theme = fields.Theme
	}
	hasWaterSensor := existing.HasWaterSensor
	if fields.HasWaterSensor != nil {
		hasWaterSensor = *fields.HasWaterSensor
	}
	enabled := existing.Enabled
	if fields.Enabled != nil {
		enabled = *fields.Enabled
	}

	themeStr, err := themeJSON(theme)
	if err != nil {
		return nil, fmt.Errorf("machines: encoding theme: %w", err)
	}
	_, err = r.db.Exec(
		`UPDATE machines SET name=?, type=?, host=?, switch_entity=?, theme=?, has_water_sensor=?, enabled=? WHERE id=?`,
		name, typ, host, nullableString(switchEntity), nullableString(themeStr), boolToInt(hasWaterSensor), boolToInt(enabled), id,
	)
	if err != nil {
		return nil, fmt.Errorf("machines: updating #%d: %w", id, err)
	}

	hostChanged := fields.Host != nil && *fields.Host != existing.Host
	typeChanged := fields.Type != nil && *fields.Type != existing.Type
	if (hostChanged || typeChanged) && onHostChanged != nil {
		onHostChanged(existing.Host)
	}
	return r.GetMachine(id)
}

// SetDefaultMachine ports setDefaultMachine(id) (#753): reassigns
// is_default transactionally. Returns (nil, nil) if id doesn't exist;
// returns the machine unchanged (no-op) if it's already the default.
func (r *Registry) SetDefaultMachine(id int64) (*Machine, error) {
	existing, err := r.GetMachine(id)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, nil
	}
	if existing.IsDefault {
		return existing, nil
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("machines: starting transaction: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once committed
	if _, err := tx.Exec(`UPDATE machines SET is_default = (id = ?)`, id); err != nil {
		return nil, fmt.Errorf("machines: setting default #%d: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("machines: committing default change: %w", err)
	}
	return r.GetMachine(id)
}

// ErrCannotDeleteDefault / ErrCannotDeleteLastMachine port deleteMachine()'s
// two guard-thrown Errors verbatim, as sentinel errors handlers.go maps to
// the same 400 responses routes/machines.js's catch block produces.
var (
	ErrCannotDeleteDefault     = fmt.Errorf("cannot delete the default machine")
	ErrCannotDeleteLastMachine = fmt.Errorf("cannot delete the last remaining machine")
)

// DeleteMachine ports deleteMachine(id). Returns (false, nil) if id
// doesn't exist (matching routes/machines.js's 404 branch); onHostEvicted
// mirrors UpdateMachine's onHostChanged callback.
func (r *Registry) DeleteMachine(id int64, onHostEvicted func(host string)) (bool, error) {
	existing, err := r.GetMachine(id)
	if err != nil {
		return false, err
	}
	if existing == nil {
		return false, nil
	}
	if existing.IsDefault {
		return false, ErrCannotDeleteDefault
	}
	var count int
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM machines`).Scan(&count); err != nil {
		return false, fmt.Errorf("machines: counting registry: %w", err)
	}
	if count <= 1 {
		return false, ErrCannotDeleteLastMachine
	}
	if _, err := r.db.Exec(`DELETE FROM machines WHERE id = ?`, id); err != nil {
		return false, fmt.Errorf("machines: deleting #%d: %w", id, err)
	}
	if onHostEvicted != nil {
		onHostEvicted(existing.Host)
	}
	return true, nil
}

// RestoreMachines ports registry.js's restoreMachines(machines) (Phase 1f,
// #901): wipes and re-inserts the whole `machines` table from a backup's
// `machines` array, validating each entry the same way MachineInput.validate
// does for a live POST/PUT, then enforcing exactly one is_default row
// (lowest id wins on a tie/absence, matching the Node original). Returns
// the count of entries actually restored (out of len(in)) — an invalid
// entry (bad id, or a field that fails machineSchema-equivalent validation)
// is skipped, not fatal to the rest of the restore, matching Node's
// per-entry try/skip loop.
//
// Deliberately NOT ported here (see go/internal/machines/doc.go for the
// full rationale): evictLiveSession(oldHost) for every host that existed
// before the restore (this package's own live WS sessions reconnect/fail
// naturally against a host that no longer resolves to any machine, rather
// than being torn down immediately) and options-adoption.js's
// reconcileAfterRestore() (ties a restored machine's stale host/
// switchEntity back to the current legacy add-on options.json — that
// facade doesn't exist in this Go port yet, see internal/orders/options.go
// for the same options.json-facade gap noted elsewhere in this rewrite).
func (r *Registry) RestoreMachines(in []Machine) (restored int, err error) {
	type validated struct {
		id              int64
		name, typ, host string
		switchEntity    *string
		theme           *string
		isDefault       bool
		enabled         bool
		createdAt       int64
	}
	valid := make([]validated, 0, len(in))
	for _, m := range in {
		if m.ID <= 0 {
			continue
		}
		name := m.Name
		typ := m.Type
		host := m.Host
		input := MachineInput{Name: &name, Type: &typ, Host: &host, SwitchEntity: m.SwitchEntity, Theme: m.Theme}
		if err := input.validate(true); err != nil {
			continue
		}
		themeStr, err := themeJSON(m.Theme)
		if err != nil {
			continue
		}
		createdAt := m.CreatedAt
		if createdAt == 0 {
			createdAt = time.Now().UnixMilli()
		}
		valid = append(valid, validated{
			id: m.ID, name: name, typ: typ, host: host, switchEntity: m.SwitchEntity,
			theme: themeStr, isDefault: m.IsDefault, enabled: m.Enabled, createdAt: createdAt,
		})
	}

	// #901 code review: a backup whose `machines` section is entirely
	// unusable (every entry fails validate()) must leave the existing
	// registry untouched rather than wiping it down to zero rows for a
	// restore that didn't actually restore anything — matching every other
	// section's "skip, don't destroy" handling of unusable restore data
	// (see e.g. buildRestorePlan's per-row sanitize-or-drop loops).
	if len(valid) == 0 {
		return 0, nil
	}

	tx, err := r.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("machines: starting restore tx: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM machines`); err != nil {
		tx.Rollback()
		return 0, fmt.Errorf("machines: clearing table: %w", err)
	}
	stmt, err := tx.Prepare(
		`INSERT INTO machines (id, name, type, host, switch_entity, theme, is_default, enabled, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
	)
	if err != nil {
		tx.Rollback()
		return 0, fmt.Errorf("machines: preparing restore: %w", err)
	}
	for _, v := range valid {
		if _, err := stmt.Exec(
			v.id, v.name, v.typ, v.host, nullableString(v.switchEntity), nullableString(v.theme),
			boolToInt(v.isDefault), boolToInt(v.enabled), v.createdAt,
		); err != nil {
			stmt.Close()
			tx.Rollback()
			return 0, fmt.Errorf("machines: restoring #%d: %w", v.id, err)
		}
	}
	stmt.Close()

	// Enforce exactly one is_default row (lowest id wins on a tie/absence).
	rows, err := tx.Query(`SELECT id, is_default FROM machines ORDER BY id ASC`)
	if err != nil {
		tx.Rollback()
		return 0, fmt.Errorf("machines: reading restored rows: %w", err)
	}
	var winnerID int64
	haveWinner := false
	defaultCount := 0
	for rows.Next() {
		var id int64
		var isDefault bool
		if err := rows.Scan(&id, &isDefault); err != nil {
			rows.Close()
			tx.Rollback()
			return 0, fmt.Errorf("machines: scanning restored row: %w", err)
		}
		if !haveWinner {
			winnerID = id
			haveWinner = true
		}
		if isDefault {
			defaultCount++
			if defaultCount == 1 {
				winnerID = id
			}
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		tx.Rollback()
		return 0, err
	}
	if defaultCount != 1 && haveWinner {
		if _, err := tx.Exec(`UPDATE machines SET is_default = (id = ?)`, winnerID); err != nil {
			tx.Rollback()
			return 0, fmt.Errorf("machines: correcting is_default: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("machines: committing restore: %w", err)
	}
	return len(valid), nil
}

// ResolveMachine ports registry.js's resolveMachine(rawId) (#679): an
// explicit machineId if it names a known machine, otherwise the default
// machine. rawId == nil means "no machineId given at all" (query/body
// param absent), matching every existing call site's convention.
func (r *Registry) ResolveMachine(rawID *int64) (*Machine, error) {
	if err := r.EnsureDefaultMachine(); err != nil {
		return nil, err
	}
	if rawID != nil {
		m, err := r.GetMachine(*rawID)
		if err != nil {
			return nil, err
		}
		if m != nil {
			return m, nil
		}
	}
	return r.GetDefaultMachine()
}

// guardVar is a small atomic-swap wrapper around a function value — used
// for the machineHostGuard/machineHostGuardResolved test seams below.
// Plain package-level func vars read directly (no synchronization) by a
// background goroutine (live.go's reconnect loop, http.go's dial path)
// while a test reassigns them from its own goroutine is a genuine data
// race under -race, even though production code never reassigns them
// after init (#986/#987 code review, caught by CI's -race run on PR #990).
// get/set go through atomic.Pointer instead of a bare variable so a
// concurrent reassignment is safe.
type guardVar[F any] struct {
	p atomic.Pointer[F]
}

func newGuardVar[F any](initial F) *guardVar[F] {
	g := &guardVar[F]{}
	g.p.Store(&initial)
	return g
}

func (g *guardVar[F]) get() F {
	return *g.p.Load()
}

// set stores f and returns the previous value, so a test can restore it
// via t.Cleanup(func() { v.set(prev) }).
func (g *guardVar[F]) set(f F) F {
	prev := g.get()
	g.p.Store(&f)
	return prev
}

// machineHostGuard is assertMachineHost by default — a package-level var
// (same testing seam pattern as ssrf.go's lookupIPAddr) so tests exercising
// an adapter end-to-end against an httptest.Server (which only ever binds
// to 127.0.0.1, a loopback address assertMachineHost correctly blocks for
// any real machine host) can substitute a permissive stub instead of
// weakening the real SSRF guard itself.
var machineHostGuard = newGuardVar[func(context.Context, string) error](assertMachineHost)

// machineHostGuardResolved is assertMachineHostResolved by default — the
// same testing seam as machineHostGuard, but for guardedDialContext's
// (http.go) dial-time pinning check (#987): allowLoopbackMachineHost
// overrides both together so an httptest.Server-backed fake machine still
// gets dialed in tests.
var machineHostGuardResolved = newGuardVar[func(context.Context, string) (net.IP, error)](assertMachineHostResolved)

// BaseURLFor ports the adapters' shared baseUrlFor(machine) helper
// (lib/machines/gaggiuino/adapter.js and gaggimate/adapter.js define the
// identical function twice — consolidated here to one place, since both Go
// adapters need it and there's no reason to keep the duplication Node has).
// Re-validates the host on every call (not just at machine-save time),
// same defense-in-depth rationale as the Node original's header comment.
//
// #901 code review asked whether a DNS-TTL cache belongs here to save the
// repeat resolution: deliberately NOT added. Caching a hostname's resolved
// address across calls is exactly the shape of a DNS-rebinding hole — a
// hostname could resolve to a public address at cache-fill time (passing
// machineHostGuard) and be re-pointed at a private/loopback/metadata
// address by the time a cached result is reused, skipping the guard
// entirely for every call after the first. Re-resolving on every call is
// the whole point of the defense-in-depth rationale above; a cache would
// undermine it for a marginal latency win on an already-infrequent path
// (once per outbound machine call, not a hot loop). Security over
// performance here.
func BaseURLFor(ctx context.Context, m *Machine) (string, error) {
	raw := strings.TrimSpace(m.Host)
	normalized := raw
	if !strings.HasPrefix(strings.ToLower(raw), "http://") && !strings.HasPrefix(strings.ToLower(raw), "https://") {
		normalized = "http://" + raw
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return "", fmt.Errorf("invalid host: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("invalid URL scheme: %s:", u.Scheme)
	}
	if err := machineHostGuard.get()(ctx, u.Hostname()); err != nil {
		return "", err
	}
	return u.Scheme + "://" + u.Host, nil
}

// hostnameOf ports routes/machines.js's validateHost()'s hostname
// extraction: accepts a bare host or one already prefixed with a scheme,
// returns just the hostname portion for assertMachineHost to resolve.
func hostnameOf(host string) (string, error) {
	normalized := host
	lower := strings.ToLower(host)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		normalized = "http://" + host
	}
	u, err := url.Parse(normalized)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("invalid host")
	}
	return u.Hostname(), nil
}

func nullableString(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
