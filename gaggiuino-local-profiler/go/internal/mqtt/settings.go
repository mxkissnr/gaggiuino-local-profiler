package mqtt

import (
	"database/sql"
	"encoding/json"
	"fmt"
)

// This file ports lib/repositories/MqttSettingsRepository.js (#608): the
// Settings-page WebSocket/MQTT live-transport toggle plus the broker
// connection details, stored under kv.key = 'mqtt_settings'.
//
// No schema migration is needed: 'mqtt_settings' is a row in the existing
// kv table (go/internal/db/db.go), exactly like 'import_settings' and
// 'shot_defaults' — #608's Node side added no table either.

// TransportKind is the live-data transport selector (renamed from Node's
// bare `transport` string to avoid colliding with transport.go's Transport
// dispatch type).
type TransportKind string

const (
	TransportWebSocket TransportKind = "websocket"
	TransportMQTT      TransportKind = "mqtt"
)

// Settings mirrors MqttSettingsRepository.js's DEFAULTS-merged shape.
type Settings struct {
	Transport TransportKind `json:"transport"`
	Host      string        `json:"host"`
	Port      int           `json:"port"`
	Username  string        `json:"username"`
	Password  string        `json:"password"`
	Prefix    string        `json:"prefix"`
}

func defaultSettings() Settings {
	return Settings{Transport: TransportWebSocket, Host: "", Port: 1883, Username: "", Password: "", Prefix: "gaggiuino"}
}

// Repository is the kv-backed mqtt-settings store.
type Repository struct{ db *sql.DB }

func NewRepository(db *sql.DB) *Repository { return &Repository{db: db} }

// GetSettings ports MqttSettingsRepository.js's getSettings: DEFAULTS
// spread-merged with whatever's stored (a missing key keeps its default),
// falling back to DEFAULTS whole-sale on a missing row or malformed JSON.
func (r *Repository) GetSettings() Settings {
	out := defaultSettings()
	var value string
	if err := r.db.QueryRow(`SELECT value FROM kv WHERE key = 'mqtt_settings'`).Scan(&value); err != nil {
		return out
	}
	// Decode onto the defaults so an absent field keeps its default, matching
	// JS's `{ ...DEFAULTS, ...saved }`.
	if err := json.Unmarshal([]byte(value), &out); err != nil {
		return defaultSettings()
	}
	return out
}

// SaveSettings ports saveSettings({ ...this.getSettings(), ...settings }):
// s carries every field (the POST handler applies mqttSettingsSchema's zod
// defaults before calling, exactly as routes/mqtt.js does), so the JS
// spread merge is a full replace. Persists and returns the stored value.
func (r *Repository) SaveSettings(s Settings) (Settings, error) {
	b, err := json.Marshal(s)
	if err != nil {
		return Settings{}, fmt.Errorf("mqtt: encoding settings: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('mqtt_settings', ?)`, string(b)); err != nil {
		return Settings{}, fmt.Errorf("mqtt: saving settings: %w", err)
	}
	return s, nil
}
