package redact

import (
	"strings"
	"testing"
)

func TestRedact(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"glp token header", "request X-GLP-Token: supersecretvalue", "request X-GLP-Token: ***"},
		{"token query", "GET /api/shots?token=abc123&limit=5", "GET /api/shots?token=***&limit=5"},
		{"prefixed token key", "apiToken=abc123", "apiToken=***"},
		{"password", "mqtt connect password=hunter2 failed", "mqtt connect password=*** failed"},
		{"passwd", "passwd=hunter2", "passwd=***"},
		{"bearer", "Authorization: Bearer eyJhbGciOiJIUzI1", "Authorization: Bearer ***"},
		{"url with credentials", "dialing https://alice:hunter2@example.test/api", "dialing [url]"},
		{"go url error", `Get "http://192.168.1.5/api/system/status": dial tcp 192.168.1.5:80: connect: connection refused`,
			`Get "[url]": dial tcp [host]: connect: connection refused`},
		{"websocket url", "failed to WebSocket dial: Get \"ws://gaggimate.local/ws\": EOF", "failed to WebSocket dial: Get \"[url]\": EOF"},
		{"wss url", "wss://gaggimate.local:443/ws closed", "[url] closed"},
		{"dial tcp hostname", "dial tcp gaggiuino.local:80: i/o timeout", "dial tcp [host]: i/o timeout"},
		{"dial tcp ipv6", "dial tcp [fe80::1%eth0]:80: connect: no route to host", "dial tcp [host]: connect: no route to host"},
		{"dial udp4", "dial udp4 10.0.0.2:53: refused", "dial udp4 [host]: refused"},
		{"dns lookup", "dial tcp: lookup gaggiuino.local on 127.0.0.11:53: no such host", "dial tcp: lookup [host] on [host]: no such host"},
		{"dns lookup short", "lookup gaggiuino.local: no such host", "lookup [host]: no such host"},
		{"read tcp", "read tcp 172.30.32.1:4567->192.168.1.5:80: read: connection reset by peer", "read tcp [host]->[host]: read: connection reset by peer"},
		{"bare ipv6", "machine at [::1]:8080 is down", "machine at [host] is down"},
		{"plain error kept", "machine unreachable: context deadline exceeded", "machine unreachable: context deadline exceeded"},
		{"version kept", "firmware 1.4.2 is current", "firmware 1.4.2 is current"},
		{"word lookup kept", "lookup table rebuilt", "lookup table rebuilt"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Redact(tc.in); got != tc.want {
				t.Fatalf("Redact(%q)\n got %q\nwant %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestRedactLeavesNoSecretOrHost(t *testing.T) {
	in := `sync failed: Get "https://alice:hunter2@gaggiuino.local/api?token=abc": dial tcp 192.168.1.5:443: lookup gaggiuino.local on 10.0.0.1:53: no such host`
	got := Redact(in)
	for _, leak := range []string{"alice", "hunter2", "abc", "gaggiuino.local", "192.168.1.5", "10.0.0.1"} {
		if strings.Contains(got, leak) {
			t.Fatalf("%q leaked in %q", leak, got)
		}
	}
}

func TestRedactKeepsTrailingPunctuation(t *testing.T) {
	for in, want := range map[string]string{
		"ws://host.local/ws: EOF":        "[url]: EOF",
		"see (https://host.local/x).":    "see ([url]).",
		"a https://host.local/x, then b": "a [url], then b",
	} {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
}
