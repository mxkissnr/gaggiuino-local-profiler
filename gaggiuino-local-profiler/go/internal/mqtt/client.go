package mqtt

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/url"
	"sync"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines/proto"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/netguard"
)

// This file ports lib/gaggiuino-mqtt-client.js (#608): the MQTT alternative
// to internal/machines/live.go's persistent-WS-session cache. It subscribes
// to the machine's own MQTT-published topics (gaggiuino.github.io's
// docs/rest-api/MQTT.md) and translates the `<prefix>/sensors` /
// `<prefix>/system` JSON payloads into the exact same proto DTOs
// internal/machines/live.go's WS decoder produces — so the poller
// (internal/system) stays unaware of which transport populated the cache.
//
// The `mqtt` npm package -> github.com/eclipse/paho.mqtt.golang (v1.5.x,
// EPL-2.0 / EDL-1.0). shot/profile/active/maintenance/notification topics
// are subscribed (MQTT.md's full list) but not consumed, same deliberate
// scope boundary as the Node original's subscribe() comment.

// staleAfter mirrors gaggiuino-mqtt-client.js's STALE_MS.
const staleAfter = 15 * time.Second

// mqttHostGuardTimeout bounds the SSRF guard's DNS lookup in connect()
// (#990 code review): GetLiveSensorSnapshot/GetLiveSystemState call
// connect() synchronously on every live-poll tick whenever no session is
// open yet, so an unbounded context.Background() here would let a slow or
// hanging resolution stall that polling goroutine indefinitely.
const mqttHostGuardTimeout = 5 * time.Second

// mqttDialer pins every paho-internal (re)connection — both connect()'s
// initial dial and every automatic reconnect SetAutoReconnect(true)
// triggers on its own — to the SSRF-guard-resolved IP (#988/#990 code
// review): paho redials the broker independently via its own dialer on
// every reconnect, so the one-time machines.AssertMachineHost check in
// connect() below covers only the first connection attempt, not any
// reconnect after a dropped connection. Uses the shared
// netguard.GuardedDialer (also used by internal/machines/http.go and
// internal/importer/fetch.go) via SetCustomOpenConnectionFn, which
// replaces paho's own openConnection entirely — this app only ever adds a
// "tcp://" broker (see AddBroker below), so openGuardedMQTTConnection
// doesn't need to handle paho's ws/wss/unix branches.
var mqttDialer = netguard.NewGuardedDialer(machines.AssertMachineHostResolved)

// openGuardedMQTTConnection is connect()'s paho.OpenConnectionFunc: dials
// uri.Host (a "host:port" broker address) through mqttDialer instead of
// paho's own default openConnection, bounding the guard's DNS lookup +
// dial to options.ConnectTimeout (the same 10s SetConnectTimeout below
// configures) so a hanging resolution can't wedge paho's connect
// goroutine forever.
func openGuardedMQTTConnection(uri *url.URL, opts paho.ClientOptions) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), opts.ConnectTimeout)
	defer cancel()
	return mqttDialer.DialContext(ctx, "tcp", uri.Host)
}

// Conn is the broker connection descriptor — { host, port, username,
// password, prefix }, normally read straight from Repository by transport.go.
type Conn struct {
	Host     string
	Port     int
	Username string
	Password string
	Prefix   string
}

func (c Conn) port() int {
	if c.Port == 0 {
		return 1883
	}
	return c.Port
}

func (c Conn) prefix() string {
	if c.Prefix == "" {
		return "gaggiuino"
	}
	return c.Prefix
}

// key ports connKeyFor(conn): sessions are keyed by the connection
// descriptor itself so tests can spin up isolated brokers without colliding.
func (c Conn) key() string {
	return fmt.Sprintf("%s:%d:%s", c.Host, c.port(), c.prefix())
}

type session struct {
	mu           sync.Mutex
	client       paho.Client
	connecting   bool
	sensorSnap   *proto.SensorStateSnapshotDto
	sensorSnapAt time.Time
	sysState     *proto.SystemStateDto
	sysStateAt   time.Time
	available    *bool

	loggedFirstSensorSnap bool
	loggedFirstSysState   bool
}

// Client ports gaggiuino-mqtt-client.js's module-level `sessions` map +
// connect()/disconnect() as a struct, so cmd/server owns one instance
// (same rationale as internal/machines' gaggiuinoLiveClient).
type Client struct {
	mu       sync.Mutex
	sessions map[string]*session

	// newPahoClient is the paho.NewClient seam — tests substitute a fake
	// that never touches a real socket.
	newPahoClient func(*paho.ClientOptions) paho.Client
}

func NewClient() *Client {
	return &Client{
		sessions:      make(map[string]*session),
		newPahoClient: paho.NewClient,
	}
}

func (c *Client) getSession(conn Conn) *session {
	c.mu.Lock()
	defer c.mu.Unlock()
	if s, ok := c.sessions[conn.key()]; ok {
		return s
	}
	s := &session{}
	c.sessions[conn.key()] = s
	return s
}

