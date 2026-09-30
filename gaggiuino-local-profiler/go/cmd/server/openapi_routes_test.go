package main

// TestOpenAPIRoutesMatchMux keeps the mux registrations and
// internal/system/openapi.yaml in sync in one direction only: every /api route
// documented in the spec must be served by its own mux pattern (#1103). For
// each spec path + method it issues a request through the fully-built handler
// chain and requires mux.Handler to report that route's pattern.
//
// The reverse direction — a route registered on the mux but missing from the
// spec — is deliberately not checked: net/http exposes no way to enumerate a
// ServeMux's registered patterns without its unexported internals, so the test
// cannot see an undocumented route to compare it.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

// unregisteredAllowed lists documented routes that are deliberately not on the
// production mux, keyed "METHOD /path", value = the reason.
var unregisteredAllowed = map[string]string{
	// Registered only when GLP_DEV_BUILD is set (#1051); the test build leaves
	// it unset, exactly like a real install.
	"GET /api/debug/machine": "dev-build-only route",
}

var openAPIParamRe = regexp.MustCompile(`\{[^}]*\}`)

// canonical splits a mux pattern into its HTTP method (empty for a method-less
// pattern) and a path normalised for comparison: a trailing {$} is dropped and
// every {name}/{name...} wildcard becomes {} so parameter names need not match
// between the spec and the mux.
func canonical(pattern string) (method, path string) {
	method, path = "", pattern
	if m, rest, ok := strings.Cut(pattern, " "); ok {
		method, path = m, rest
	}
	path = strings.TrimSuffix(path, "{$}")
	path = openAPIParamRe.ReplaceAllString(path, "{}")
	return strings.ToUpper(method), path
}

func TestOpenAPIRoutesMatchMux(t *testing.T) {
	var mux *http.ServeMux
	onMux = func(m *http.ServeMux) { mux = m }
	t.Cleanup(func() { onMux = nil })

	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	_, sqlDB, err := buildApp(ctx, appConfig{
		dbPath:          filepath.Join(dir, "glp.db"),
		tokenPath:       filepath.Join(dir, "api_token.txt"),
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000,
	})
	if err != nil {
		cancel()
		t.Fatalf("buildApp: %v", err)
	}
	t.Cleanup(func() { cancel(); sqlDB.Close() })
	if mux == nil {
		t.Fatal("buildApp never called onMux; the test hook moved or was removed")
	}

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

	httpMethods := map[string]bool{
		"get": true, "post": true, "put": true, "patch": true, "delete": true,
	}
	var failures []string
	checked := 0
	for path, operations := range spec.Paths {
		if !strings.HasPrefix(path, "/api/") {
			continue
		}
		for method := range operations {
			if !httpMethods[method] {
				continue
			}
			checked++
			key := strings.ToUpper(method) + " " + path
			if _, ok := unregisteredAllowed[key]; ok {
				continue
			}

			// A concrete request path: each {param} replaced by a value so the
			// mux can route it to the documented pattern.
			requestPath := openAPIParamRe.ReplaceAllString(path, "1")
			req := httptest.NewRequest(strings.ToUpper(method), requestPath, nil)
			_, got := mux.Handler(req)

			wantMethod, wantPath := canonical(key)
			gotMethod, gotPath := canonical(got)
			if gotPath == "" {
				failures = append(failures, key+"  (no mux pattern matched)")
				continue
			}
			if gotPath != wantPath || (gotMethod != "" && gotMethod != wantMethod) {
				failures = append(failures, key+"  (matched "+got+")")
			}
		}
	}

	if checked < 20 {
		t.Fatalf("only %d documented /api routes checked; the spec parse likely broke", checked)
	}
	sort.Strings(failures)
	if len(failures) > 0 {
		t.Errorf("documented /api routes not served by their own mux pattern:\n  %s",
			strings.Join(failures, "\n  "))
	}
}
