package backup

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// This file holds a narrow get/save round trip for the two settings blobs
// GET/POST /api/backup's `kv` block needs (MQTT transport config and
// import-provider toggles) — the same "duplicate a small slice rather than
// block on a whole domain" trade-off internal/orders/options.go already made
// for isOrdersEnabled().

// mqttDefaults is the default MQTT settings blob.
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
		return nil, false, nil // malformed JSON falls back to the defaults
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

// getMqttSettings returns the defaults merged with whatever's actually
// stored.
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

// saveMqttSettings merges into the currently stored settings, never
// overwrites wholesale — load-bearing for restore's decrypted-secrets
// path, which must not erase a locally configured password when the backup
// carried no secrets block at all.
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

// importSettingsDefaults is the default import-provider settings blob.
func importSettingsDefaults() map[string]any {
	return map[string]any{"disabledProviders": []any{}, "customShopifyDomains": []any{}}
}

// getImportSettings returns the stored import-provider settings, or the
// defaults when absent.
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

// saveImportSettings overwrites the stored settings wholesale, unlike
// MQTT's merge.
func saveImportSettings(db *sql.DB, settings map[string]any) error {
	return saveKV(db, "import_settings", settings)
}