// connect ports connect(conn): lazily opens the session's broker connection
// as a side effect of a getter, exactly like the Node original.
func (c *Client) connect(conn Conn) *session {
	s := c.getSession(conn)
	s.mu.Lock()
	if s.client != nil || s.connecting || conn.Host == "" {
		s.mu.Unlock()
		return s
	}
	s.connecting = true
	s.mu.Unlock()

	// #988: the broker host is user-supplied (manual settings entry, or a
	// restored backup's raw kv row — neither goes through parseSettings'
	// own check, see handlers.go's postSettings), so it needs the same
	// SSRF guard a machine's own host gets before anything dials it.
	// machines.AssertMachineHost's loopback/link-local/metadata-only
	// predicate is the right threat model here too: a real MQTT broker
	// legitimately lives in RFC1918 space, same as a real machine. Bounded
	// by mqttHostGuardTimeout (#990 code review), not context.Background()
	// unbounded — connect() runs synchronously on every live-poll tick
	// whenever no session is open yet, so a hanging DNS lookup here would
	// otherwise stall that polling goroutine indefinitely.
	guardCtx, cancel := context.WithTimeout(context.Background(), mqttHostGuardTimeout)
	err := machines.AssertMachineHost(guardCtx, conn.Host)
	cancel()
	if err != nil {
		log.Printf("Gaggiuino MQTT: broker host %q rejected by SSRF guard: %v", conn.Host, err)
		s.mu.Lock()
		s.connecting = false
		s.mu.Unlock()
		return s
	}

	prefix := conn.prefix()
	opts := paho.NewClientOptions().
		AddBroker(fmt.Sprintf("tcp://%s:%d", conn.Host, conn.port())).
		SetConnectTimeout(10 * time.Second).
		SetAutoReconnect(true).
		SetConnectRetryInterval(3 * time.Second).
		SetKeepAlive(30 * time.Second).
		SetCustomOpenConnectionFn(openGuardedMQTTConnection)
	if conn.Username != "" {
		opts.SetUsername(conn.Username)
	}
	if conn.Password != "" {
		opts.SetPassword(conn.Password)
	}
	opts.SetOnConnectHandler(func(client paho.Client) {
		s.mu.Lock()
		s.connecting = false
		s.loggedFirstSensorSnap = false
		s.loggedFirstSysState = false
		s.mu.Unlock()
		log.Printf("Gaggiuino MQTT connected (%s:%d, prefix %q)", conn.Host, conn.port(), prefix)
		topics := map[string]byte{
			prefix + "/sensors": 0, prefix + "/system": 0, prefix + "/status": 0,
			prefix + "/shot": 0, prefix + "/profile/active": 0, prefix + "/maintenance": 0, prefix + "/notification": 0,
		}
		if tok := client.SubscribeMultiple(topics, func(_ paho.Client, m paho.Message) {
			c.onMessage(conn, s, m.Topic(), m.Payload())
		}); tok.Wait() && tok.Error() != nil {
			log.Printf("Gaggiuino MQTT subscribe error: %v", tok.Error())
		}
	})
	opts.SetConnectionLostHandler(func(_ paho.Client, err error) {
		s.mu.Lock()
		s.connecting = false
		avail := false
		s.available = &avail
		s.mu.Unlock()
		log.Printf("Gaggiuino MQTT connection lost (%s:%d): %v", conn.Host, conn.port(), err)
	})

	client := c.newPahoClient(opts)
	s.mu.Lock()
	s.client = client
	s.mu.Unlock()
	client.Connect() // async; SetAutoReconnect + retry handle failures

	return s
}

func (c *Client) onMessage(conn Conn, s *session, topic string, payload []byte) {
	prefix := conn.prefix()
	if topic == prefix+"/status" {
		online := string(payload) == "online"
		s.mu.Lock()
		s.available = &online
		s.mu.Unlock()
		return
	}
	switch topic {
	case prefix + "/sensors":
		snap := toSensorSnap(payload)
		if snap == nil {
			return
		}
		s.mu.Lock()
		s.sensorSnap = snap
		s.sensorSnapAt = time.Now()
		first := !s.loggedFirstSensorSnap
		s.loggedFirstSensorSnap = true
		s.mu.Unlock()
		if first {
			log.Printf("Gaggiuino MQTT: first %q message received — live sensor data flowing", topic)
		}
	case prefix + "/system":
		state := toSysState(payload)
		if state == nil {
			return
		}
		s.mu.Lock()
		s.sysState = state
		s.sysStateAt = time.Now()
		first := !s.loggedFirstSysState
		s.loggedFirstSysState = true
		s.mu.Unlock()
		if first {
			log.Printf("Gaggiuino MQTT: first %q message received — live system data flowing", topic)
		}
	}
	// shot/profile/active/maintenance/notification: received, not consumed.
}

