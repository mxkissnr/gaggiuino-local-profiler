package main

// Tests for the data-changed route table (datachanged.go) and the end-to-end
// push (#1539). The table's completeness against the OpenAPI spec is pinned
// here so a new write route cannot ship unclassified.

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
	"gopkg.in/yaml.v3"
)

// canonKey normalises a pattern to "METHOD path" with wildcard names erased,
// the same way openapi_routes_test.go's canonical does, so a spec path and the
// mux pattern it resolves to compare equal.
func canonKey(pattern string) string {
	method, path := canonical(pattern)
	return method + " " + path
}

// buildTestMux builds the real handler chain once and hands the caller the
// registered mux via the onMux hook.
func buildTestMux(t *testing.T) *http.ServeMux {
	t.Helper()
	var mux *http.ServeMux
	onMux = func(m *http.ServeMux) { mux = m }
	t.Cleanup(func() { onMux = nil })

	newTestApp(t, appConfig{
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000,
	})
	if mux == nil {
		t.Fatal("buildApp never called onMux; the test hook moved or was removed")
	}
	return mux
}

// TestDataChangedSpecWriteRoutesClassified requires every write operation the
// OpenAPI spec documents to resolve through the mux to a pattern in exactly one
// of dataRoutes and dataIgnored.
func TestDataChangedSpecWriteRoutesClassified(t *testing.T) {
	mux := buildTestMux(t)

	var spec struct {
		Paths map[string]map[string]any `yaml:"paths"`
	}
	specYAML, err := os.ReadFile("../../internal/system/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(specYAML, &spec); err != nil {
		t.Fatalf("parsing openapi.yaml: %v", err)
	}

	inRoutes := map[string]bool{}
	for key := range dataRoutes {
		inRoutes[canonKey(key)] = true
	}
	inIgnored := map[string]bool{}
	for key := range dataIgnored {
		inIgnored[canonKey(key)] = true
	}

	writeMethods := map[string]bool{"post": true, "put": true, "patch": true, "delete": true}
	var failures []string
	checked := 0
	for path, operations := range spec.Paths {
		if !strings.HasPrefix(path, "/api/") {
			continue
		}
		for method := range operations {
			if !writeMethods[method] {
				continue
			}
			checked++
			key := strings.ToUpper(method) + " " + path
			requestPath := openAPIParamRe.ReplaceAllString(path, "1")
			_, got := mux.Handler(httptest.NewRequest(strings.ToUpper(method), requestPath, nil))
			if got == "" {
				failures = append(failures, key+"  (no mux pattern matched)")
				continue
			}
			routes, ignored := inRoutes[canonKey(got)], inIgnored[canonKey(got)]
			if !routes && !ignored {
				failures = append(failures, key+" -> "+got+"  (unclassified: add it to dataRoutes or dataIgnored)")
			}
			if routes && ignored {
				failures = append(failures, key+" -> "+got+"  (present in both dataRoutes and dataIgnored)")
			}
		}
	}
	if checked < 50 {
		t.Fatalf("only %d documented write routes checked; the spec parse likely broke", checked)
	}
	sort.Strings(failures)
	if len(failures) > 0 {
		t.Errorf("documented write routes not classified in exactly one table:\n  %s", strings.Join(failures, "\n  "))
	}
}

// TestDataChangedMapsAreServedPatterns requires every key of both tables to be a
// pattern the mux actually serves, so a typo cannot silently disable publishing.
func TestDataChangedMapsAreServedPatterns(t *testing.T) {
	mux := buildTestMux(t)

	check := func(table string, keys []string) {
		for _, key := range keys {
			method, path := canonical(key)
			if method == "" {
				method = http.MethodGet
			}
			_, got := mux.Handler(httptest.NewRequest(method, openAPIParamRe.ReplaceAllString(path, "1"), nil))
			if canonKey(got) != canonKey(key) {
				t.Errorf("%s %q: the mux matched %q instead", table, key, got)
			}
		}
	}
	routeKeys := make([]string, 0, len(dataRoutes))
	for key := range dataRoutes {
		routeKeys = append(routeKeys, key)
	}
	ignoredKeys := make([]string, 0, len(dataIgnored))
	for key := range dataIgnored {
		ignoredKeys = append(ignoredKeys, key)
	}
	check("dataRoutes", routeKeys)
	check("dataIgnored", ignoredKeys)
}

// TestDataChangedKindsDeclared requires every kind a route names to be one
// sse.NewDataChanges was seeded with (the meta kind all excepted).
func TestDataChangedKindsDeclared(t *testing.T) {
	declared := map[string]bool{}
	for _, kind := range dataKinds {
		declared[kind] = true
	}
	for pattern, route := range dataRoutes {
		for _, kind := range route.Kinds {
			if kind == sse.KindAll {
				continue
			}
			if !declared[kind] {
				t.Errorf("route %q names kind %q, which is not in dataKinds", pattern, kind)
			}
		}
	}
}

