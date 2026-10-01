package mcp

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
)

// This file holds the app-stored MCP feature toggles (#1288). They used to be
// read from /data/options.json (enable_mcp / enable_mcp_write /
// enable_mcp_developer_tools) once at startup, so changing any of them
// required an add-on restart. They now live in the app database as the kv row
// 'mcp_settings', exactly like 'mqtt_settings' and 'import_settings', so the
// Settings UI can flip them live and cmd/server reads them per request.
//
// No schema migration is needed: 'mcp_settings' is a row in the existing kv
// table (go/internal/db/db.go). The three options.json entries were removed
// from config.yaml in the same slice; MCP is unreleased, so there is nothing
// to migrate.

// Settings is the stored MCP toggle set: the master switch plus the two
// independent opt-ins on top of it. Every field defaults to false.
type Settings struct {
	Enabled             bool `json:"enabled"`
	AllowWrite          bool `json:"allowWrite"`
	AllowDeveloperTools bool `json:"allowDeveloperTools"`
}

// Effective returns the settings as they should actually apply in this
// process: the developer tools are only ever effective on a dev build (the
// GLP_DEV_BUILD channel the debug routes also use), regardless of what is
// stored. Everything else is returned unchanged.
func (s Settings) Effective() Settings {
	if !DevBuild() {
		s.AllowDeveloperTools = false
	}
	return s
}

// DevBuild reports whether this process is the dev-channel build (the
// GLP_DEV_BUILD env var, set by the dev add-on manifest — see
// internal/debug/debug.go, which gates its routes the same way).
func DevBuild() bool { return os.Getenv("GLP_DEV_BUILD") != "" }

// SettingsSource supplies the settings that apply to this process, with the
// dev-build rule already applied (see Settings.Effective). *Repository
// implements it; tests use a static fake. NewHandler treats a nil source as
// "everything off" so a missing dependency can never expose the server.
type SettingsSource interface {
	EffectiveSettings() Settings
}

// Repository is the kv-backed mcp-settings store.
type Repository struct{ db *sql.DB }

func NewRepository(db *sql.DB) *Repository { return &Repository{db: db} }

// GetSettings reads the stored settings. A missing row or malformed JSON
// yields the all-off defaults (every field's default is the zero value, so
// unlike mqtt/settings.go there is nothing to merge onto).
func (r *Repository) GetSettings() Settings {
	var out Settings
	var value string
	if err := r.db.QueryRow(`SELECT value FROM kv WHERE key = 'mcp_settings'`).Scan(&value); err != nil {
		return Settings{}
	}
	if err := json.Unmarshal([]byte(value), &out); err != nil {
		return Settings{}
	}
	return out
}

// EffectiveSettings implements SettingsSource.
func (r *Repository) EffectiveSettings() Settings { return r.GetSettings().Effective() }

// SaveSettings persists s and returns it. The POST handler validates the body
// before calling, so this is a full replace.
func (r *Repository) SaveSettings(s Settings) (Settings, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return Settings{}, fmt.Errorf("mcp: encoding settings: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('mcp_settings', ?)`, string(b)); err != nil {
		return Settings{}, fmt.Errorf("mcp: saving settings: %w", err)
	}
	return s, nil
}
