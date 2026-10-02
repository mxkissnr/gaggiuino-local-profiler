package mqtt

import "context"

// This file implements the #608 Supervisor MQTT service auto-discovery via
// the Supervisor's own /services/mqtt endpoint (a different root than the
// Core API, reached through ha.Client.SupervisorGet). Requires
// `services: [mqtt:want]` in config.yaml. An install with no MQTT service
// registered gets a 4xx
// here, treated the same as "not available" (manual entry is always a valid
// fallback) rather than an error.

// Broker is the discovered broker connection (nil when nothing is registered).
type Broker struct {
	Host     string
	Port     int
	Username string
	Password string
}

// DiscoverSupervisorMQTT returns nil on any failure (no token, unreachable
// Supervisor, no MQTT service), treating all of them as "not available".
//
// #988 code review: the returned Broker.Host is NOT run through the SSRF
// guard client.go's connect() applies to a manually-entered/restored
// broker host. Deliberately so: this host comes verbatim from the trusted
// HA Supervisor's own /services/mqtt response — no user input anywhere on
// this path (unlike parseSettings' host field or a restored backup's kv
// row) — the same trust boundary machines/registry.go and this package's
// own manual-entry path draw between "the app owner's own infrastructure"
// and "attacker-influenced input."
func DiscoverSupervisorMQTT(ctx context.Context, ha SupervisorAPI) *Broker {
	if ha == nil {
		return nil
	}
	var resp struct {
		Data struct {
			Host     string `json:"host"`
			Port     int    `json:"port"`
			Username string `json:"username"`
			Password string `json:"password"`
		} `json:"data"`
	}
	if err := ha.SupervisorGet(ctx, "/services/mqtt", &resp); err != nil {
		return nil
	}
	if resp.Data.Host == "" {
		return nil
	}
	port := resp.Data.Port
	if port == 0 {
		port = 1883
	}
	return &Broker{Host: resp.Data.Host, Port: port, Username: resp.Data.Username, Password: resp.Data.Password}
}
