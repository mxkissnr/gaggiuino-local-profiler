package mcp

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
)

// staticSettings is a SettingsSource fake: tests return whatever effective
// values they want without touching the environment or the database.
type staticSettings Settings

func (s staticSettings) EffectiveSettings() Settings { return Settings(s) }

// settingsSource builds a fake source. enabled controls the master switch;
// allowDev is returned as-is, i.e. as if the dev-build rule had already been
// applied.
func settingsSource(enabled, allowWrite, allowDev bool) SettingsSource {
	return staticSettings(Settings{Enabled: enabled, AllowWrite: allowWrite, AllowDeveloperTools: allowDev})
}

func newSettingsRepo(t *testing.T) (*Repository, *sql.DB) {
	t.Helper()
	sqlDB, err := db.Open(filepath.Join(t.TempDir(), "glp.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	return NewRepository(sqlDB), sqlDB
}

func TestGetSettingsDefaultsAllOff(t *testing.T) {
	repo, _ := newSettingsRepo(t)
	if got := repo.GetSettings(); got != (Settings{}) {
		t.Fatalf("GetSettings() = %+v, want all off", got)
	}
}

func TestSaveAndGetSettings(t *testing.T) {
	repo, _ := newSettingsRepo(t)
	want := Settings{Enabled: true, AllowWrite: true, AllowDeveloperTools: false}
	saved, err := repo.SaveSettings(want)
	if err != nil {
		t.Fatalf("SaveSettings: %v", err)
	}
	if saved != want {
		t.Fatalf("SaveSettings returned %+v, want %+v", saved, want)
	}
	if got := repo.GetSettings(); got != want {
		t.Fatalf("GetSettings() = %+v, want %+v", got, want)
	}
}

func TestGetSettingsMalformedFallsBackToDefaults(t *testing.T) {
	repo, sqlDB := newSettingsRepo(t)
	if _, err := sqlDB.Exec(`INSERT OR REPLACE INTO kv (key, value) VALUES ('mcp_settings', ?)`, "not json"); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got := repo.GetSettings(); got != (Settings{}) {
		t.Fatalf("GetSettings() = %+v, want all off for malformed JSON", got)
	}
}

func TestEffectiveForcesDeveloperToolsOffOnNonDevBuild(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "")
	stored := Settings{Enabled: true, AllowWrite: true, AllowDeveloperTools: true}
	got := stored.Effective()
	if got.AllowDeveloperTools {
		t.Fatalf("Effective().AllowDeveloperTools = true on a non-dev build, want false")
	}
	if !got.Enabled || !got.AllowWrite {
		t.Fatalf("Effective() = %+v, want enabled/allowWrite preserved", got)
	}
}

func TestEffectiveKeepsDeveloperToolsOnDevBuild(t *testing.T) {
	t.Setenv("GLP_DEV_BUILD", "1")
	stored := Settings{Enabled: true, AllowWrite: false, AllowDeveloperTools: true}
	if got := stored.Effective(); !got.AllowDeveloperTools {
		t.Fatalf("Effective().AllowDeveloperTools = false on a dev build, want true")
	}
}
