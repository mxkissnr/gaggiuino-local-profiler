package orders

import (
	"encoding/json"
	"os"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/datadir"
)

// optionsFile is the Supervisor-written options.json path, under datadir.Root
// (the real data directory in production, a per-test directory under
// `go test`). A var, not a const, so it is resolved through the data-dir seam.
var optionsFile = datadir.Path("options.json")

// isOrdersEnabled reads the enable_orders field from the options.json
// (written by the Supervisor), falling back to the GLP_ENABLE_ORDERS env var
// (#764, standalone Docker with no Supervisor) when the file doesn't exist
// or doesn't parse. This is deliberately a narrow, single-field read, not a
// full options facade — the rest of options.json's fields (sync_interval,
// preheat_time, debug_logging, expose_api_port, machine_* legacy fields)
// belong to the system domain (see go/internal/system/doc.go); reading just
// this one boolean here avoids coupling the orders domain to it, the same
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
