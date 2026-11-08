package machinebackups

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Schedules of automatic backups; one per machine (#1878 maintainer decision 3).
const (
	ScheduleOff    = "off"
	ScheduleDaily  = "daily"
	ScheduleWeekly = "weekly"
)

const (
	settingsKVKey        = "machine_backup_settings"
	defaultKeepAutomatic = 10
	minKeepAutomatic     = 1
	maxKeepAutomatic     = 100
)

// Settings is one machine's automatic backup schedule and retention.
type Settings struct {
	Schedule      string `json:"schedule"`
	KeepAutomatic int    `json:"keepAutomatic"`
}

func defaultSettings() Settings {
	return Settings{Schedule: ScheduleDaily, KeepAutomatic: defaultKeepAutomatic}
}

func validSchedule(s string) bool {
	return s == ScheduleOff || s == ScheduleDaily || s == ScheduleWeekly
}

func validKeepAutomatic(n int) bool {
	return n >= minKeepAutomatic && n <= maxKeepAutomatic
}

func (s Settings) valid() bool {
	return validSchedule(s.Schedule) && validKeepAutomatic(s.KeepAutomatic)
}

// settingsByMachine holds every configured machine's settings, keyed by machine
// id. A machine without an entry uses the defaults.
type settingsByMachine map[int64]Settings

func (all settingsByMachine) forMachine(id int64) Settings {
	if s, ok := all[id]; ok {
		return s
	}
	return defaultSettings()
}

// allSettings reads the one kv row. A missing or malformed row gives the
// defaults for every machine; a DB read error is returned instead, so the caller
// never applies a guessed retention to real rows. The result is never nil.
func (r *Repository) allSettings() (settingsByMachine, error) {
	all := settingsByMachine{}
	var value string
	err := r.db.QueryRow(`SELECT value FROM kv WHERE key = ?`, settingsKVKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return all, nil
	}
	if err != nil {
		return all, fmt.Errorf("machinebackups: reading backup settings: %w", err)
	}
	var stored map[int64]Settings
	if err := json.Unmarshal([]byte(value), &stored); err != nil {
		return all, nil
	}
	for id, s := range stored {
		if id < 1 || !s.valid() {
			continue
		}
		all[id] = s
	}
	return all, nil
}

// settingsFor returns one machine's settings, the defaults when it has no
// stored entry.
func (r *Repository) settingsFor(machineID int64) (Settings, error) {
	all, err := r.allSettings()
	if err != nil {
		return defaultSettings(), err
	}
	return all.forMachine(machineID), nil
}

// saveSettings replaces one machine's entry in the shared kv row. The mutex
// covers the read-modify-write: without it two concurrent PUTs for different
// machines would lose one. A malformed row is replaced by a clean one.
func (r *Repository) saveSettings(machineID int64, s Settings) error {
	r.settingsMu.Lock()
	defer r.settingsMu.Unlock()
	all, err := r.allSettings()
	if err != nil {
		return err
	}
	all[machineID] = s
	b, err := json.Marshal(all)
	if err != nil {
		return fmt.Errorf("machinebackups: saving backup settings: %w", err)
	}
	if _, err := r.db.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)`, settingsKVKey, string(b)); err != nil {
		return fmt.Errorf("machinebackups: saving backup settings: %w", err)
	}
	return nil
}

// machineSettings is the API shape: the embedded struct flattens into
// {"machineId","schedule","keepAutomatic"}.
type machineSettings struct {
	MachineID int64 `json:"machineId"`
	Settings
}