func freshOrNil[T any](v *T, at time.Time) *T {
	if v == nil || time.Since(at) > staleAfter {
		return nil
	}
	return v
}

// GetLiveSensorSnapshot ports getLiveSensorSnapshot(conn): lazily (re)opens
// the session as a side effect, returns nil for a stale/absent value.
func (c *Client) GetLiveSensorSnapshot(conn Conn) *proto.SensorStateSnapshotDto {
	s := c.connect(conn)
	s.mu.Lock()
	defer s.mu.Unlock()
	return freshOrNil(s.sensorSnap, s.sensorSnapAt)
}

// GetLiveSystemState ports getLiveSystemState(conn).
func (c *Client) GetLiveSystemState(conn Conn) *proto.SystemStateDto {
	s := c.connect(conn)
	s.mu.Lock()
	defer s.mu.Unlock()
	return freshOrNil(s.sysState, s.sysStateAt)
}

// DisconnectAll ports disconnectAll(): closes and forgets every open
// session, so a settings save takes effect on the next read instead of a
// stale connection lingering against the old broker.
func (c *Client) DisconnectAll() {
	c.mu.Lock()
	sessions := c.sessions
	c.sessions = make(map[string]*session)
	c.mu.Unlock()
	for _, s := range sessions {
		s.mu.Lock()
		client := s.client
		s.client = nil
		s.mu.Unlock()
		if client != nil {
			client.Disconnect(250)
		}
	}
}

// ── payload mapping ────────────────────────────────────────────────────

func parseJSON(payload []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(payload, &m); err != nil {
		return nil
	}
	return m
}

func num(m map[string]any, key string) float64 {
	switch v := m[key].(type) {
	case float64:
		return v
	}
	return 0
}

func boolv(m map[string]any, key string) bool {
	b, _ := m[key].(bool)
	return b
}

func strv(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// toSensorSnap ports gaggiuino-mqtt-client.js's toSensorSnap(p): MQTT.md's
// `<prefix>/sensors` field names -> the field names SensorStateSnapshotDto
// decodes WS d_sensor_snap pushes into. Only the subset deriveMachineState()
// reads is mapped, plus the direct-1:1 fields; the WS-only pin*Level
// diagnostics have no MQTT equivalent and stay zero-valued.
func toSensorSnap(payload []byte) *proto.SensorStateSnapshotDto {
	p := parseJSON(payload)
	if p == nil {
		return nil
	}
	return &proto.SensorStateSnapshotDto{
		BrewActive:            boolv(p, "brewActive"),
		SteamActive:           boolv(p, "steamActive"),
		HotWaterSwitchState:   boolv(p, "hotWaterActive"),
		Temperature:           num(p, "temperature"),
		WaterTemperature:      num(p, "waterTemperature"),
		Pressure:              num(p, "pressure"),
		PumpFlow:              num(p, "pumpFlow"),
		WeightFlow:            num(p, "weightFlow"),
		Weight:                num(p, "weight"),
		WaterLevel:            uint32(num(p, "waterLevel")),
		BoilerState:           boolv(p, "boilerOn"),
		ValveState:            boolv(p, "valveOpen"),
		SteamValveState:       boolv(p, "steamValveOn"),
		ValveBState:           boolv(p, "valveBOpen"),
		SteamBoilerRelayState: boolv(p, "steamBoilerRelayOn"),
	}
}

// toSysState ports gaggiuino-mqtt-client.js's toSysState(p): MQTT.md's
// `<prefix>/system` payload -> SystemStateDto's field names. operationMode
// arrives as the enum's string name (e.g. "BREW_AUTO") over MQTT;
// proto.OperationMode.UnmarshalJSON accepts either the string or a numeric
// wire value, so it decodes into the same typed value a WS push would (the
// #901 Phase 0 NormalizeOperationMode reconciliation).
func toSysState(payload []byte) *proto.SystemStateDto {
	p := parseJSON(payload)
	if p == nil {
		return nil
	}
	var mode proto.OperationMode
	if raw, ok := p["operationMode"]; ok {
		if b, err := json.Marshal(raw); err == nil {
			_ = json.Unmarshal(b, &mode) // unknown value -> leaves the zero mode, message not dropped
		}
	}
	return &proto.SystemStateDto{
		StartupInitFinished:       boolv(p, "startupInitFinished"),
		TofReady:                  boolv(p, "tofReady"),
		ScalesPresent:             boolv(p, "scalesPresent"),
		OperationMode:             mode,
		TimeAlive:                 uint32(num(p, "timeAliveSec")),
		CoreVersion:               strv(p, "coreVersion"),
		TarePending:               boolv(p, "tarePending"),
		ThermocoupleFaulted:       boolv(p, "thermocoupleFaulted"),
		PressureSensorFaulted:     boolv(p, "pressureSensorFaulted"),
		ThermocoupleFaultReason:   strv(p, "thermocoupleFaultReason"),
		PressureSensorFaultReason: strv(p, "pressureSensorFaultReason"),
	}
}
