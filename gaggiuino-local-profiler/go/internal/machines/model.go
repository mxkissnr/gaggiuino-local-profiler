package machines

import (
	"encoding/json"
	"fmt"
)

// Machine ports lib/machines/registry.js's row() shape — the JSON shape
// returned by every /api/machines* endpoint (see openapi.yaml's Machine
// schema).
type Machine struct {
	ID             int64   `json:"id"`
	Name           string  `json:"name"`
	Type           string  `json:"type"` // "gaggiuino" | "gaggimate"
	Host           string  `json:"host"`
	SwitchEntity   *string `json:"switchEntity"`
	Theme          *Theme  `json:"theme"`
	HasWaterSensor bool    `json:"hasWaterSensor"`
	IsDefault      bool    `json:"isDefault"`
	Enabled        bool    `json:"enabled"`
	CreatedAt      int64   `json:"createdAt"`
}

// Theme ports the machines.theme JSON contract documented in
// internal/db's schema comment: either {preset:"<key>"} or
// {a:"#rrggbb",b:"#rrggbb"}. Both fields are pointers so an empty/absent
// one round-trips through JSON exactly (no "" leaking into a shape that
// should only ever have one variant populated).
type Theme struct {
	Preset string `json:"preset,omitempty"`
	A      string `json:"a,omitempty"`
	B      string `json:"b,omitempty"`
}

// MachineInput ports machineSchema/machineSchema.partial() (lib/validation
// /schemas.js): the request body shape for POST /api/machines and
// PUT /api/machines/{id}. Pointer fields distinguish "omitted" (nil, only
// meaningful for PUT's partial update — keep the existing value) from "sent
// as empty/false" (non-nil, apply it) — POST additionally requires
// Name/Type/Host to be non-nil (validated in handlers.go, matching
// machineSchema's non-partial required fields).
type MachineInput struct {
	Name           *string `json:"name"`
	Type           *string `json:"type"`
	Host           *string `json:"host"`
	SwitchEntity   *string `json:"switchEntity"`
	Theme          *Theme  `json:"theme"`
	HasWaterSensor *bool   `json:"hasWaterSensor"`
	Enabled        *bool   `json:"enabled"`
}

const maxNameLen = 100
const maxHostLen = 255
const maxSwitchEntityLen = 200

// validate ports machineSchema's field-level checks (z.string().min(1).max(100)
// for name, z.enum(['gaggiuino','gaggimate']) for type, z.string().max(255)
// for host — empty allowed, #718 — z.string().max(200) for switchEntity,
// themeSchema for theme). requireCore gates the POST-only "name/type/host
// must be present" rule PUT's partial schema doesn't have.
func (m MachineInput) validate(requireCore bool) error {
	if requireCore {
		if m.Name == nil || m.Type == nil || m.Host == nil {
			return fmt.Errorf("name, type and host are required")
		}
	}
	if m.Name != nil {
		if len(*m.Name) < 1 || len(*m.Name) > maxNameLen {
			return fmt.Errorf("name must be 1-%d characters", maxNameLen)
		}
	}
	if m.Type != nil && *m.Type != "gaggiuino" && *m.Type != "gaggimate" {
		return fmt.Errorf("type must be \"gaggiuino\" or \"gaggimate\"")
	}
	if m.Host != nil && len(*m.Host) > maxHostLen {
		return fmt.Errorf("host must be at most %d characters", maxHostLen)
	}
	if m.SwitchEntity != nil && len(*m.SwitchEntity) > maxSwitchEntityLen {
		return fmt.Errorf("switchEntity must be at most %d characters", maxSwitchEntityLen)
	}
	if m.Theme != nil {
		if err := validateTheme(*m.Theme); err != nil {
			return err
		}
	}
	return nil
}

// validateTheme ports themeSchema: exactly one of {preset} or {a,b} (both
// hex colors), strict (no extra fields — MachineInput's JSON decoding
// already ignores unknown keys the same way z.object(...).strict() would
// reject them, a minor, deliberately-accepted looseness since an extra
// unknown key in a theme object has no code path in this app that could
// act on it either way).
func validateTheme(t Theme) error {
	hasPreset := t.Preset != ""
	hasColors := t.A != "" || t.B != ""
	if hasPreset && hasColors {
		return fmt.Errorf("theme must be either a preset or a/b colors, not both")
	}
	if hasPreset {
		if !isThemePresetKey(t.Preset) {
			return fmt.Errorf("unknown theme preset: %s", t.Preset)
		}
		return nil
	}
	if hasColors {
		if !isHexColor(t.A) || !isHexColor(t.B) {
			return fmt.Errorf("theme a/b must be #rrggbb hex colors")
		}
		return nil
	}
	// Neither set: an explicitly-empty {} theme object. themeSchema's union
	// would reject this (neither branch matches an object with no
	// recognized keys) — reject it here too rather than silently accepting
	// a theme object that resolveTheme() would treat as "no theme set"
	// anyway, matching Node's strict validation.
	return fmt.Errorf("theme must set either preset or a/b colors")
}

func isHexColor(s string) bool {
	if len(s) != 7 || s[0] != '#' {
		return false
	}
	for _, c := range s[1:] {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// themeJSON marshals a *Theme back to the machines.theme TEXT column
// contract (nil -> NULL, matching registry.js's `theme ?
// JSON.stringify(theme) : null`).
func themeJSON(t *Theme) (*string, error) {
	if t == nil {
		return nil, nil
	}
	b, err := json.Marshal(t)
	if err != nil {
		return nil, err
	}
	s := string(b)
	return &s, nil
}

func parseTheme(raw *string) *Theme {
	if raw == nil || *raw == "" {
		return nil
	}
	var t Theme
	if err := json.Unmarshal([]byte(*raw), &t); err != nil {
		return nil // #601 parity: a hand-edited/corrupt row never breaks the registry
	}
	return &t
}
