package orders

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
)

// isOrdersEnabled reads the enable_orders field from options.json (written by
// the Supervisor), falling back to the GLP_ENABLE_ORDERS env var (#764,
// standalone Docker with no Supervisor) when the file doesn't exist or doesn't
// parse.
//
// This used to be its own narrow, single-field read of /data/options.json; as
// of #1622 slice 6 it delegates to internal/config's shared, mtime-cached
// Options() reader, the same one cmd/server uses for allowed_hosts and the
// debug_logging gate uses -- so the read+parse+fallback chain exists once
// instead of once per package. The rest of options.json's fields (sync_interval,
// preheat_time, expose_api_port, machine_* legacy fields) still belong to the
// system domain (see go/internal/system/doc.go).
func isOrdersEnabled() bool {
	return config.Options().EnableOrders
}
