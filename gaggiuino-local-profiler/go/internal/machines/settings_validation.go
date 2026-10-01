package machines

import (
	"encoding/json"
	"fmt"
)

// decodeSettingsObject is ValidateSettingsPayload's own decode step
// (validation.go): it confirms a settings body is a JSON object and returns
// its per-field raw values, matching that function's existing "invalid
// settings payload" error message for a malformed body.
func decodeSettingsObject(raw json.RawMessage) (map[string]json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return nil, fmt.Errorf("invalid settings payload: %w", err)
	}
	return obj, nil
}
