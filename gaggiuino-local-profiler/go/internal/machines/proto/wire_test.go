package proto

import "testing"

func TestWriterVarint(t *testing.T) {
	cases := []struct {
		v    uint64
		want []byte
	}{
		{0, []byte{0x00}},
		{1, []byte{0x01}},
		{127, []byte{0x7f}},
		{128, []byte{0x80, 0x01}},
		{300, []byte{0xac, 0x02}},
		{5000, []byte{0x88, 0x27}}, // matches lib/gaggiuino-proto.js's own time:5000 encoding, see node_vectors_test.go
	}
	for _, c := range cases {
		w := &writer{}
		w.varint(c.v)
		if string(w.b) != string(c.want) {
			t.Errorf("varint(%d) = % x, want % x", c.v, w.b, c.want)
		}
	}
}

func TestReaderVarintRoundTrip(t *testing.T) {
	for _, v := range []uint64{0, 1, 127, 128, 300, 5000, 1 << 32, 1<<63 - 1} {
		w := &writer{}
		w.varint(v)
		r := newReader(w.b)
		got, err := r.varint()
		if err != nil {
			t.Fatalf("varint(%d): unexpected error: %v", v, err)
		}
		if got != v {
			t.Errorf("varint round-trip: got %d, want %d", got, v)
		}
		if r.len() != 0 {
			t.Errorf("varint(%d): %d bytes left unread", v, r.len())
		}
	}
}

func TestReaderVarintTruncated(t *testing.T) {
	r := newReader([]byte{0x80, 0x80}) // continuation bit set on every byte, then EOF
	if _, err := r.varint(); err == nil {
		t.Error("expected an error decoding a truncated varint, got nil")
	}
}

func TestTagRoundTrip(t *testing.T) {
	w := &writer{}
	w.tag(6, wireLen)
	r := newReader(w.b)
	field, wt, err := r.tag()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if field != 6 || wt != wireLen {
		t.Errorf("tag() = (%d, %d), want (6, %d)", field, wt, wireLen)
	}
}

func TestFloatFieldZeroOmitted(t *testing.T) {
	w := &writer{}
	w.floatField(1, 0)
	if len(w.b) != 0 {
		t.Errorf("floatField(1, 0) wrote %d bytes, want 0 (proto3 default omission)", len(w.b))
	}
}

func TestFloatRoundTrip(t *testing.T) {
	w := &writer{}
	w.floatField(1, 93.7)
	r := newReader(w.b)
	if _, _, err := r.tag(); err != nil {
		t.Fatalf("tag: %v", err)
	}
	got, err := r.float()
	if err != nil {
		t.Fatalf("float: %v", err)
	}
	// float32(93.7) up-converted to float64 is NOT exactly 93.7 — this is
	// the same imprecision node_vectors_test.go asserts this package
	// reproduces, not a bug (see messages.go's header comment).
	want := 93.69999694824219
	if got != want {
		t.Errorf("float round-trip = %v, want %v", got, want)
	}
}

func TestBytesFieldLengthOverrun(t *testing.T) {
	r := newReader([]byte{0x05, 0x01, 0x02}) // claims length 5, only 2 bytes follow
	if _, err := r.bytes(); err == nil {
		t.Error("expected an error reading a length-delimited field longer than the remaining input, got nil")
	}
}

func TestSkipUnknownField(t *testing.T) {
	// tag(field=99, varint) + value, followed by a real field(1) — skip
	// must consume exactly the unknown field's bytes and leave the reader
	// positioned at the next tag.
	w := &writer{}
	w.tag(99, wireVarint)
	w.varint(12345)
	w.uint32Field(1, 7)

	r := newReader(w.b)
	field, wt, err := r.tag()
	if err != nil {
		t.Fatalf("tag: %v", err)
	}
	if field != 99 {
		t.Fatalf("field = %d, want 99", field)
	}
	if err := r.skip(wt); err != nil {
		t.Fatalf("skip: %v", err)
	}
	field, _, err = r.tag()
	if err != nil {
		t.Fatalf("tag after skip: %v", err)
	}
	if field != 1 {
		t.Errorf("field after skip = %d, want 1", field)
	}
}
