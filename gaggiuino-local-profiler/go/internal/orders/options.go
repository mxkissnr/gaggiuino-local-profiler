package orders

import (
	"encoding/json"
	"os"
)

// optionsFile mirrors lib/constants.js's OPTIONS_FILE.
const optionsFile = "/data/options.json"

// isOrdersEnabled ports lib/data.js's isOrdersEnabled() / loadOptions()'s
// enable_orders field: reads /data/options.json (written by the
// Supervisor), falling back to the GLP_ENABLE_ORDERS env var (#764,
// standalone Docker with no Supervisor) when the file doesn't exist or
// doesn't parse. This is deliberately a narrow, single-field read, not a
// full loadOptions() facade — the rest of options.json's fields
// (sync_interval, preheat_time, debug_logging, expose_api_port, machine_*
// legacy fields) belong to the not-yet-ported system domain (see
// go/internal/system/doc.go); duplicating just this one boolean here
// avoids blocking the whole orders domain on that later phase, the same
// trade-off go/internal/machines/registry.go's EnsureDefaultMachine
// already made for its own legacy-options read.
func isOrdersEnabled() bool {
	data, err := os.ReadFile(optionsFile)
	if err != nil {
		return os.Getenv("GLP_ENABLE_ORDERS") == "true"
	}
	var opts struct {
		EnableOrders bool `json:"enable_orders"`
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		return os.Getenv("GLP_ENABLE_ORDERS") == "true"
	}
	return opts.EnableOrders
}
