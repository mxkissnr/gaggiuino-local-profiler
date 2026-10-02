package system

import (
	_ "embed"
	"encoding/json"
	"net/http"
	"sync"

	"gopkg.in/yaml.v3"
)

// GET /api/openapi.json serves the API spec. openapi.yaml in this package
// is the canonical spec, embedded via go:embed and served as JSON.
//
// The YAML -> JSON conversion happens once, lazily, on the first request.
// Object key order is not preserved (Go maps are unordered, and JSON
// object key order carries no meaning) — every consumer of this endpoint
// is a spec renderer that keys by name.

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

// getOpenAPI serves GET /api/openapi.json. On a conversion failure it
// responds 500 with the error message. The "missing spec file" case can't
// happen here because the spec is embedded at compile time.
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
