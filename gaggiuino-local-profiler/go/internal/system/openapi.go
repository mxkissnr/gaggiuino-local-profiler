package system

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"sync"

	"gopkg.in/yaml.v3"
)

// This file ports routes/system.js's GET /api/openapi.json (Phase 2a,
// #901): Node reads the repo-root openapi.yaml and serves it as JSON via
// js-yaml (getOpenApiSpec()'s `_openApiSpec` one-shot cache). The Go binary
// can't `go:embed` a file outside its own module, so openapi.yaml is
// committed as a copy here (go/internal/system/openapi.yaml) and
// openapi_test.go's TestOpenAPICopyInSync fails CI the moment it drifts
// from the source of truth at ../../../openapi.yaml.
//
// The YAML -> JSON conversion happens once, lazily, on the first request
// (mirroring Node's lazy `_openApiSpec` cache). Object key order is not
// preserved (Go maps are unordered, and JSON object key order carries no
// meaning) — every consumer of this endpoint is a spec renderer that keys
// by name, and Node's own js-yaml output order isn't a contract either.

//go:embed openapi.yaml
var openAPIYAML []byte

var (
	openAPIOnce sync.Once
	openAPIJSON []byte
	openAPIErr  error
)

func buildOpenAPIJSON() {
	var doc any
	if err := yaml.Unmarshal(openAPIYAML, &doc); err != nil {
		openAPIErr = err
		return
	}
	openAPIJSON, openAPIErr = json.Marshal(doc)
}

// getOpenAPI ports GET /api/openapi.json. On a conversion failure it
// mirrors routes/system.js's `catch (e) { res.status(500).json({ error:
// e.message }) }` — getOpenApiSpec()'s own inner `catch { return {} }`
// (a missing file) can't happen here since the file is embedded.
func (h *Handlers) getOpenAPI(w http.ResponseWriter, r *http.Request) {
	openAPIOnce.Do(buildOpenAPIJSON)
	if openAPIErr != nil {
		writeError(w, http.StatusInternalServerError, openAPIErr.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(openAPIJSON)
}
