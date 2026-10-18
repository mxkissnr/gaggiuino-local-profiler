package backup

import (
	"encoding/json"
	"strconv"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// restorePlan is every "what would actually be written" computation —
// identical whether this is a dry run or a real restore, so preview counts
// and applied counts can never drift apart.
type restorePlan struct {
	b          map[string]any
	sec        sections
	wantsShots bool
	shotCount  int

	images restoreImages

	sanitizedLib map[string]any // nil if not restoring a library
	libraryJSON  []byte         // marshalled library.Library for RestoreShots; nil = don't touch
	planErr      error          // set when the plan itself is unusable; nil = proceed
	pending      []pendingImageWrite

	// pre-validated shots-section side data, applied inside RestoreShots' tx
	validAnnotations map[string]map[string]any
	validTrash       map[string]int64
	blocklist        []string // non-nil (possibly empty) = wipe+rewrite the blocklist

	// achievements belong to the shots section; ReplaceAll runs in its own tx
	// after RestoreShots. restoreAchievements is false when the key is absent
	// (old backup) or present-but-entirely-unusable.
	restoreAchievements bool
	validAchievements   []achievements.Row

	validMaintenance    []maintenance.RawRow
	maintenanceTotal    int
	validMaintenanceLog []maintenance.RawLogRow
	maintenanceLogTotal int

	validOrders []orders.Order
	ordersTotal int

	wantsMachines    bool
	restoredMachines []machines.Machine

	wantsSettings bool

	secretsPresent   bool
	secretsRestored  bool
	decryptedSecrets map[string]any
	restoredToken    string
}

// buildRestorePlan computes everything that would actually be written for
// POST /api/restore, from `sections := normaliseSections(...)` through
// `restoredToken`.
func buildRestorePlan(b map[string]any, images restoreImages, shotCount int) restorePlan {
	sec := normaliseSections(b["sections"])
	wantsShots := sec.has("shots")

	plan := restorePlan{b: b, sec: sec, wantsShots: wantsShots, shotCount: shotCount, images: images}

	wantsSecrets := sec.has("secrets")
	passphrase, _ := b["passphrase"].(string)
	secretsBlob, hasSecretsField := b["secrets"].(map[string]any)
	plan.secretsPresent = wantsSecrets && hasSecretsField
	if plan.secretsPresent && passphrase != "" {
		if enc := decodeEncryptedSecrets(secretsBlob); enc != nil {
			plan.decryptedSecrets = DecryptSecrets(enc, passphrase)
		}
	}
	plan.secretsRestored = plan.decryptedSecrets != nil

	if wantsShots {
		if rawLib, ok := b["coffee_library"].(map[string]any); ok {
			sanitized := map[string]any{}
			for k, v := range rawLib {
				sanitized[k] = v
			}
			validateRestoredLibraryImages(sanitized, images, &plan.pending)
			plan.sanitizedLib = sanitized
			jb, err := json.Marshal(mapToLibrary(sanitized))
			if err != nil {
				plan.planErr = errLibraryEncode
			} else {
				plan.libraryJSON = jb
			}
		}
		if ann, ok := b["annotations"].(map[string]any); ok {
			plan.validAnnotations = map[string]map[string]any{}
			for idStr, raw := range ann {
				m, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				if issues := shots.ValidateAnnotation(m); len(issues) > 0 {
					continue
				}
				if _, err := strconv.ParseInt(idStr, 10, 64); err != nil {
					continue
				}
				plan.validAnnotations[idStr] = m
			}
		}
		if trash, ok := b["trash"].(map[string]any); ok {
			plan.validTrash = map[string]int64{}
			for idStr, raw := range trash {
				if _, err := strconv.ParseInt(idStr, 10, 64); err != nil {
					continue
				}
				deletedAt, ok := jsFiniteNumber(raw)
				if !ok {
					deletedAt = float64(nowMillis())
				}
				plan.validTrash[idStr] = int64(deletedAt)
			}
		}
		if arr, ok := b["blocklist"].([]any); ok {
			list := make([]string, 0, len(arr))
			for _, v := range arr {
				if n, ok := jsFiniteNumber(v); ok {
					list = append(list, formatBlocklistValue(n))
				} else if s, ok := v.(string); ok {
					list = append(list, s)
				}
			}
			plan.blocklist = list
		}
		if arr, ok := b["achievements"].([]any); ok {
			valid := make([]achievements.Row, 0, len(arr))
			for _, v := range arr {
				m, ok := v.(map[string]any)
				if !ok {
					continue
				}
				if row, ok := sanitizeAchievementRow(m); ok {
					valid = append(valid, row)
				}
			}
			// Skip, don't destroy: a present-but-entirely-unusable array must
			// not wipe the target's achievements (an empty array is a real
			// "no badges" source and does clear them).
			if len(arr) == 0 || len(valid) > 0 {
				plan.restoreAchievements = true
				plan.validAchievements = valid
			}
		}
	}

	if sec.has("maintenance") {
		if arr, ok := b["maintenance"].([]any); ok {
			plan.maintenanceTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeMaintenanceRow(m); ok {
					plan.validMaintenance = append(plan.validMaintenance, toRawRow(sanitized))
				}
			}
		}
		if arr, ok := b["maintenance_log"].([]any); ok {
			plan.maintenanceLogTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeMaintenanceLogRow(m); ok {
					plan.validMaintenanceLog = append(plan.validMaintenanceLog, toRawLogRow(sanitized))
				}
			}
		}
	}

	if sec.has("orders") {
		if arr, ok := b["orders"].([]any); ok {
			plan.ordersTotal = len(arr)
			for _, v := range arr {
				m, _ := v.(map[string]any)
				if sanitized, ok := sanitizeOrderRow(m); ok {
					plan.validOrders = append(plan.validOrders, orders.Order(sanitized))
				}
			}
		}
	}

	if arr, ok := b["machines"].([]any); ok && sec.has("machines") {
		plan.wantsMachines = true
		var list []machines.Machine
		if err := reDecode(arr, &list); err == nil {
			plan.restoredMachines = list
		}
	}

	plan.wantsSettings = sec.has("settings")

	if sec.has("secrets") {
		if s, ok := plan.decryptedSecrets["apiToken"].(string); ok {
			token := sanitizeToken(s)
			if validRestoredToken(token) {
				plan.restoredToken = token
			} else {
				// A rejected token leaves the current one in place — generating
				// a replacement would lock out the integration and cards already
				// holding it.
				plan.secretsRestored = false
			}
		}
	}

	return plan
}

