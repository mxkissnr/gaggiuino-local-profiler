package importer

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// This file ports lib/repositories/ImportSettingsRepository.js: the import
// provider settings blob stored under kv.key = 'import_settings' (same kv
// pattern as internal/shots' ShotDefaultsRepository port).

// Settings mirrors ImportSettingsRepository.js's shape.
type Settings struct {
	DisabledProviders    []string `json:"disabledProviders"`
	CustomShopifyDomains []string `json:"customShopifyDomains"`
}

// Repository is the kv-backed import-settings store.
type Repository struct{ db *sql.DB }

func NewRepository(db *sql.DB) *Repository { return &Repository{db: db} }

func defaultSettings() Settings {
	return Settings{DisabledProviders: []string{}, CustomShopifyDomains: []string{}}
}

// GetSettings ports ImportSettingsRepository.js's getSettings: DEFAULTS on a
// missing row or malformed JSON; each array coerced to [] when not an array.
func (r *Repository) GetSettings() Settings {
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = 'import_settings'`).Scan(&value)
	if err != nil {
		return defaultSettings()
	}
	var saved struct {
		DisabledProviders    json.RawMessage `json:"disabledProviders"`
		CustomShopifyDomains json.RawMessage `json:"customShopifyDomains"`
	}
	if err := json.Unmarshal([]byte(value), &saved); err != nil {
		return defaultSettings()
	}
	out := defaultSettings()
	var a []string
	if json.Unmarshal(saved.DisabledProviders, &a) == nil && a != nil {
		out.DisabledProviders = a
	}
	a = nil
	if json.Unmarshal(saved.CustomShopifyDomains, &a) == nil && a != nil {
		out.CustomShopifyDomains = a
	}
	return out
}

// SaveSettings ports saveSettings: INSERT OR REPLACE the JSON blob verbatim.
func (r *Repository) SaveSettings(s Settings) error {
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("importer: encoding settings: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('import_settings', ?)`, string(b)); err != nil {
		return fmt.Errorf("importer: saving settings: %w", err)
	}
	return nil
}

// domainRe ports routes/import.js's DOMAIN_RE.
var domainRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$`)

var schemePrefixRe = regexp.MustCompile(`(?i)^https?://`)

// normalizeCustomDomain ports routes/import.js's POST /api/import/settings
// per-domain normalization: strip a leading scheme, cut at the first '/'
// with a plain index lookup (not a regex — CodeQL js/polynomial-redos),
// strip a leading "www.", validate against DOMAIN_RE. Returns "" for a
// rejected entry.
func normalizeCustomDomain(d string) string {
	withoutScheme := schemePrefixRe.ReplaceAllString(strings.ToLower(strings.TrimSpace(d)), "")
	host := withoutScheme
	if i := strings.IndexByte(withoutScheme, '/'); i != -1 {
		host = withoutScheme[:i]
	}
	host = strings.TrimPrefix(host, "www.")
	if domainRe.MatchString(host) {
		return host
	}
	return ""
}
