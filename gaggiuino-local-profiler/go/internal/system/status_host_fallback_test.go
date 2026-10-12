package system

import "testing"

// TestAPIURLAndHostnameFor_RejectsUnusableHost covers #1624: a machine host
// that can't be parsed, or that carries a scheme other than http(s), yields no
// machineUrl and no machineHostname (nil, "") -- exactly like the no-host case
// -- rather than falling back to a built-in placeholder address.
func TestAPIURLAndHostnameFor_RejectsUnusableHost(t *testing.T) {
	for _, host := range []string{"gaggia.local:notaport", "ftp://gaggia.local"} {
		hostURL, hostname := apiURLAndHostnameFor(host)
		if hostURL != nil {
			t.Errorf("apiURLAndHostnameFor(%q) machineUrl = %q, want nil", host, *hostURL)
		}
		if hostname != "" {
			t.Errorf("apiURLAndHostnameFor(%q) machineHostname = %q, want empty", host, hostname)
		}
	}
}
