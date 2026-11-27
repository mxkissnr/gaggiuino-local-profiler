package machines

import (
	"encoding/json"
	"strconv"
)

// This file is the #1431 half of "stop returning the MQTT broker password":
// a machine's own system settings carry an `mqttPassword` field, and the
// settings proxy in handlers_control.go must neither forward it to the
// browser on a read nor let a browser-submitted form (which never saw it)
// wipe it on a write.
//
// RedactSystemSettings is the read side: it strips mqttPassword and reports
// whether one was set via the browser-only mqttPasswordSet marker.
// RestoreSystemPassword is the write side: it puts the machine's current
// password back into a payload that omits it. Together they mirror the
// hasPassword / #1050 handling /api/mqtt/settings already does for the app's
// own broker credentials.

// RedactSystemSettings removes `mqttPassword` from a machine settings JSON
// body and reports whether it held a non-empty password as `mqttPasswordSet`.
// It handles both shapes the settings endpoint returns: a flat
// system-category object (mqttPassword at the top level) and the
// all-categories object, whose categories are nested (mqttPassword under
// `system`). A body that is not a JSON object, invalid JSON, or carries no
// mqttPassword is returned unchanged.
func RedactSystemSettings(raw []byte) []byte {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return raw
	}
	changed := redactSettingsObject(obj)
	// All-categories reads nest each category, so the system one's
	// mqttPassword sits under obj["system"] rather than at the top level.
	if sysRaw, present := obj["system"]; present {
		var sys map[string]json.RawMessage
		if err := json.Unmarshal(sysRaw, &sys); err == nil && sys != nil && redactSettingsObject(sys) {
			if redacted, err := json.Marshal(sys); err == nil {
				obj["system"] = redacted
				changed = true
			}
		}
	}
	if !changed {
		return raw
	}
	redacted, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return redacted
}

// redactSettingsObject deletes mqttPassword from obj, replacing it with
// mqttPasswordSet, and reports whether it changed anything.
func redactSettingsObject(obj map[string]json.RawMessage) bool {
	pwRaw, present := obj["mqttPassword"]
	if !present {
		return false
	}
	var pw string
	_ = json.Unmarshal(pwRaw, &pw)
	delete(obj, "mqttPassword")
	obj["mqttPasswordSet"] = json.RawMessage(strconv.FormatBool(pw != ""))
	return true
}

// RestoreSystemPassword re-inserts the machine's current mqttPassword into an
// outgoing system-settings body that does not carry one, and always strips
// the browser-only mqttPasswordSet marker. body is the decoded client
// payload; current is the machine's current settings and may be nil when the
// body already carries an explicit password.
func RestoreSystemPassword(body, current map[string]any) {
	if _, present := body["mqttPassword"]; !present {
		if pw, ok := current["mqttPassword"]; ok {
			body["mqttPassword"] = pw
		}
	}
	delete(body, "mqttPasswordSet")
}

// tokenKeys are the visualizer and profiler upload tokens. The system
// category carries them, and since firmware main-7cb0a86 (#2231) so does each
// Cafe Mode user's display.homeUsers[*].preferences. They are secrets: never
// stored in a GLP backup and never sent to the browser.
var tokenKeys = []string{"visualizerToken", "sprofilerToken"}

// StripHomeUserTokens deletes every per-user token from display, a display
// settings object. A user or preferences value that is not a JSON object is
// skipped; a caller that must fail closed checks the shape first.
func StripHomeUserTokens(display map[string]any) {
	users, _ := display["homeUsers"].([]any)
	for _, u := range users {
		user, _ := u.(map[string]any)
		prefs, _ := user["preferences"].(map[string]any)
		for _, key := range tokenKeys {
			delete(prefs, key)
		}
	}
}

// RestoreHomeUserTokens copies the per-user tokens from current, the
// machine's current display settings, into target, matching users by id and
// never by position. Only tokens missing from a target user's preferences are
// copied, so a value the caller sent on purpose wins. Users found on one side
// only, and users without a preferences object, are left alone. It returns
// how many values it copied.
func RestoreHomeUserTokens(target, current map[string]any) int {
	byID := map[string]map[string]any{}
	currentUsers, _ := current["homeUsers"].([]any)
	for _, u := range currentUsers {
		user, _ := u.(map[string]any)
		key, ok := homeUserKey(user)
		prefs, isObject := user["preferences"].(map[string]any)
		if _, seen := byID[key]; ok && isObject && !seen {
			byID[key] = prefs
		}
	}
	copied := 0
	targetUsers, _ := target["homeUsers"].([]any)
	for _, u := range targetUsers {
		user, _ := u.(map[string]any)
		key, ok := homeUserKey(user)
		prefs, isObject := user["preferences"].(map[string]any)
		source, found := byID[key]
		if !ok || !isObject || !found {
			continue
		}
		for _, name := range tokenKeys {
			if _, present := prefs[name]; present {
				continue
			}
			if value, has := source[name]; has {
				prefs[name] = value
				copied++
			}
		}
	}
	return copied
}

// homeUserKey is a user's id as a map key. Numbers and strings stay apart, so
// 1 and "1" are different users; a user without a usable id has no key.
func homeUserKey(user map[string]any) (string, bool) {
	switch id := user["id"].(type) {
	case json.Number:
		return "n:" + id.String(), true
	case float64:
		return "n:" + strconv.FormatFloat(id, 'f', -1, 64), true
	case string:
		return "s:" + id, true
	}
	return "", false
}
