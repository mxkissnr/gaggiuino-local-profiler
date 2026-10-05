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

// RedactSystemSettings removes `mqttPassword` from a machine system-settings
// JSON object and reports whether it held a non-empty password as
// `mqttPasswordSet`. A body that is not a JSON object, invalid JSON, or an
// object without mqttPassword is returned unchanged.
func RedactSystemSettings(raw []byte) []byte {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return raw
	}
	pwRaw, present := obj["mqttPassword"]
	if !present {
		return raw
	}
	var pw string
	_ = json.Unmarshal(pwRaw, &pw)
	delete(obj, "mqttPassword")
	obj["mqttPasswordSet"] = json.RawMessage(strconv.FormatBool(pw != ""))

	redacted, err := json.Marshal(obj)
	if err != nil {
		return raw
	}
	return redacted
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
