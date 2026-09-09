package shots

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// This file ports lib/repositories/ShotDefaultsRepository.js (#654):
// per-install defaults auto-prefilled into a new shot's annotation panel,
// stored as one JSON blob under kv.key = 'shot_defaults'.

// shotDefaultsZero mirrors ShotDefaultsRepository.js's DEFAULTS.
func shotDefaultsZero() map[string]any {
	return map[string]any{
		"drinkType":    nil,
		"coffee":       nil,
		"beanId":       nil,
		"basketId":     nil,
		"puckScreenId": nil,
		"grinder":      "",
		"dose":         nil,
	}
}

// GetShotDefaults ports ShotDefaultsRepository.js's getDefaults: DEFAULTS
// merged with whatever's stored, falling back to DEFAULTS whole-sale on a
// missing row or malformed stored JSON (mirrors the `catch { return {
// ...DEFAULTS } }` in the Node original).
func (r *Repository) GetShotDefaults() (map[string]any, error) {
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = 'shot_defaults'`).Scan(&value)
	if err == sql.ErrNoRows {
		return shotDefaultsZero(), nil
	}
	if err != nil {
		return nil, fmt.Errorf("shots: reading shot defaults: %w", err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(value), &stored); err != nil {
		return shotDefaultsZero(), nil
	}
	out := shotDefaultsZero()
	for k, v := range stored {
		out[k] = v
	}
	return out, nil
}

// SaveShotDefaults ports ShotDefaultsRepository.js's saveDefaults.
func (r *Repository) SaveShotDefaults(defaults map[string]any) error {
	b, err := json.Marshal(defaults)
	if err != nil {
		return fmt.Errorf("shots: encoding shot defaults: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('shot_defaults', ?)`, string(b)); err != nil {
		return fmt.Errorf("shots: saving shot defaults: %w", err)
	}
	return nil
}