func decodeEncryptedSecrets(m map[string]any) *EncryptedSecrets {
	var enc EncryptedSecrets
	if err := reDecode(m, &enc); err != nil {
		return nil
	}
	return &enc
}

// restoredTokenMinLen matches auth.tokenMinLen. The app generates its own
// token as 32 random bytes hex-encoded (64 lowercase hex characters); the
// accepted alphabet is widened to the URL-safe base64 set so a hand-set token
// still restores, while punctuation such as "/", "+" and "=" and control
// characters are rejected.
const restoredTokenMinLen = 32

// validRestoredToken reports whether token is a plausible API token after
// sanitizeToken has run.
func validRestoredToken(token string) bool {
	if len(token) < restoredTokenMinLen {
		return false
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		if !((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
			return false
		}
	}
	return true
}

// sanitizeToken strips CR/LF/NUL from the token, trims it, and caps it at
// 200 chars. The result is format-checked by validRestoredToken.
func sanitizeToken(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r == '\r' || r == '\n' || r == 0 {
			continue
		}
		out = append(out, r)
	}
	trimmed := trimString(string(out))
	return truncateRunes(trimmed, 200)
}

// maxAchievementIDLen bounds a restored badge id, matching the id lengths the
// achievements registry uses.
const maxAchievementIDLen = 64

