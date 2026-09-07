package machines

import (
	"context"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// This file (#901, Go web-UI Create/Edit follow-up) extracts POST
// /api/machines' validate -> SSRF-check -> Registry.CreateMachine sequence
// (handlers_registry.go's createMachine) into a single function so
// internal/web's "New machine" form can call the exact same validation and
// SSRF-guard logic instead of reimplementing it — the same "same service
// method, not new logic" discipline internal/library.CreateBean et al.
// (internal/library/create.go) apply for that domain's own Create* forms.

// ValidationError carries the 400 message CreateMachineChecked's caller
// should surface. Aliased to httputil.ValidationError (#901 code review
// finding #5) rather than redeclared — internal/library's own create.go
// used to define an identical type independently; both now share one.
type ValidationError = httputil.ValidationError

// CreateMachineChecked ports POST /api/machines' full request-body ->
// machine sequence (handlers_registry.go's createMachine): MachineInput
// field validation, then — only when a non-empty host was given — the
// #336 SSRF guard (assertMachineHost) on that host, then
// Registry.CreateMachine. Every rejection short of a DB/internal error
// comes back as a *ValidationError, mirroring createMachine's own
// "always a 400" mapping for both validate() and the SSRF guard.
func CreateMachineChecked(ctx context.Context, registry *Registry, in MachineInput) (*Machine, error) {
	if err := in.validate(true); err != nil {
		return nil, &ValidationError{Message: "invalid machine: " + err.Error()}
	}
	if in.Host != nil && *in.Host != "" {
		hostname, err := hostnameOf(*in.Host)
		if err != nil {
			return nil, &ValidationError{Message: err.Error()}
		}
		if err := assertMachineHost(ctx, hostname); err != nil {
			if isSSRFBlocked(err) {
				return nil, &ValidationError{Message: "host not allowed"}
			}
			return nil, &ValidationError{Message: err.Error()}
		}
	}
	return registry.CreateMachine(in)
}
