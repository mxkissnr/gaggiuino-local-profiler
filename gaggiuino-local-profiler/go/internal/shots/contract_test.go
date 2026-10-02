package shots

import (
	"encoding/json"
	"net/http"
	"testing"
)

// This file pins the package's HTTP responses against openapi.yaml's component
// schemas for the shapes the endpoints actually return: Ok (`{ok: boolean}`,
// required [ok]), Error (`{error: string}`, required [error]) and Shot
// (id/timestamp/duration/profileName/annotation, among other fields). This is
// a structural check — required keys present with the right JSON type — not a
// generated-schema validator, the same "pin the essential shape, not the whole
// grammar" approach internal/db's db_schema_test.go applies to the DB schema
// instead of HTTP payloads (see that file's doc comment).

func requireBoolField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(bool); !ok {
		t.Errorf("expected %q to be a boolean, got %T (%v)", key, v, v)
	}
}

func requireStringField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string, got %T (%v)", key, v, v)
	}
}

func requireNumberField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number, got %T (%v)", key, v, v)
	}
}

// requireNullableNumberField accepts a JSON number or null — the shape of a
// `nullable: true` numeric field the spec still marks required.
func requireNullableNumberField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(float64); !ok {
		t.Errorf("expected %q to be a number or null, got %T (%v)", key, v, v)
	}
}

func requireNullableStringField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if v == nil {
		return
	}
	if _, ok := v.(string); !ok {
		t.Errorf("expected %q to be a string or null, got %T (%v)", key, v, v)
	}
}

func requireObjectField(t *testing.T, body map[string]any, key string) {
	t.Helper()
	v, ok := body[key]
	if !ok {
		t.Errorf("expected required field %q, got %+v", key, body)
		return
	}
	if _, ok := v.(map[string]any); !ok {
		t.Errorf("expected %q to be an object, got %T (%v)", key, v, v)
	}
}

// TestContract_OkShape pins openapi.yaml's Ok schema (required: [ok],
// ok: boolean) against every endpoint documented as returning it:
// annotate/trash/restore/delete (200) and image DELETE (200, {ok, shot}).
func TestContract_OkShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)

	t.Run("annotate", func(t *testing.T) {
		insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/1/annotate", []byte(`{}`))
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("trash", func(t *testing.T) {
		insertShot(t, sqlDB, 2, 2000, &dur, "V60", nil, nil)
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/2/trash", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("restore", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/2/restore", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("delete", func(t *testing.T) {
		insertShot(t, sqlDB, 3, 3000, &dur, "V60", nil, nil)
		rec := doJSON(t, mux, http.MethodPost, "/api/shots/3/delete", nil)
		requireBoolField(t, decodeBody(t, rec.Body.Bytes()), "ok")
	})
	t.Run("image delete", func(t *testing.T) {
		insertShot(t, sqlDB, 4, 4000, &dur, "V60", nil, nil)
		rec := doJSON(t, mux, http.MethodDelete, "/api/shots/4/image", nil)
		body := decodeBody(t, rec.Body.Bytes())
		requireBoolField(t, body, "ok")
		if _, ok := body["shot"]; !ok {
			t.Error("expected image DELETE's Ok-shaped response to also carry 'shot'")
		}
	})
}

// TestContract_ErrorShape pins openapi.yaml's Error schema (required:
// [error], error: string) against every documented 400/404 branch.
func TestContract_ErrorShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	cases := []struct {
		name   string
		method string
		path   string
		body   []byte
		status int
	}{
		{"annotate invalid id", http.MethodPost, "/api/shots/notanumber/annotate", []byte(`{}`), http.StatusBadRequest},
		{"trash invalid id", http.MethodPost, "/api/shots/notanumber/trash", nil, http.StatusBadRequest},
		{"trash not found", http.MethodPost, "/api/shots/999999/trash", nil, http.StatusNotFound},
		{"delete not found", http.MethodPost, "/api/shots/999999/delete", nil, http.StatusNotFound},
		{"card not found", http.MethodGet, "/api/shots/999999/card", nil, http.StatusNotFound},
		{"image post invalid id", http.MethodPost, "/api/shots/notanumber/image", nil, http.StatusBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := doJSON(t, mux, c.method, c.path, c.body)
			if rec.Code != c.status {
				t.Fatalf("status = %d, want %d; body=%s", rec.Code, c.status, rec.Body.String())
			}
			requireStringField(t, decodeBody(t, rec.Body.Bytes()), "error")
		})
	}
}

// TestContract_ShotShape pins openapi.yaml's Shot schema's required keys on
// GET /shots.json's entries — the full dump, unlike the metadata-only
// GET /api/shots list, so it also carries datapoints.
func TestContract_ShotShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	rec := doJSON(t, mux, http.MethodGet, "/shots.json", nil)
	var list []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatalf("decoding /shots.json: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 shot, got %d", len(list))
	}
	requireShotRequiredKeys(t, list[0])
}

// requireShotRequiredKeys pins every key openapi.yaml's Shot schema now
// marks `required`, with its JSON type; nullable fields accept null.
func requireShotRequiredKeys(t *testing.T, shot map[string]any) {
	t.Helper()
	requireNumberField(t, shot, "id")
	requireNumberField(t, shot, "timestamp")
	requireNullableNumberField(t, shot, "duration")
	requireNullableStringField(t, shot, "profileName")
	requireNullableStringField(t, shot, "profile_name")
	requireNullableNumberField(t, shot, "machineId")
	requireNumberField(t, shot, "nativeId")
	requireObjectField(t, shot, "annotation")
}

// requireHydratedShotRequiredKeys pins openapi.yaml's HydratedShot required
// set: Shot's required keys plus score/usedBeanTarget.
func requireHydratedShotRequiredKeys(t *testing.T, shot map[string]any) {
	t.Helper()
	requireShotRequiredKeys(t, shot)
	requireNullableNumberField(t, shot, "score")
	requireBoolField(t, shot, "usedBeanTarget")
}

// TestContract_HydratedShotShape pins openapi.yaml's HydratedShot schema on
// the two endpoints it backs: the GET /api/shots metadata list (no
// datapoints) and the GET /api/shots/{id} detail (full shot + previous
// same-profile shot).
func TestContract_HydratedShotShape(t *testing.T) {
	h, _, sqlDB := newTestHandlers(t)
	mux := newMux(h)
	dur := int64(300)
	insertShot(t, sqlDB, 1, 1000, &dur, "V60", nil, nil)

	t.Run("list", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots", nil)
		body := decodeBody(t, rec.Body.Bytes())
		shots, ok := body["shots"].([]any)
		if !ok || len(shots) == 0 {
			t.Fatalf("expected a non-empty shots array, got %+v", body["shots"])
		}
		shot, ok := shots[0].(map[string]any)
		if !ok {
			t.Fatalf("expected shots[0] to be an object, got %T", shots[0])
		}
		requireHydratedShotRequiredKeys(t, shot)
		if _, ok := shot["datapoints"]; ok {
			t.Error("GET /api/shots rows are metadata-only and must not carry datapoints")
		}
	})

	t.Run("detail", func(t *testing.T) {
		rec := doJSON(t, mux, http.MethodGet, "/api/shots/1", nil)
		requireHydratedShotRequiredKeys(t, decodeBody(t, rec.Body.Bytes()))
	})
}
