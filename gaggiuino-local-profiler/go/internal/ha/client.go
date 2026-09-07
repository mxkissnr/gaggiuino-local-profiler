// Package ha ports lib/ha.js: SendNotify (mobile-app push via HA's
// notify.* services), GetNotifyServices (for the notify-service picker),
// and GetPersons (for the shop-open/closed broadcast's "only notify
// devices currently home" filter and the notify-mapping customer list) —
// all Phase 1f (orders domain) additions — plus GetSwitchState,
// CallHaService, and GetHaLanguage, added in Phase 1g (#901, system
// domain) for lib/poll.js's checkAndApplyMachinePower/
// _checkReadyByPreheat and lib/preheat.js's _checkPreheatNotify.
// getHaState is still NOT ported — nothing in either phase's HTTP surface
// reaches it (it only backs Settings-page MQTT discovery in Node).
//
// This package did not exist before Phase 1f: earlier phases (shots,
// library, machines) never needed to call the Home Assistant REST API
// itself, only to be reached *through* HA Ingress (internal/auth). Every
// function here degrades to a no-op/empty-result (or, for CallHaService,
// an error) when no token is configured, exactly like the Node original —
// never a panic, since HA integration is optional (direct-port mode with
// no Supervisor and no GLP_HA_URL/GLP_HA_TOKEN is a fully supported
// configuration).
package ha

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Client ports lib/ha.js's module-level HA_API/HA_TOKEN constants as
// instance fields instead of process-wide globals, so tests can construct
// one pointed at an httptest.Server. NewClientFromEnv() below reproduces
// lib/constants.js's exact derivation for the values cmd/server actually
// wires in.
type Client struct {
	apiBase string // "" when no HA connection is configured (Ingress-only / no Supervisor, no GLP_HA_URL)
	token   string
	http    *http.Client

	langOnce sync.Once
	lang     string
}

// NewClientFromEnv ports lib/constants.js's HA_API/HA_TOKEN derivation:
//   - SUPERVISOR_TOKEN set (running under the Supervisor) -> HA_API is the
//     internal supervisor proxy, HA_TOKEN is SUPERVISOR_TOKEN.
//   - otherwise, GLP_HA_URL set (standalone Docker, #764) -> HA_API is
//     GLP_HA_URL + "/api", HA_TOKEN is GLP_HA_TOKEN (only read in this
//     branch, matching the Node original's `GLP_HA_URL ? ... GLP_HA_TOKEN
//     : undefined`).
//   - neither set -> apiBase/token both empty; every method below becomes
//     a no-op, matching HA_TOKEN's falsy short-circuit in lib/ha.js.
func NewClientFromEnv() *Client {
	supervisorToken := os.Getenv("SUPERVISOR_TOKEN")
	glpHAURL := strings.TrimSuffix(os.Getenv("GLP_HA_URL"), "/")

	var apiBase, token string
	switch {
	case supervisorToken != "":
		apiBase = "http://supervisor/core/api"
		token = supervisorToken
	case glpHAURL != "":
		apiBase = glpHAURL + "/api"
		token = os.Getenv("GLP_HA_TOKEN")
	}
	return &Client{apiBase: apiBase, token: token, http: &http.Client{Timeout: 5 * time.Second}}
}

func (c *Client) enabled() bool { return c.token != "" }

// Enabled reports whether this Client has a usable HA connection — the
// exported form of enabled(), for callers outside this package that need
// to gate their own logic on it (POST /api/preheat/ready-by's "switch_entity
// nicht konfiguriert" 400, matching Node's own `!HA_TOKEN` check).
func (c *Client) Enabled() bool { return c.enabled() }

// SendNotify ports lib/ha.js's sendHaNotify(service, title, message, tag):
// posts to HA's notify.<service> service call. Best-effort — logs (via the
// returned error, which every call site in this phase treats as
// non-critical/fire-and-forget, matching Node's own `.catch` swallowing)
// rather than failing the caller's HTTP response.
func (c *Client) SendNotify(ctx context.Context, service, title, message, tag string) error {
	if !c.enabled() || service == "" {
		return nil
	}
	domain, svcName, ok := strings.Cut(service, ".")
	if !ok {
		return nil
	}
	body := map[string]any{
		"title":   title,
		"message": message,
		"data": map[string]any{
			"tag": nullableString(tag),
			"push": map[string]any{
				"sound": "default",
			},
		},
	}
	_, err := c.post(ctx, "/services/"+domain+"/"+svcName, body)
	return err
}

func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GetSwitchState ports lib/ha.js's getSwitchState(entity): nil means
// "unknown" — no token configured, no entity given, or the call failed —
// matching the Node original's null return, which every caller (poll.go's
// checkAndApplyMachinePower) treats as "skip this tick, don't act on it".
func (c *Client) GetSwitchState(ctx context.Context, entity string) *bool {
	if !c.enabled() || entity == "" {
		return nil
	}
	var st struct {
		State string `json:"state"`
	}
	if err := c.get(ctx, "/states/"+entity, &st); err != nil {
		return nil
	}
	on := st.State == "on"
	return &on
}

