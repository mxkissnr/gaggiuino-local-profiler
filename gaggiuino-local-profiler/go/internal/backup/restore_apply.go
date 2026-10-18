package backup

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/uiprefs"
)

// applyRestore performs the real (non-dry-run) restore. The shots section
// (wipe + every shot upsert + annotations + trash + blocklist + library)
// commits as ONE transaction via shots.Repository.RestoreShots (#959); the
// remaining sections stay their own internal txs — see this file's header
// comment for the narrowed atomicity gap.
func (h *Handlers) applyRestore(p restorePlan, shotIter func(yield func(shots.Shot) error) error) error {
	d := h.deps
	if p.wantsShots {
		if err := d.ShotsRepo.RestoreShots(shots.RestoreInput{
			Shots:       shotIter,
			Annotations: p.validAnnotations,
			Trash:       p.validTrash,
			Blocklist:   p.blocklist,
			LibraryJSON: p.libraryJSON,
		}); err != nil {
			return err
		}
		if p.restoreAchievements {
			if err := d.AchievementsRepo.ReplaceAll(p.validAchievements); err != nil {
				return err
			}
		}
	}

	if p.sec.has("maintenance") {
		if _, ok := p.b["maintenance"].([]any); ok {
			if err := d.MaintenanceRepo.RestoreMaintenanceRaw(p.validMaintenance); err != nil {
				return err
			}
		}
		if _, ok := p.b["maintenance_log"].([]any); ok {
			if err := d.MaintenanceRepo.RestoreMaintenanceLogRaw(p.validMaintenanceLog); err != nil {
				return err
			}
		}
	}

	if p.sec.has("orders") {
		if _, ok := p.b["orders"].([]any); ok {
			if err := d.OrdersRepo.ReplaceAll(p.validOrders); err != nil {
				return err
			}
		}
	}

	if p.wantsMachines {
		if _, err := d.Registry.RestoreMachines(p.restoredMachines); err != nil {
			return err
		}
	}

	if p.wantsSettings {
		if kv, ok := p.b["kv"].(map[string]any); ok {
			if err := h.applyKVSettings(kv); err != nil {
				return err
			}
		}
	}

	if mqtt, ok := p.decryptedSecrets["mqtt"].(map[string]any); ok {
		username, _ := mqtt["username"].(string)
		password, _ := mqtt["password"].(string)
		if err := saveMqttSettings(d.DB, map[string]any{
			"username": truncateRunes(username, 200), "password": truncateRunes(password, 500),
		}); err != nil {
			return err
		}
	}

	return nil
}

