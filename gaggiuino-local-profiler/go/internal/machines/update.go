package machines

import "context"

// This file (#901, Go web-UI full Edit-UI pass) extracts PUT
// /api/machines/:id's validate -> SSRF-check -> Registry.UpdateMachine
// sequence (handlers_registry.go's updateMachine) into a single function so
// internal/web's Machines Edit form can call the exact same validation and
// SSRF-guard logic instead of reimplementing it — the update-side
// counterpart to CreateMachineChecked (create.go), same rationale.
//
// Unlike CreateMachineChecked, a not-found id is a plain (nil, nil, false)
// return rather than a *ValidationError — 404 and 400 are different
// response classes for callers (internal/machines/handlers_registry.go's
// updateMachine keeps its own up-front existence check for the same
// 404-before-400 ordering reason its doc comment already explains; this
// function's own existence check, inside Registry.UpdateMachine, is enough
// for a caller like internal/web that has no such ordering requirement).
func UpdateMachineChecked(ctx context.Context, registry *Registry, id int64, in MachineInput, onHostChanged func(oldHost string)) (*Machine, bool, error) {
	if err := in.validate(false); err != nil {
		return nil, false, &ValidationError{Message: "invalid machine: " + err.Error()}
	}
	if in.Host != nil && *in.Host != "" {
		hostname, err := hostnameOf(*in.Host)
		if err != nil {
			return nil, false, &ValidationError{Message: err.Error()}
		}
		if err := assertMachineHost(ctx, hostname); err != nil {
			if isSSRFBlocked(err) {
				return nil, false, &ValidationError{Message: "host not allowed"}
			}
			return nil, false, &ValidationError{Message: err.Error()}
		}
	}
	machine, err := registry.UpdateMachine(id, in, onHostChanged)
	if err != nil {
		return nil, false, err
	}
	if machine == nil {
		return nil, false, nil
	}
	return machine, true, nil
}
