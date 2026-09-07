package backup

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// This file ports the two lib/repositories/*SettingsRepository.js files
// nothing else in this Go rewrite has ported yet (MqttSettingsRepository,
// ImportSettingsRepository) — narrowly, just the get/save round trip
// GET/POST /api/backup's `kv` block needs, the same "duplicate a small
// slice rather than block on a whole not-yet-ported domain" trade-off
// internal/orders/options.go already made for isOrdersEnabled(). Neither
// Settings-page feature (MQTT transport config, import-provider toggles)
// has any other Phase 1f-scoped consumer.

// mqttDefaults mirrors MqttSettingsRepository.js's DEFAULTS.
func mqttDefaults() map[string]any {
	return map[string]any{
		"transport": "websocket", "host": "", "port": float64(1883),
		"username": "", "password": "", "prefix": "gaggiuino",
	}
}

func getKV(db *sql.DB, key string) (map[string]any, bool, error) {
	var raw string
	err := db.QueryRow(`SELECT value FROM kv WHERE key = ?`, key).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("backup: reading kv %s: %w", key, err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, false, nil // matches Node's `catch { return {...DEFAULTS} }`
	}
	return m, true, nil
}

func saveKV(db *sql.DB, key string, v map[string]any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("backup: encoding kv %s: %w", key, err)
	}
	if _, err := db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, key, string(data)); err != nil {
		return fmt.Errorf("backup: saving kv %s: %w", key, err)
	}
	return nil
}

// getMqttSettings ports MqttSettingsRepository.js's getSettings():
// DEFAULTS merged with whatever's actually stored.
func getMqttSettings(db *sql.DB) (map[string]any, error) {
	out := mqttDefaults()
	saved, found, err := getKV(db, "mqtt_settings")
	if err != nil {
		return nil, err
	}
	if found {
		for k, v := range saved {
			out[k] = v
		}
	}
	return out, nil
}

// saveMqttSettings ports MqttSettingsRepository.js's saveSettings(settings):
// merges into the currently stored settings, never overwrites wholesale —
// load-bearing for restore's decrypted-secrets path, which must not erase
// a locally configured password when the backup carried no secrets block
// at all.
func saveMqttSettings(db *sql.DB, patch map[string]any) error {
	current, err := getMqttSettings(db)
	if err != nil {
		return err
	}
	for k, v := range patch {
		current[k] = v
	}
	return saveKV(db, "mqtt_settings", current)
}

// importSettingsDefaults mirrors ImportSettingsRepository.js's DEFAULTS.
func importSettingsDefaults() map[string]any {
	return map[string]any{"disabledProviders": []any{}, "customShopifyDomains": []any{}}
}

// getImportSettings ports ImportSettingsRepository.js's getSettings().
func getImportSettings(db *sql.DB) (map[string]any, error) {
	saved, found, err := getKV(db, "import_settings")
	if err != nil {
		return nil, err
	}
	if !found {
		return importSettingsDefaults(), nil
	}
	out := importSettingsDefaults()
	if dp, ok := saved["disabledProviders"].([]any); ok {
		out["disabledProviders"] = dp
	}
	if cd, ok := saved["customShopifyDomains"].([]any); ok {
		out["customShopifyDomains"] = cd
	}
	return out, nil
}

// saveImportSettings ports ImportSettingsRepository.js's
// saveSettings(settings): overwrites wholesale, unlike MQTT's merge.
func saveImportSettings(db *sql.DB, settings map[string]any) error {
	return saveKV(db, "import_settings", settings)
}
