package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
	"unsafe"

	"gopkg.in/yaml.v3"
)

// TestOpenAPIRoutesMatchMux keeps the real mux registrations and
// internal/system/openapi.yaml in sync in both directions (#1103): a handler
// that is never registered (#1122) or a route without a spec entry fails
// here. Only /api/ routes are compared; UI/static/ingress routes are not part
// of the contract.

// Genuine gaps, each with the reason it is not (yet) in the spec.
var (
	// registered on the mux, deliberately not in openapi.yaml
	undocumentedAllowed = map[string]string{}
	// in openapi.yaml, deliberately not on the mux
	unregisteredAllowed = map[string]string{
		// registered only when GLP_DEV_BUILD is set (#1051), which the test build does not set
		"GET /api/debug/machine": "dev-build-only route",
	}
)

var paramRe = regexp.MustCompile(`\{[^}]*\}`)

func normalize(method, path string) string {
	path = strings.TrimSuffix(path, "{$}")
	return strings.ToUpper(method) + " " + paramRe.ReplaceAllString(path, "{}")
}

// muxPatterns returns every pattern registered on mux. net/http exposes no
// enumeration, so this walks the ServeMux's routing tree by reflection and
// collects each *http.pattern's original string. If a Go release reshapes
// those internals the empty-result guard below fails loudly.
func muxPatterns(mux *http.ServeMux) []string {
	found := map[string]bool{}
	seen := map[uintptr]bool{}
	var walk func(v reflect.Value)
	walk = func(v reflect.Value) {
		switch v.Kind() {
		case reflect.Ptr:
			if v.IsNil() || seen[v.Pointer()] {
				return
			}
			seen[v.Pointer()] = true
			if v.Type().Elem().Name() == "pattern" {
				str := v.Elem().FieldByName("str")
				str = reflect.NewAt(str.Type(), unsafe.Pointer(str.UnsafeAddr())).Elem()
				found[str.String()] = true
				return
			}
			walk(v.Elem())
		case reflect.Struct:
			for i := 0; i < v.NumField(); i++ {
				f := v.Field(i)
				if !f.CanAddr() {
					continue
				}
				walk(reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem())
			}
		case reflect.Slice:
			for i := 0; i < v.Len(); i++ {
				walk(v.Index(i))
			}
		case reflect.Map:
			for _, k := range v.MapKeys() {
				val := reflect.New(v.Type().Elem()).Elem()
				val.Set(v.MapIndex(k))
				walk(val)
			}
		}
	}
	walk(reflect.ValueOf(mux))
	out := make([]string, 0, len(found))
	for p := range found {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
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

	registered := map[string]string{}
	anyMethod := map[string]bool{} // method-less patterns serve every method
	for _, p := range muxPatterns(mux) {
		method, path := "", p
		if m, rest, ok := strings.Cut(p, " "); ok {
			method, path = m, rest
		}
		if !strings.HasPrefix(path, "/api/") {
			continue
		}
		if method == "" {
			anyMethod[normalize("", path)[1:]] = true
			continue
		}
		registered[normalize(method, path)] = p
	}
	if len(registered) < 20 {
		t.Fatalf("only %d /api routes enumerated from the mux; muxPatterns likely broke after a Go upgrade", len(registered))
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
	methods := map[string]bool{"get": true, "post": true, "put": true, "patch": true, "delete": true}
	documented := map[string]bool{}
	for path, ops := range spec.Paths {
		if !strings.HasPrefix(path, "/api/") {
			continue
		}
		for m := range ops {
			if methods[m] {
				documented[normalize(m, path)] = true
			}
		}
	}

	pathOf := func(key string) string { return strings.SplitN(key, " ", 2)[1] }
	var undocumented, unregistered []string
	for key, pat := range registered {
		if _, ok := undocumentedAllowed[key]; !documented[key] && !ok {
			undocumented = append(undocumented, key+"  (registered as "+pat+")")
		}
	}
	for path := range anyMethod {
		hit := false
		for d := range documented {
			hit = hit || pathOf(d) == path
		}
		if _, ok := undocumentedAllowed["* "+path]; !hit && !ok {
			undocumented = append(undocumented, "* "+path)
		}
	}
	for key := range documented {
		_, ok := registered[key]
		if _, allowed := unregisteredAllowed[key]; !ok && !anyMethod[pathOf(key)] && !allowed {
			unregistered = append(unregistered, key)
		}
	}
	sort.Strings(undocumented)
	sort.Strings(unregistered)
	if len(undocumented) > 0 {
		t.Errorf("registered on the mux but missing from openapi.yaml:\n  %s", strings.Join(undocumented, "\n  "))
	}
	if len(unregistered) > 0 {
		t.Errorf("documented in openapi.yaml but not registered on the mux:\n  %s", strings.Join(unregistered, "\n  "))
	}
}
