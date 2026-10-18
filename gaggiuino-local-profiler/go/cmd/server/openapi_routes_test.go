package main

// TestOpenAPIRoutesMatchMux keeps the mux registrations and
// internal/system/openapi.yaml in sync in one direction only: every /api route
// documented in the spec must be served by its own mux pattern (#1103). For
// each spec path + method it issues a request through the fully-built handler
// chain and requires mux.Handler to report that route's pattern.
//
// TestMuxRoutesAreDocumented checks the reverse direction: every
// "METHOD /api/..." pattern registered with HandleFunc/Handle in the Go
// sources must appear in the spec. net/http cannot enumerate a ServeMux's
// patterns, so it reads the registration literals from the source files.

import (
	"io/fs"
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

// undocumentedAllowed lists registered routes that are deliberately left out
// of the spec, keyed "METHOD /path", value = the reason.
var undocumentedAllowed = map[string]string{
	"GET /api/debug/ingress":           "dev-build-only diagnostics route",
	"GET /api/debug/ingress/sse-probe": "dev-build-only diagnostics route",
}

var openAPIParamRe = regexp.MustCompile(`\{[^}]*\}`)

var routeRegistrationRe = regexp.MustCompile(`\.Handle(?:Func)?\("([A-Z]+ /api/[^"]*)"`)

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

	newTestApp(t, appConfig{
		port:            "0",
		rateLimitWindow: time.Minute,
		rateLimitMax:    1_000_000,
	})
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

// specRoutes returns every documented "METHOD path" in openapi.yaml, with
// paths normalised by canonical.
func specRoutes(t *testing.T) map[string]bool {
	t.Helper()
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
	out := map[string]bool{}
	for path, operations := range spec.Paths {
		for method := range operations {
			m, p := canonical(strings.ToUpper(method) + " " + path)
			out[m+" "+p] = true
		}
	}
	return out
}

func TestMuxRoutesAreDocumented(t *testing.T) {
	documented := specRoutes(t)
	var failures []string
	found := 0
	for _, root := range []string{"../../internal", "."} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			for _, m := range routeRegistrationRe.FindAllStringSubmatch(string(src), -1) {
				found++
				pattern := m[1]
				if _, ok := undocumentedAllowed[pattern]; ok {
					continue
				}
				method, p := canonical(pattern)
				if !documented[method+" "+p] {
					failures = append(failures, pattern+"  ("+path+")")
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if found < 20 {
		t.Fatalf("only %d route registrations found; the source scan likely broke", found)
	}
	sort.Strings(failures)
	if len(failures) > 0 {
		t.Errorf("registered /api routes missing from openapi.yaml:\n  %s",
			strings.Join(failures, "\n  "))
	}
}
