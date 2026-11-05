package ha

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
)

// DiscoveryService is the Supervisor discovery service name. It must equal the
// GLP integration's domain and the `discovery:` entry in config.yaml, or the
// Supervisor rejects the announcement with a 403.
const DiscoveryService = "gaggiuino_profiler"

// discoveryUUIDRe validates the id the Supervisor returns before it is ever
// interpolated into a request path.
var discoveryUUIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// withdrawTimeout bounds the DELETE sent on shutdown: it runs in parallel with
// the 8s HTTP drain inside the Supervisor's 10s stop timeout. A var so tests
// can shorten it.
var withdrawTimeout = 2 * time.Second

// discoveryResponse is the Supervisor's answer to POST /discovery.
type discoveryResponse struct {
	Data struct {
		UUID string `json:"uuid"`
	} `json:"data"`
}

// announceDiscovery posts this app's discovery message. port is an int so it
// encodes as a JSON number — the integration rejects a string, float or bool.
func (c *Client) announceDiscovery(ctx context.Context, host string, port int) (string, error) {
	body := map[string]any{
		"service": DiscoveryService,
		"config":  map[string]any{"host": host, "port": port},
	}
	var resp discoveryResponse
	if err := c.supervisorDo(ctx, http.MethodPost, "/discovery", body, &resp); err != nil {
		return "", err
	}
	if !discoveryUUIDRe.MatchString(resp.Data.UUID) {
		return "", errors.New("unexpected discovery id")
	}
	return resp.Data.UUID, nil
}

// withdrawDiscovery deletes this app's own discovery message. The uuid is
// re-validated here so it can never pick the path freely.
func (c *Client) withdrawDiscovery(ctx context.Context, uuid string) error {
	if !discoveryUUIDRe.MatchString(uuid) {
		return errors.New("unexpected discovery id")
	}
	return c.supervisorDo(ctx, http.MethodDelete, "/discovery/"+uuid, nil, nil)
}

func closedDone() <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}

// StartSupervisorDiscovery announces the app to Home Assistant through
// Supervisor discovery and returns immediately; the announcement is withdrawn
// when ctx is cancelled. The returned channel closes once the goroutine is
// finished, so a caller can wait for the withdraw before exiting.
//
// Supervisor installs only: without a Supervisor connection this does nothing
// but return a closed channel. A failed announcement is logged and never
// retried, and startup or shutdown is never blocked beyond withdrawTimeout.
func (c *Client) StartSupervisorDiscovery(ctx context.Context, host string, port int) <-chan struct{} {
	if c.supervisorBase == "" || c.token == "" {
		config.DebugLogf("supervisor discovery: no Supervisor connection, skipping")
		return closedDone()
	}
	if host == "" || port < 1 || port > 65535 {
		log.Printf("supervisor discovery: skipped, no usable app hostname or port")
		return closedDone()
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		uuid, err := c.announceDiscovery(ctx, host, port)
		if err != nil {
			// A cancelled ctx means shutdown started; that is not a failure to report.
			if ctx.Err() == nil {
				log.Printf("supervisor discovery: announcing the app to Home Assistant failed: %v", err)
			}
			return
		}
		log.Printf("supervisor discovery: announced the app to Home Assistant")

		<-ctx.Done()
		wctx, cancel := context.WithTimeout(context.Background(), withdrawTimeout)
		defer cancel()
		if err := c.withdrawDiscovery(wctx, uuid); err != nil {
			log.Printf("supervisor discovery: withdrawing the announcement failed: %v", err)
		}
	}()
	return done
}
