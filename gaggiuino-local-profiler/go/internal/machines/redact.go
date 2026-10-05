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