// CallHaService ports lib/ha.js's callHaService(domain, service, data).
// Unlike SendNotify (fire-and-forget, every call site already treats a
// failure as non-critical), callers here need to know whether the call
// actually took effect — POST /api/switch/toggle and the ready-by preheat
// watcher's auto turn-on both act on the result — so this returns the
// error instead of swallowing it, matching callHaService's `throw` on both
// "no token" and a failed request.
func (c *Client) CallHaService(ctx context.Context, domain, service string, data map[string]any) error {
	if !c.enabled() {
		return fmt.Errorf("HA token unavailable")
	}
	_, err := c.post(ctx, "/services/"+domain+"/"+service, data)
	return err
}

// haSupportedLangs mirrors getHaLanguage()'s hardcoded allow-list — any
// other HA instance language falls back to English, not passed through.
var haSupportedLangs = map[string]bool{"de": true, "en": true, "it": true, "fr": true, "es": true, "nl": true}

// GetHaLanguage ports lib/ha.js's getHaLanguage(): the HA instance's
// configured language, cached for the process lifetime (same as Node's
// module-level _haLang cache — HA's own language setting doesn't change
// without a restart). Falls back to "en", not "de", on any failure or an
// unrecognized language — see lib/notify-i18n.js's own fallback comment
// for why: a standalone-Docker user with no Supervisor token used to get
// German notifications by construction regardless of their own locale.
//
// No caller outside this package's own tests yet (#901 code review): this
// is prep for _checkPreheatNotify's localized push text, which
// go/internal/system/preheat.go's header comment documents as deliberately
// deferred (needs a read dependency on internal/orders' settings) rather
// than out of scope entirely — kept, not removed, for the same reason that
// file's own preheatNotifySent field is kept.
func (c *Client) GetHaLanguage(ctx context.Context) string {
	c.langOnce.Do(func() {
		c.lang = "en"
		if !c.enabled() {
			return
		}
		var cfg struct {
			Language string `json:"language"`
		}
		if err := c.get(ctx, "/config", &cfg); err != nil {
			return
		}
		lang := strings.ToLower(cfg.Language)
		if len(lang) > 2 {
			lang = lang[:2]
		}
		if haSupportedLangs[lang] {
			c.lang = lang
		}
	})
	return c.lang
}

// NotifyService mirrors one entry of GetNotifyServices()'s result.
type NotifyService struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// GetNotifyServices ports lib/ha.js's getNotifyServices(): every
// notify.<x> service registered in HA, excluding the generic notify.notify/
// notify.send_message aliases. Returns an empty (non-nil) slice, never an
// error, on any failure — matching the Node original's `catch { return []
// }`.
func (c *Client) GetNotifyServices(ctx context.Context) []NotifyService {
	out := []NotifyService{}
	if !c.enabled() {
		return out
	}
	var services []struct {
		Domain   string                     `json:"domain"`
		Services map[string]json.RawMessage `json:"services"`
	}
	if err := c.get(ctx, "/services", &services); err != nil {
		return out
	}
	for _, d := range services {
		if d.Domain != "notify" {
			continue
		}
		for name := range d.Services {
			if name == "notify" || name == "send_message" {
				continue
			}
			out = append(out, NotifyService{ID: "notify." + name, Name: strings.ReplaceAll(name, "_", " ")})
		}
	}
	return out
}

// Person mirrors one entry of GetPersons()'s result.
type Person struct {
	HAUserID string
	Name     string
	State    string
}

// GetPersons ports lib/ha.js's getHaPersons(): every person.* entity that
// carries a user_id attribute. Returns an empty (non-nil) slice on any
// failure, matching the Node original.
func (c *Client) GetPersons(ctx context.Context) []Person {
	out := []Person{}
	if !c.enabled() {
		return out
	}
	var states []struct {
		EntityID   string `json:"entity_id"`
		State      string `json:"state"`
		Attributes struct {
			UserID       string `json:"user_id"`
			FriendlyName string `json:"friendly_name"`
		} `json:"attributes"`
	}
	if err := c.get(ctx, "/states", &states); err != nil {
		return out
	}
	for _, e := range states {
		if !strings.HasPrefix(e.EntityID, "person.") || e.Attributes.UserID == "" {
			continue
		}
		name := e.Attributes.FriendlyName
		if name == "" {
			name = strings.TrimPrefix(e.EntityID, "person.")
		}
		state := e.State
		if state == "" {
			state = "not_home"
		}
		out = append(out, Person{HAUserID: e.Attributes.UserID, Name: name, State: state})
	}
	return out
}

// SupervisorGet performs an authenticated GET against the Supervisor's own
// API root (http://supervisor — lib/constants.js's SUPERVISOR_API), NOT the
// Core proxy c.apiBase points at. Used by internal/mqtt's broker
// auto-discovery (lib/mqtt-discovery.js's discoverSupervisorMqtt). Returns
// an error (never a panic) when no token is configured or the call fails —
// callers treat that as "not available", matching the Node original's
// try/catch -> null and its `if (!HA_TOKEN) return null` guard.
func (c *Client) SupervisorGet(ctx context.Context, path string, out any) error {
	if !c.enabled() {
		return fmt.Errorf("no Supervisor token")
	}
	return c.getFrom(ctx, "http://supervisor", path, out)
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	return c.getFrom(ctx, c.apiBase, path, out)
}

func (c *Client) getFrom(ctx context.Context, base, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errStatus(resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) post(ctx context.Context, path string, body any) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiBase+path, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return resp, errStatus(resp.StatusCode)
	}
	return resp, nil
}

type errStatus int

func (e errStatus) Error() string { return http.StatusText(int(e)) }
