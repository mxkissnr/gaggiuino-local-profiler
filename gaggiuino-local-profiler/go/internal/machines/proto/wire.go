package proto

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Wire types, per the Protocol Buffers wire format spec (schema.proto's
// scalar/message/enum fields only ever use these four — this schema has no
// packed-repeated scalar fields, no 64-bit scalar fields, and no groups).
const (
	wireVarint = 0
	wire64bit  = 1
	wireLen    = 2
	wire32bit  = 5
)

// ── encoder ──────────────────────────────────────────────────────────────

// writer accumulates an encoded message. Every field-append method is a
// no-op when the value is the type's zero value — proto3's documented
// wire behavior (also observed directly from lib/gaggiuino-proto.js's own
// toBinary() output, see node_vectors_test.go) omits default-valued
// scalar fields from the wire entirely; a decoder must still report the
// Go zero value for an omitted field, which happens for free since that's
// already every struct field's zero value.
type writer struct{ b []byte }

func (w *writer) tag(fieldNo, wireType int) {
	w.varint(uint64(fieldNo)<<3 | uint64(wireType))
}

func (w *writer) varint(v uint64) {
	for v >= 0x80 {
		w.b = append(w.b, byte(v&0x7f)|0x80)
		v >>= 7
	}
	w.b = append(w.b, byte(v))
}

func (w *writer) uint32Field(fieldNo int, v uint32) {
	if v == 0 {
		return
	}
	w.tag(fieldNo, wireVarint)
	w.varint(uint64(v))
}

func (w *writer) enumField(fieldNo int, v int32) {
	if v == 0 {
		return
	}
	w.tag(fieldNo, wireVarint)
	// Every enum in this schema only ever carries non-negative values
	// (see enums.go) — a plain varint of the int32 bit pattern is
	// therefore exactly what protobuf's default (non-zigzag) enum
	// encoding produces.
	w.varint(uint64(uint32(v)))
}

func (w *writer) boolField(fieldNo int, v bool) {
	if !v {
		return
	}
	w.tag(fieldNo, wireVarint)
	w.b = append(w.b, 1)
}

// floatField ports schema.proto's `float` fields. The Go struct fields
// this backs are float64 (not float32) — see messages.go's header comment
// — so the down-convert to the wire's actual 32-bit representation happens
// here, at the wire boundary, the same place lib/gaggiuino-proto.js's own
// protobuf-ts runtime does it.
func (w *writer) floatField(fieldNo int, v float64) {
	if v == 0 {
		return
	}
	w.tag(fieldNo, wire32bit)
	bits := math.Float32bits(float32(v))
	w.b = binary.LittleEndian.AppendUint32(w.b, bits)
}

func (w *writer) stringField(fieldNo int, v string) {
	if v == "" {
		return
	}
	w.tag(fieldNo, wireLen)
	w.varint(uint64(len(v)))
	w.b = append(w.b, v...)
}

func (w *writer) bytesField(fieldNo int, v []byte) {
	if len(v) == 0 {
		return
	}
	w.tag(fieldNo, wireLen)
	w.varint(uint64(len(v)))
	w.b = append(w.b, v...)
}

// rawMessageField writes an already-Marshal()ed submessage as a
// length-delimited field — used for both singular optional message fields
// (caller nil-checks the pointer first) and each element of a repeated
// message field.
func (w *writer) rawMessageField(fieldNo int, payload []byte) {
	w.tag(fieldNo, wireLen)
	w.varint(uint64(len(payload)))
	w.b = append(w.b, payload...)
}

// ── decoder ──────────────────────────────────────────────────────────────

// reader walks an encoded message's fields in wire order. Unknown field
// numbers are skipped (per proto3's forward-compatibility rule, and
// matching protobuf-ts's own lenient decode behavior) rather than treated
// as an error.
type reader struct {
	b []byte
	i int
}

func newReader(b []byte) *reader { return &reader{b: b} }

func (r *reader) len() int { return len(r.b) - r.i }

func (r *reader) varint() (uint64, error) {
	var v uint64
	var shift uint
	for {
		if r.i >= len(r.b) {
			return 0, fmt.Errorf("proto: truncated varint")
		}
		b := r.b[r.i]
		r.i++
		v |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			return v, nil
		}
		shift += 7
		if shift >= 64 {
			return 0, fmt.Errorf("proto: varint too long")
		}
	}
}

func (r *reader) tag() (fieldNo, wireType int, err error) {
	v, err := r.varint()
	if err != nil {
		return 0, 0, err
	}
	return int(v >> 3), int(v & 7), nil
}

func (r *reader) fixed32() (uint32, error) {
	if r.i+4 > len(r.b) {
		return 0, fmt.Errorf("proto: truncated fixed32")
	}
	v := binary.LittleEndian.Uint32(r.b[r.i : r.i+4])
	r.i += 4
	return v, nil
}

func (r *reader) fixed64() (uint64, error) {
	if r.i+8 > len(r.b) {
		return 0, fmt.Errorf("proto: truncated fixed64")
	}
	v := binary.LittleEndian.Uint64(r.b[r.i : r.i+8])
	r.i += 8
	return v, nil
}

// bytes reads a length-delimited field's payload (the length varint plus
// that many following bytes) and returns a slice sharing the underlying
// array — callers that retain it past this decode (e.g. WebSocketMessageDto's
// Data field) must copy it first; every caller in this package that stores
// the result already does.
func (r *reader) bytes() ([]byte, error) {
	n, err := r.varint()
	if err != nil {
		return nil, err
	}
	if n > uint64(r.len()) {
		return nil, fmt.Errorf("proto: length-delimited field longer than remaining input")
	}
	start := r.i
	r.i += int(n)
	return r.b[start:r.i], nil
}

func (r *reader) float() (float64, error) {
	bits, err := r.fixed32()
	if err != nil {
		return 0, err
	}
	return float64(math.Float32frombits(bits)), nil
}

// skip discards one field's value for a wire type this package's schema
// doesn't otherwise use in that position (an unrecognized field number).
func (r *reader) skip(wireType int) error {
	switch wireType {
	case wireVarint:
		_, err := r.varint()
		return err
	case wire64bit:
		_, err := r.fixed64()
		return err
	case wireLen:
		_, err := r.bytes()
		return err
	case wire32bit:
		_, err := r.fixed32()
		return err
	default:
		return fmt.Errorf("proto: unsupported wire type %d", wireType)
	}
}
