package mqtt

import (
	"errors"
	"unicode/utf8"
)

// parseSettings ports lib/validation/schemas.js's mqttSettingsSchema
// (safeParse). transport is required and must be one of the two enum
// values; every other field is optional with a default and is bounded.
// Extra keys are ignored (plain z.object, not .strict()).
func parseSettings(body map[string]any) (Settings, error) {
	out := defaultSettings()

	tRaw, ok := body["transport"]
	if !ok {
		return Settings{}, errors.New("transport is required")
	}
	tStr, ok := tRaw.(string)
	if !ok || (tStr != string(TransportWebSocket) && tStr != string(TransportMQTT)) {
		return Settings{}, errors.New("transport must be 'websocket' or 'mqtt'")
	}
	out.Transport = TransportKind(tStr)

	if v, present := body["host"]; present {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) > 255 {
			return Settings{}, errors.New("invalid host")
		}
		out.Host = s
	}
	if v, present := body["port"]; present {
		f, ok := v.(float64)
		if !ok || f != float64(int(f)) || int(f) < 1 || int(f) > 65535 {
			return Settings{}, errors.New("invalid port")
		}
		out.Port = int(f)
	}
	if v, present := body["username"]; present {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) > 200 {
			return Settings{}, errors.New("invalid username")
		}
		out.Username = s
	}
	if v, present := body["password"]; present {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) > 200 {
			return Settings{}, errors.New("invalid password")
		}
		out.Password = s
	}
	if v, present := body["prefix"]; present {
		s, ok := v.(string)
		if !ok || utf8.RuneCountInString(s) < 1 || utf8.RuneCountInString(s) > 100 {
			return Settings{}, errors.New("invalid prefix")
		}
		out.Prefix = s
	}
	return out, nil
}