func formatBlocklistValue(n float64) string {
	if n == float64(int64(n)) {
		return strconv.FormatInt(int64(n), 10)
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}

func (h *Handlers) applyKVSettings(kv map[string]any) error {
	d := h.deps
	if arr, ok := kv["menu"].([]any); ok {
		menu := make([]orders.MenuItem, 0, len(arr))
		skipped := 0
		for _, v := range arr {
			m, ok := v.(map[string]any)
			if !ok {
				skipped++
				continue
			}
			item, ok := orders.NormalizeMenuItem(m)
			if !ok {
				skipped++
				continue
			}
			menu = append(menu, item)
		}
		if skipped > 0 {
			log.Printf("backup: restore skipped %d invalid menu item(s)", skipped)
		}
		if err := d.OrdersRepo.SaveMenu(menu); err != nil {
			return err
		}
	}
	if s, ok := kv["orders_settings"].(map[string]any); ok {
		if err := d.OrdersRepo.SaveSettings(orders.NormalizeSettings(s)); err != nil {
			return err
		}
	}
	if m, ok := kv["notify_mapping"].(map[string]any); ok {
		mapping := orders.NotifyMapping{}
		for k, v := range m {
			if s, ok := orders.NormalizeNotifyService(v).(string); ok {
				mapping[k] = s
			}
		}
		if err := d.OrdersRepo.SaveNotifyMapping(mapping); err != nil {
			return err
		}
	}
	if s, ok := kv["shot_defaults"].(map[string]any); ok {
		if defaults, ok := shots.SanitizeShotDefaultsForRestore(s); ok {
			if err := d.ShotsRepo.SaveShotDefaults(defaults); err != nil {
				return err
			}
		}
	}
	if s, ok := kv["ui_prefs"].(map[string]any); ok {
		if prefs, issues := uiprefs.Sanitize(s); len(issues) == 0 {
			if err := uiprefs.NewRepository(d.DB).Save(prefs); err != nil {
				return err
			}
		}
	}
	if s, ok := kv["import_settings"].(map[string]any); ok {
		if err := saveImportSettings(d.DB, s); err != nil {
			return err
		}
	}
	if s, ok := kv["mqtt_settings"].(map[string]any); ok {
		rest := map[string]any{}
		for k, v := range s {
			if k == "username" || k == "password" {
				continue
			}
			rest[k] = v
		}
		if err := saveMqttSettings(d.DB, rest); err != nil {
			return err
		}
	}
	return nil
}

// mapToLibrary converts a generic decoded coffee_library object into a
// typed library.Library — see restore.go's header comment on reDecode for
// why a typed destination is used here, and library.Entity's `= map[string]
// any` alias definition (library/model.go) for why the []any -> []Entity
// element conversion below needs no per-element type conversion syntax.
// mapToLibrary converts the generic decoded coffee_library object into a
// typed library.Library, THEN re-sanitizes every entity's fields via
// SanitizeLibraryForRestore — which must run on every restored library
// regardless of section scope, since a restored library bypasses the regular
// POST/PUT bean/grinder/recipe routes entirely (see restore_sanitize.go's
// doc comment).
func mapToLibrary(m map[string]any) library.Library {
	raw := library.Library{
		Beans: entityList(m["beans"]), Grinders: entityList(m["grinders"]),
		Recipes: entityList(m["recipes"]), Milks: entityList(m["milks"]),
		Baskets: entityList(m["baskets"]), PuckScreens: entityList(m["puckScreens"]),
	}
	return library.SanitizeLibraryForRestore(raw)
}

// entityList converts a generic decoded JSON array (`[]any` of
// `map[string]any` elements) into `[]library.Entity` — no per-element
// conversion needed since `library.Entity = map[string]any` is a type
// alias, not a distinct named type.
func entityList(v any) []library.Entity {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]library.Entity, 0, len(arr))
	for _, item := range arr {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// applyRestoredToken persists a restored API token to disk. See
// Dependencies.Token's doc comment: this does NOT take effect in the
// already-running process (internal/auth.RequireToken closes over a fixed
// token string at startup) until the process restarts — a documented,
// deliberate gap. It reports false when the token could not be written so the
// caller can report the secrets as not restored.
func (h *Handlers) applyRestoredToken(token string) bool {
	if token == "" {
		return true
	}
	tmp := h.deps.TokenFile + ".tmp"
	if err := os.WriteFile(tmp, []byte(token), 0o600); err != nil {
		log.Printf("backup: restore failed to write API token: %v", err)
		return false
	}
	if err := os.Rename(tmp, h.deps.TokenFile); err != nil {
		log.Printf("backup: restore failed to replace API token: %v", err)
		_ = os.Remove(tmp)
		return false
	}
	return true
}

// writePendingImages streams each validated image from the restore image
// source to its final path after the DB tx has committed (unchanged
// ordering). The bytes are re-read from the zip entry here, one at a time,
// rather than held in the plan since a heavily-illustrated library would
// otherwise sum every image body in memory (#959).
//
// Each image is run through img.WriteOptimized (ModePreserve): a JPEG/PNG
// is downscaled + metadata-stripped, a WebP/GIF is written byte-identical,
// and a ".thumb" sibling is generated. The stored extension is never
// changed, so the DB row written in the restore transaction stays
// consistent (#961 decision 6).
//
// It returns how many images were written and how many could not be: an
// unreadable/oversized source, a mkdir failure, or a WriteOptimized error
// (full disk, permissions) each count as failed, so a restore can report
// the photos it dropped instead of silently claiming success (#1602).
func (h *Handlers) writePendingImages(imgs restoreImages, pending []pendingImageWrite) (written, failed int) {
	for _, w := range pending {
		buf, ok := imgs.getForWrite(w.srcName)
		if !ok || len(buf) == 0 || len(buf) > imageMaxBytes {
			log.Printf("backup: restore failed to write image %s (source %q unreadable/empty/oversized)", w.path, w.srcName)
			failed++
			continue
		}
		if err := os.MkdirAll(filepath.Dir(w.path), 0o755); err != nil {
			log.Printf("backup: restore failed to write image %s (mkdir: %v)", w.path, err)
			failed++
			continue
		}
		srcExt := strings.TrimPrefix(filepath.Ext(w.path), ".")
		if _, err := img.WriteOptimized(w.path, buf, srcExt); err != nil {
			log.Printf("backup: restore failed to write image %s: %v", w.path, err)
			failed++
			continue
		}
		written++
	}
	return written, failed
}
