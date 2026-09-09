package web

import (
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web/templates"
)

// toMachineRow builds a templates.MachineRow from a machines.Machine, plus
// its live reachable status when known. reachable should only ever be
// non-nil for the default machine — see handlers_machines.go's rows() and
// internal/system/status.go's statusMachine, which establishes the same
// "flat reachable status always describes the default machine" convention
// for GET /api/status, since this Go rewrite's background poller
// (internal/system.Poller) doesn't track per-machine reachability for any
// other configured machine.
func toMachineRow(m machines.Machine, reachable *bool) templates.MachineRow {
	return templates.MachineRow{
		ID:        m.ID,
		Name:      m.Name,
		Type:      m.Type,
		Host:      m.Host,
		IsDefault: m.IsDefault,
		Enabled:   m.Enabled,
		Reachable: reachable,
	}
}