// TestDataChangedReclassifiedRoutes pins the classification the live-sync
// review settled on: a shot write changes the library's derived stock and wear
// too, and completing an order changes the shot list and the library.
func TestDataChangedReclassifiedRoutes(t *testing.T) {
	cases := []struct {
		pattern string
		kinds   []string
		withID  bool
	}{
		{"POST /api/shots/{id}/annotate", []string{"shot", "library"}, true},
		{"POST /api/shots/{id}/trash", []string{"shots", "library"}, false},
		{"POST /api/shots/{id}/restore", []string{"shots", "library"}, false},
		{"POST /api/shots/{id}/delete", []string{"shots", "library"}, false},
		{"POST /api/orders/{id}/complete", []string{"orders", "shots", "library"}, false},
	}
	for _, tc := range cases {
		route, ok := dataRoutes[tc.pattern]
		if !ok {
			t.Errorf("route %q is not in dataRoutes", tc.pattern)
			continue
		}
		if got := strings.Join(route.Kinds, ","); got != strings.Join(tc.kinds, ",") {
			t.Errorf("route %q kinds = %v, want %v", tc.pattern, route.Kinds, tc.kinds)
		}
		if route.WithID != tc.withID {
			t.Errorf("route %q WithID = %v, want %v", tc.pattern, route.WithID, tc.withID)
		}
	}
}

// readDataChanged reads the SSE stream until an EventDataChanged frame arrives
// and decodes its payload, skipping the priming, live-snapshot and ping frames
// interleaved on the connection. It returns the typed payload and its raw keys,
// so a caller can pin the exact wire shape.
func readDataChanged(t *testing.T, reader *bufio.Reader) (sse.DataChanged, map[string]json.RawMessage) {
	t.Helper()
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("reading /api/events: %v", err)
		}
		if line != "event: "+sse.EventDataChanged+"\n" {
			continue
		}
		dataLine, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("reading the data-changed data line: %v", err)
		}
		raw := []byte(strings.TrimPrefix(dataLine, "data: "))
		var dc sse.DataChanged
		if err := json.Unmarshal(raw, &dc); err != nil {
			t.Fatalf("decoding data-changed payload %q: %v", dataLine, err)
		}
		var keys map[string]json.RawMessage
		if err := json.Unmarshal(raw, &keys); err != nil {
			t.Fatalf("decoding data-changed payload keys %q: %v", dataLine, err)
		}
		return dc, keys
	}
}

// assertPayloadKeys fails unless an event payload carries exactly the four keys
// the live-sync client relies on: kind, rev, src and epoch. An id only appears
// on a route that addresses one entity, so these events omit it.
func assertPayloadKeys(t *testing.T, keys map[string]json.RawMessage, label string) {
	t.Helper()
	got := make([]string, 0, len(keys))
	for k := range keys {
		got = append(got, k)
	}
	sort.Strings(got)
	want := []string{"epoch", "kind", "rev", "src"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%s payload keys = %v, want exactly %v", label, got, want)
	}
}

// TestDataChangedEndToEnd boots the real chain, opens /api/events, and checks
// that a ui-prefs PUT and a bean create each push a data-changed event carrying
// the writing client's id.
func TestDataChangedEndToEnd(t *testing.T) {
	base, token := newSmokeServer(t)

	req, err := http.NewRequest(http.MethodGet, base+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-GLP-Token", token)
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET /api/events: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/events status = %d, want 200", resp.StatusCode)
	}
	reader := bufio.NewReader(resp.Body)

	// The handler primes preheat/live before it subscribes; give it a moment so
	// the first write's event is not published before the subscription exists.
	time.Sleep(200 * time.Millisecond)

	write := func(method, path, body, clientID string) {
		t.Helper()
		r, err := http.NewRequest(method, base+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set("X-GLP-Token", token)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-GLP-Client", clientID)
		wrote, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		wrote.Body.Close()
		if wrote.StatusCode != http.StatusOK {
			t.Fatalf("%s %s status = %d, want 200", method, path, wrote.StatusCode)
		}
	}

	write(http.MethodPut, "/api/ui-prefs", `{"view":"grid"}`, "t1")
	uiPrefs, uiPrefsKeys := readDataChanged(t, reader)
	if uiPrefs.Kind != "ui-prefs" || uiPrefs.Src != "t1" || uiPrefs.ID != "" || uiPrefs.Rev == 0 || uiPrefs.Epoch == "" {
		t.Errorf("ui-prefs event = %+v, want kind ui-prefs, src t1, no id, non-zero rev, an epoch", uiPrefs)
	}
	assertPayloadKeys(t, uiPrefsKeys, "ui-prefs")

	write(http.MethodPost, "/api/library/bean", `{"name":"Live Sync Bean"}`, "t2")
	bean, beanKeys := readDataChanged(t, reader)
	if bean.Kind != "library" || bean.Src != "t2" || bean.ID != "" || bean.Rev == 0 || bean.Epoch == "" {
		t.Errorf("library event = %+v, want kind library, src t2, no id, non-zero rev, an epoch", bean)
	}
	assertPayloadKeys(t, beanKeys, "library")
}