// sanitizeAchievementRow validates one entry of a restored backup's
// `achievements` array, returning ok=false so the caller can skip it. The id
// must be a non-empty string of at most 64 bytes; unlockedAt and progress must
// each be absent/null or a finite, non-negative integer — a restored bundle is
// untrusted input.
func sanitizeAchievementRow(m map[string]any) (achievements.Row, bool) {
	id, _ := m["id"].(string)
	if id == "" || len(id) > maxAchievementIDLen {
		return achievements.Row{}, false
	}
	unlockedAt, ok := optionalNonNegativeInt(m["unlockedAt"])
	if !ok {
		return achievements.Row{}, false
	}
	progress, ok := optionalNonNegativeInt(m["progress"])
	if !ok {
		return achievements.Row{}, false
	}
	return achievements.Row{ID: id, UnlockedAt: unlockedAt, Progress: progress}, true
}

// optionalNonNegativeInt decodes an optional JSON number that must be absent
// or null, or a finite non-negative integer — the shape of an achievement's
// unlockedAt/progress. A present-but-invalid value returns ok=false.
func optionalNonNegativeInt(v any) (*int64, bool) {
	if v == nil {
		return nil, true
	}
	n, ok := jsIntStrict(v)
	if !ok || n < 0 {
		return nil, false
	}
	return &n, true
}

func toRawRow(m map[string]any) maintenance.RawRow {
	machineID, _ := m["machineId"].(int64)
	key, _ := m["key"].(string)
	data, _ := json.Marshal(m["data"])
	return maintenance.RawRow{MachineID: machineID, Key: key, Data: data}
}

func toRawLogRow(m map[string]any) maintenance.RawLogRow {
	get := func(k string) int64 { v, _ := m[k].(int64); return v }
	getS := func(k string) string { v, _ := m[k].(string); return v }
	return maintenance.RawLogRow{
		ID: get("id"), TS: get("ts"), Date: getS("date"), Task: getS("task"),
		Machine: getS("machine"), ShotCount: get("shotCount"), Notes: getS("notes"),
		MachineID: get("machineId"),
	}
}

// reDecode round-trips v (already-decoded generic JSON values) through
// encoding/json into a specifically-typed out — used where a typed
// destination (machines.Machine, EncryptedSecrets) is easier to populate
// via a second decode pass than by hand-picking fields out of a
// map[string]any, the same trade-off shots.Shot/library.Entity/
// orders.Order's own "just use the generic map" choice makes in the other
// direction for shapes with no fixed structure.
func reDecode(v any, out any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// preview builds the dry-run response's `preview` object.
func (p restorePlan) preview() map[string]any {
	shotsCount := 0
	if p.wantsShots {
		shotsCount = p.shotCount
	}
	return map[string]any{
		"shots":               shotsCount,
		"library":             p.wantsShots && p.sanitizedLib != nil,
		"maintenance":         len(p.validMaintenance),
		"maintenanceTotal":    p.maintenanceTotal,
		"maintenanceLog":      len(p.validMaintenanceLog),
		"maintenanceLogTotal": p.maintenanceLogTotal,
		"orders":              len(p.validOrders),
		"ordersTotal":         p.ordersTotal,
		"machines":            machineCountForPreview(p),
		"settings":            p.wantsSettings && p.b["kv"] != nil,
		"images":              len(p.pending),
		"secretsPresent":      p.secretsPresent,
		"secretsRestored":     p.secretsRestored,
		"sectionsPresent":     sectionsPresent(p.b),
	}
}

func machineCountForPreview(p restorePlan) int {
	if !p.wantsMachines {
		return 0
	}
	return machines.CountRestorableMachines(p.restoredMachines)
}

// sectionsPresent returns the section names for which any presence key is
// present in b.
func sectionsPresent(b map[string]any) []string {
	out := []string{}
	for _, name := range sectionOrder {
		for _, key := range sectionPresenceBundleKeys[name] {
			if _, ok := b[key]; ok {
				out = append(out, name)
				break
			}
		}
	}
	return out
}
