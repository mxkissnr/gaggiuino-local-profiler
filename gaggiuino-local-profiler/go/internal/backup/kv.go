package backup

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/mqtt"
)

// This file holds a narrow get/save round trip for the two settings blobs
// GET/POST /api/backup's `kv` block needs (MQTT transport config and
// import-provider toggles). It reads and writes the kv rows directly rather
// than going through internal/mqtt or internal/importer.

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

// saveMqttSettings merges patch into the currently stored settings and then
// binds any reused credentials to the broker they belong to. A patch that
// omits username/password does not send them: the stored ones survive only
// while host and port still name the same broker. This is load-bearing for
// restore, where a kv blob has its credentials stripped and a decrypted
// secrets block may add host/port and credentials in separate steps.
func saveMqttSettings(db *sql.DB, patch map[string]any) error {
	currentMap, err := getMqttSettings(db)
	if err != nil {
		return err
	}
	mergedMap := make(map[string]any, len(currentMap)+len(patch))
	for k, v := range currentMap {
		mergedMap[k] = v
	}
	for k, v := range patch {
		mergedMap[k] = v
	}

	current := mqttSettingsFromMap(currentMap)
	next := mqttSettingsFromMap(mergedMap)
	_, sentPassword := patch["password"]
	_, sentUsername := patch["username"]
	if !sentUsername {
		next.Username = ""
	}
	merged := next
	if !sentPassword {
		// An omitted password is not sent: let the broker-binding merge decide
		// whether the stored one may stay. When a password is sent, even an
		// empty one, it is exactly what the caller wants stored.
		next.Password = ""
		merged = mqtt.MergeCredentials(current, next)
		// A kv restore strips credentials, so when its patch carries no
		// username keep the stored one for the same broker.
		if !sentUsername && mqtt.SameBroker(current, merged) {
			merged.Username = current.Username
		}
	}

	return saveKV(db, "mqtt_settings", map[string]any{
		"transport": string(merged.Transport),
		"host":      merged.Host,
		"port":      float64(merged.Port),
		"username":  merged.Username,
		"password":  merged.Password,
		"prefix":    merged.Prefix,
	})
}

func mqttSettingsFromMap(m map[string]any) mqtt.Settings {
	s := mqtt.Settings{Transport: mqtt.TransportWebSocket, Port: 1883, Prefix: "gaggiuino"}
	if v, ok := m["transport"].(string); ok {
		s.Transport = mqtt.TransportKind(v)
	}
	if v, ok := m["host"].(string); ok {
		s.Host = v
	}
	switch v := m["port"].(type) {
	case float64:
		if v >= 1 && v <= 65535 && v == math.Trunc(v) {
			s.Port = int(v)
		}
	case int:
		if v >= 1 && v <= 65535 {
			s.Port = v
		}
	}
	if v, ok := m["username"].(string); ok {
		s.Username = v
	}
	if v, ok := m["password"].(string); ok {
		s.Password = v
	}
	if v, ok := m["prefix"].(string); ok {
		s.Prefix = v
	}
	return s
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
