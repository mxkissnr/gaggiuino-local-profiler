package system

import (
	"net/url"
	"os"
	"strings"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
)

// This file holds the pure-logic pieces GET /api/status (handlers.go's
// getStatus) assembles its response from — everything here is either
// string formatting or a documented stub, no I/O beyond a single env var
// read, so it stays out of handlers.go's already-large getStatus body.

// statusMachine ports GET /api/status's `machines` array item shape
// (routes/system.js's `registry.listMachines().map(m => ({...}))`, #317):
// a narrower projection than the full /api/machines response (machines.
// Machine) — reachable/on are only ever populated for the default machine
// (nil for every other one), matching the "flat legacy fields always
// describe the default machine" convention the rest of this endpoint's
// top-level fields also follow.
type statusMachine struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	Type      string          `json:"type"`
	IsDefault bool            `json:"isDefault"`
	Enabled   bool            `json:"enabled"`
	Reachable *bool           `json:"reachable"`
	On        *bool           `json:"on"`
	Theme     *machines.Theme `json:"theme"`
}

// buildStatusMachines ports GET /api/status's `machines` array
// construction (registry.listMachines().map(...), #317): the flat legacy
// fields above (machineReachable/machineOn/...) always describe the
// default machine, so reachable/on are only populated for it — nil for
// every other configured machine, matching openapi.yaml's Machine array
// item schema ("Only populated for the default machine").
func buildStatusMachines(list []machines.Machine, defaultReachable *bool, defaultOn bool) []statusMachine {
	out := make([]statusMachine, 0, len(list))
	for _, m := range list {
		sm := statusMachine{
			ID: m.ID, Name: m.Name, Type: m.Type,
			IsDefault: m.IsDefault, Enabled: m.Enabled, Theme: m.Theme,
		}
		if m.IsDefault {
			sm.Reachable = defaultReachable
			on := defaultOn
			sm.On = &on
		}
		out = append(out, sm)
	}
	return out
}

// normalizeHost prepends "http://" to raw when it has no scheme yet, then
// parses it -- the "does this look like a bare host or a full URL" quirk
// both hostnameOnly and apiURLAndHostnameFor below need to handle identically
// (#901 code review: they used to duplicate this verbatim).
func normalizeHost(raw string) (*url.URL, error) {
	withScheme := raw
	lower := strings.ToLower(raw)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		withScheme = "http://" + raw
	}
	return url.Parse(withScheme)
}

// hostnameOnly ports routes/system.js's local hostnameOf(rawHost) helper:
// resolves a machineHostname the same way the default-machine path
// (apiURLAndHostnameFor) always has (strip protocol, keep hostname only) —
// used for GET /api/status's ?machineId-scoped branch too, so both paths
// report hostname in the same shape.
func hostnameOnly(rawHost string) string {
	u, err := normalizeHost(strings.TrimSpace(rawHost))
	if err != nil {
		return rawHost
	}
	return u.Hostname()
}

// hasUnconfirmedLegacyMachineOptions stubs
// lib/machines/options-adoption.js's function of the same name:
// routes/system.js uses it to show a Settings-UI banner nudging the user
// to re-confirm a legacy machine_host/switch_entity add-on option that
// hasn't yet been reconciled into the registry. The real implementation
// depends on a kv "options.json value as of the last adoption pass"
// tracking table (options-adoption.js's adoptOptionChanges(), the write
// side of that reconciliation) that this Go port hasn't built —
// internal/machines/registry.go's EnsureDefaultMachine doc comment already
// draws the identical scope boundary for the read side of the same
// deprecation. Always false here: never shows the nag banner, the safe
// default — a false negative (missing a legacy option that genuinely needs
// re-confirming) costs nothing but the banner not appearing; there is no
// false-positive failure mode since this never returns true.
func hasUnconfirmedLegacyMachineOptions() bool { return false }

// apiURLAndHostnameFor ports registry.js's apiUrlFor()/hostFor() as used by
// GET /api/status's authenticated-only machineUrl/machineHostname fields —
// display-only values, never used to actually reach the machine (that's
// machines.BaseURLFor, which re-validates and SSRF-guards the host on
// every call; this is pure string formatting with no I/O beyond the env
// read below). host is the resolved default machine's Host field; an
// empty host falls back to the MACHINE_URL env var (#764, standalone
// Docker), matching lib/data.js's own final fallback layer. Deliberately
// NOT read here: options.json's deprecated machine_host/machine_url
// legacy fields (#662 soft-removed them from config.yaml's schema) — same
// scope boundary internal/machines/registry.go's EnsureDefaultMachine doc
// comment already draws for the read side of that same deprecation.
func apiURLAndHostnameFor(host string) (*string, string) {
	raw := strings.TrimSpace(host)
	if raw == "" {
		raw = strings.TrimSpace(os.Getenv("MACHINE_URL"))
	}
	if raw == "" {
		return nil, ""
	}
	u, err := normalizeHost(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		fallback := "http://gaggia.intern/api/shots"
		return &fallback, "gaggia.intern"
	}
	full := u.Scheme + "://" + u.Host + "/api/shots"
	return &full, u.Hostname()
}
