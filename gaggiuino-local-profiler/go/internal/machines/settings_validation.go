package machines

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// This file (#901, Go web-UI Edit-UI follow-up) adds field-level validation
// for exactly the two settings categories internal/web/handlers_settings.go
// previously kept read-only after a code-review finding (finding #1):
// ValidateSettingsPayload alone (validation.go) only checks "is this a JSON
// object", never field ranges/types, before forwarding a payload straight to
// adapter.UpdateSettings — not safe to expose an editable form over for
// boiler (real hardware temperature/power setpoints) or system
// (releaseChannel, the OTA firmware channel selector), the two categories
// that finding flagged.
//
// Field names/types below are the official Gaggiuino REST API
// documentation's (https://gaggiuino.github.io/rest-api/rest-api.md,
// fetched 2026-08-25 while building this): boiler's steamSetPoint/
// offsetTemp/hpwr/mainDivider/brewDivider/startupHeatDelta (numbers) and
// brewDeltaState/dreamSteamState (the bool-as-string quirk
// internal/machines/doc.go documents — the JSON *string* "true"/"false",
// not a real boolean); system's releaseChannel (0=stable/1=test/2=debug,
// corroborated against this package's own firmware_check.go's
// ParseReleaseChannel/channelTagPrefix, which already treats exactly those
// three values as recognized).
//
// That documentation does NOT publish numeric min/max ranges for any
// boiler field (confirmed by reading it directly, not assumed) — so
// ValidateBoilerSettings deliberately does NOT invent a firmware-verified-
// looking "safe PID range" it has no source for. What it does check is
// everything that IS verifiable without a real machine to test against:
// each known field's JSON type/format is correct (a string typed into a
// numeric field, or anything other than exactly "true"/"false" in a
// bool-as-string field, is rejected), plus a wide, explicitly-labeled
// sanity envelope on the temperature-like fields — not "the firmware's
// real safe range", just a circuit breaker against the class of mistake a
// hand-edited textarea invites (an extra zero, a pasted Fahrenheit value, a
// stray minus sign), which is exactly what a raw-JSON round trip has no
// other defense against. Both validators are additive to
// ValidateSettingsPayload, called only from this web-UI's own write path
// (internal/web/handlers_settings.go) — the REST proxy
// (routes/machine-control.js's Node equivalent, internal/machines/
// handlers_control.go's updateSettings) keeps its original opaque-only
// check for every category including these two, per this package's
// existing "closing that for the REST API too is a separate, dedicated
// validation-hardening pass" scope boundary.

// boilerNumberFields are boiler's documented numeric fields and the wide
// sanity envelope [min, max] each is checked against — see this file's own
// doc comment for why these are a garbage-value circuit breaker, not a
// claimed firmware-verified safe range.
var boilerNumberFields = map[string][2]float64{
	"steamSetPoint":    {0, 200},    // °C — documented example 145
	"offsetTemp":       {-50, 50},   // °C calibration offset — documented example 5
	"startupHeatDelta": {-50, 50},   // °C — documented example 10
	"hpwr":             {0, 5000},   // heater power constant — documented example 1200
	"mainDivider":      {0.01, 100}, // power divider, must stay positive (firmware divides by it) — documented example 2
	"brewDivider":      {0.01, 100}, // documented example 4
}

// boilerBoolStringFields are boiler's documented bool-as-string fields —
// see internal/machines/doc.go's own "bool-as-string quirk" section.
var boilerBoolStringFields = []string{"brewDeltaState", "dreamSteamState"}

// ValidateBoilerSettings additionally checks every documented boiler field
// present in raw against its known type/format and sanity envelope — see
// this file's own doc comment for exactly what "sanity envelope" does and
// doesn't claim. Fields this package doesn't recognize are left alone
// (matches ValidateSettingsPayload's own "any JSON object" tolerance —
// a firmware version documenting a field this port doesn't know about yet
// shouldn't hard-fail every boiler save).
func ValidateBoilerSettings(raw json.RawMessage) error {
	obj, err := decodeSettingsObject(raw)
	if err != nil {
		return err
	}
	for field, bounds := range boilerNumberFields {
		v, present := obj[field]
		if !present {
			continue
		}
		// #901 code review (CONFIRMED finding #1): json.Unmarshal into a
		// non-pointer float64 target is a documented no-op on a JSON
		// `null` (leaves n at its zero value with a nil error) — a
		// present-but-null field would otherwise silently pass whichever
		// bound happens to include 0 (steamSetPoint/offsetTemp/
		// startupHeatDelta/hpwr all do) and then reach adapter.
		// UpdateSettings verbatim, `null` and all, exactly the class of
		// unvalidated write this file exists to stop. A present field must
		// be an actual JSON number, never null.
		if isJSONNull(v) {
			return fmt.Errorf("%s must not be null", field)
		}
		var n float64
		if err := json.Unmarshal(v, &n); err != nil {
			return fmt.Errorf("%s must be a number", field)
		}
		if n < bounds[0] || n > bounds[1] {
			return fmt.Errorf("%s must be between %g and %g", field, bounds[0], bounds[1])
		}
	}
	for _, field := range boilerBoolStringFields {
		v, present := obj[field]
		if !present {
			continue
		}
		// A present-but-null value here is already correctly rejected
		// without an explicit isJSONNull check, unlike the numeric loop
		// above: json.Unmarshal into a non-pointer string target also
		// no-ops on `null` (same documented encoding/json behavior), but
		// leaves s at its zero value "" — which then fails the
		// true/false check below on its own, no bounds-with-a-0-floor
		// coincidence to rely on.
		var s string
		if err := json.Unmarshal(v, &s); err != nil || (s != "true" && s != "false") {
			return fmt.Errorf(`%s must be the string "true" or "false"`, field)
		}
	}
	return nil
}

// isJSONNull reports whether raw is exactly the JSON literal null —
// json.RawMessage is unparsed bytes, so this is a plain byte comparison
// (after trimming the insignificant whitespace json.Unmarshal itself
// tolerates), not a decode.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// ValidateSystemSettings additionally checks releaseChannel, the one
// system-category field with a real, documented, ground-truth enum
// (0/1/2) — every other system field (wifiEnabled, mqttHost,
// timezoneOffsetMinutes, ...) stays covered only by
// ValidateSettingsPayload's generic "is this a JSON object" check, same as
// the REST API always has. Present-but-wrong is rejected; absent is
// allowed, the same "don't require completeness" reasoning
// ValidateBoilerSettings' own doc comment gives.
func ValidateSystemSettings(raw json.RawMessage) error {
	obj, err := decodeSettingsObject(raw)
	if err != nil {
		return err
	}
	v, present := obj["releaseChannel"]
	if !present {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(v, &decoded); err != nil {
		return fmt.Errorf("releaseChannel must be a number")
	}
	ch := ParseReleaseChannel(decoded)
	if ch == nil || (*ch != 0 && *ch != 1 && *ch != 2) {
		return fmt.Errorf("releaseChannel must be 0 (stable), 1 (test), or 2 (debug)")
	}
	return nil
}

// decodeSettingsObject is ValidateSettingsPayload's own decode step, reused
// here to get at individual fields rather than just confirming "this is a
// JSON object" — kept as ValidateSettingsPayload's own responsibility too
// (both validators call it, matching that function's existing "invalid
// settings payload" error message for a malformed body).
func decodeSettingsObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("invalid settings payload: %w", err)
	}
	return obj, nil
}
