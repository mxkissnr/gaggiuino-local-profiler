package proto

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// This file is the cross-validation step doc.go describes: every vector in
// testdata/node_vectors.json was produced by lib/gaggiuino-proto.js's real
// @protobuf-ts/runtime-backed encoder/decoder (testdata/gen_node_vectors.js)
// — the same code this app depends on in production. For each vector this
// test:
//
//  1. Decodes the recorded hex bytes with this package's own Unmarshal and
//     asserts the result matches Node's own recorded `decoded` value
//     field-for-field (via encoding/json, so the same custom enum
//     UnmarshalJSON logic go/internal/machines uses for request bodies is
//     exercised here too).
//  2. Re-encodes the decoded value with this package's own Marshal and
//     asserts the output is byte-identical to Node's recorded hex — this
//     is the strong check: it only passes if field ordering, wire types,
//     varint/fixed32 encoding, and default-value omission all match
//     lib/gaggiuino-proto.js's actual wire output exactly, not just this
//     package's own internal round-trip consistency.

type vector struct {
	Name    string          `json:"name"`
	Hex     string          `json:"hex"`
	Decoded json.RawMessage `json:"decoded"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "node_vectors.json"))
	if err != nil {
		t.Fatalf("reading testdata/node_vectors.json (run gen_node_vectors.js first): %v", err)
	}
	var vecs []vector
	if err := json.Unmarshal(data, &vecs); err != nil {
		t.Fatalf("parsing testdata/node_vectors.json: %v", err)
	}
	return vecs
}

func typeNameOf(vectorName string) string {
	if i := strings.IndexByte(vectorName, '/'); i >= 0 {
		return vectorName[:i]
	}
	return vectorName
}

// wireMessage is implemented by every generated message type in messages.go.
type wireMessage interface {
	Marshal() []byte
	Unmarshal([]byte) error
}

// messageFactories maps a node_vectors.json vector name's type prefix
// (e.g. "ProfileDto" out of "ProfileDto/full") to a constructor for the
// matching Go type. Every message type messages.go defines must be listed
// here, or TestNodeVectors fails loudly (see checkGeneric) rather than
// silently skipping coverage.
var messageFactories = map[string]func() wireMessage{
	"PhaseStopConditionsDto":       func() wireMessage { return &PhaseStopConditionsDto{} },
	"TransitionDto":                func() wireMessage { return &TransitionDto{} },
	"PhaseDto":                     func() wireMessage { return &PhaseDto{} },
	"GlobalStopConditionsDto":      func() wireMessage { return &GlobalStopConditionsDto{} },
	"BrewRecipeDto":                func() wireMessage { return &BrewRecipeDto{} },
	"ProfileDto":                   func() wireMessage { return &ProfileDto{} },
	"WebSocketProfileIdCommandDto": func() wireMessage { return &WebSocketProfileIdCommandDto{} },
	"WebSocketResponseDto":         func() wireMessage { return &WebSocketResponseDto{} },
	"SavedProfileDto":              func() wireMessage { return &SavedProfileDto{} },
	"SavedProfilesDto":             func() wireMessage { return &SavedProfilesDto{} },
	"NotificationDto":              func() wireMessage { return &NotificationDto{} },
	"UpdateSystemStateCommandDto":  func() wireMessage { return &UpdateSystemStateCommandDto{} },
	"ServiceTestCommandDto":        func() wireMessage { return &ServiceTestCommandDto{} },
	"SensorStateSnapshotDto":       func() wireMessage { return &SensorStateSnapshotDto{} },
	"SystemStateDto":               func() wireMessage { return &SystemStateDto{} },
}

func TestNodeVectors(t *testing.T) {
	vecs := loadVectors(t)
	if len(vecs) == 0 {
		t.Fatal("no vectors loaded — did you run gen_node_vectors.js?")
	}
	for _, v := range vecs {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			typeName := typeNameOf(v.Name)
			// WebSocketMessageDto's `data` bytes field needed a fixture-only
			// hex-string normalization (see gen_node_vectors.js's addVector) —
			// Go's own []byte JSON encoding is base64, so it gets its own
			// comparison instead of the generic reflect.DeepEqual path below.
			if typeName == "WebSocketMessageDto" {
				checkWebSocketMessageDto(t, v)
				return
			}
			checkGeneric(t, typeName, v)
		})
	}
}

func checkGeneric(t *testing.T, typeName string, v vector) {
	t.Helper()
	factory, ok := messageFactories[typeName]
	if !ok {
		t.Fatalf("no Go type registered in messageFactories for vector type %q", typeName)
	}

	raw, err := hex.DecodeString(v.Hex)
	if err != nil {
		t.Fatalf("decoding fixture hex: %v", err)
	}

	got := factory()
	if err := got.Unmarshal(raw); err != nil {
		t.Fatalf("Unmarshal(%s): %v", v.Hex, err)
	}

	want := factory()
	if err := json.Unmarshal(v.Decoded, want); err != nil {
		t.Fatalf("parsing fixture's decoded JSON into %T: %v", want, err)
	}

	if !reflect.DeepEqual(got, want) {
		gotJSON, _ := json.Marshal(got)
		wantJSON, _ := json.Marshal(want)
		t.Errorf("decoded value mismatch\n  got:  %s\n  want: %s", gotJSON, wantJSON)
	}

	reencoded := got.Marshal()
	if hex.EncodeToString(reencoded) != v.Hex {
		t.Errorf("re-Marshal produced different bytes than Node's own encoder\n  got:  %x\n  want: %s", reencoded, v.Hex)
	}
}

func checkWebSocketMessageDto(t *testing.T, v vector) {
	t.Helper()
	var want struct {
		Action string `json:"action"`
		Data   string `json:"data"` // hex string, see gen_node_vectors.js's normalization
	}
	if err := json.Unmarshal(v.Decoded, &want); err != nil {
		t.Fatalf("parsing fixture's decoded JSON: %v", err)
	}

	raw, err := hex.DecodeString(v.Hex)
	if err != nil {
		t.Fatalf("decoding fixture hex: %v", err)
	}
	var got WebSocketMessageDto
	if err := got.Unmarshal(raw); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.Action != want.Action {
		t.Errorf("Action = %q, want %q", got.Action, want.Action)
	}
	if hex.EncodeToString(got.Data) != want.Data {
		t.Errorf("Data = %x, want %s", got.Data, want.Data)
	}

	reencoded := got.Marshal()
	if hex.EncodeToString(reencoded) != v.Hex {
		t.Errorf("re-Marshal produced different bytes than Node's own encoder\n  got:  %x\n  want: %s", reencoded, v.Hex)
	}
}
