package library

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// Repository ports lib/repositories/LibraryRepository.js's getLibrary()/
// saveLibrary() — the only two LibraryRepository methods this phase needs.
// Every other LibraryRepository method (getMaintenance/saveMaintenance/
// getMaintenanceLog/addMaintenanceLogEntry/the raw maintenance backup
// round-trip) belongs to the maintenance domain (routes/maintenance.js),
// still a Phase 0 placeholder (internal/maintenance) — see doc.go and
// handlers.go's deleteGrinder doc comment for the one place this package
// would otherwise need them.
type Repository struct {
	db *sql.DB
}

// NewRepository wraps an already-open *sql.DB (see internal/db.Open).
func NewRepository(db *sql.DB) *Repository {
	return &Repository{db: db}
}

// libraryRow mirrors the JSON shape stored under library.key = 'main' —
// decoded leniently (a stored blob predating a given collection simply
// leaves that Go slice nil, cleaned up to [] by GetLibrary below), not
// necessarily the same shape as the Library struct's own json tags (kept
// identical here deliberately, but decoded into its own type to keep the
// "raw stored shape" and "always-non-nil public shape" concerns separate).
type libraryRow struct {
	Beans       []Entity `json:"beans"`
	Grinders    []Entity `json:"grinders"`
	Recipes     []Entity `json:"recipes"`
	Milks       []Entity `json:"milks"`
	Baskets     []Entity `json:"baskets"`
	PuckScreens []Entity `json:"puckScreens"`
}

// GetLibrary ports LibraryRepository.js's getLibrary(): reads the single
// `library` row (key='main'), falling back to an empty Library (every
// collection []) when no row exists yet — a fresh install's first read.
func (r *Repository) GetLibrary() (Library, error) {
	var raw string
	err := r.db.QueryRow(`SELECT data FROM library WHERE key = 'main'`).Scan(&raw)
	if err == sql.ErrNoRows {
		return newLibrary(), nil
	}
	if err != nil {
		return Library{}, fmt.Errorf("library: reading library: %w", err)
	}
	var row libraryRow
	if err := json.Unmarshal([]byte(raw), &row); err != nil {
		return Library{}, fmt.Errorf("library: decoding library: %w", err)
	}
	lib := Library{
		Beans:       row.Beans,
		Grinders:    row.Grinders,
		Recipes:     row.Recipes,
		Milks:       row.Milks,
		Baskets:     row.Baskets,
		PuckScreens: row.PuckScreens,
	}
	if lib.Beans == nil {
		lib.Beans = []Entity{}
	}
	if lib.Grinders == nil {
		lib.Grinders = []Entity{}
	}
	if lib.Recipes == nil {
		lib.Recipes = []Entity{}
	}
	if lib.Milks == nil {
		lib.Milks = []Entity{}
	}
	if lib.Baskets == nil {
		lib.Baskets = []Entity{}
	}
	if lib.PuckScreens == nil {
		lib.PuckScreens = []Entity{}
	}
	return lib, nil
}

// SaveLibrary ports LibraryRepository.js's saveLibrary(lib): an
// INSERT-OR-REPLACE upsert of the whole blob under key='main', same
// whole-document-rewrite semantics as the Node original (no per-field
// diffing/locking — every handler in this package does its own
// read-mutate-save round trip per request, matching routes/library/*.js's
// loadLibrary()/mutate/saveLibrary() pattern exactly, including its
// same-caveats-as-Node lack of cross-request atomicity).
func (r *Repository) SaveLibrary(lib Library) error {
	b, err := json.Marshal(lib)
	if err != nil {
		return fmt.Errorf("library: encoding library: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO library (key, data) VALUES ('main', ?)`, string(b)); err != nil {
		return fmt.Errorf("library: saving library: %w", err)
	}
	return nil
}
