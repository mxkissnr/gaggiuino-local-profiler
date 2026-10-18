package library

import (
	"bytes"
	"io"
	"net"
	"net/http"
	"testing"
)

// roundTripFunc adapts a function to http.RoundTripper so a test can hand
// fetchBeanImage a canned response without a real network round trip.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// withFakeImageClient swaps the package-level fetchImageClient for one that
// answers every request with (contentType, body), restoring the original on
// cleanup.
func withFakeImageClient(t *testing.T, contentType string, body []byte) {
	t.Helper()
	orig := fetchImageClient
	fetchImageClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{contentType}},
			Body:       io.NopCloser(bytes.NewReader(body)),
		}, nil
	})}
	t.Cleanup(func() { fetchImageClient = orig })
}

// TestSetBeanImage_FiresHookAfterStore guards #1580: the image download runs
// after the create HTTP response, so SetBeanImage must fire BeanImageHook
// exactly once, with the bean id, once the new extension is stored.
func TestSetBeanImage_FiresHookAfterStore(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	withFakeLookup(t, map[string][]net.IP{"kaffeebraun.com": {net.ParseIP("93.184.216.34")}})
	withFakeImageClient(t, "image/jpeg", makeJPEG(t, 16, 16))

	id := newID()
	if err := repo.Update(func(l *Library) error {
		l.Beans = append(l.Beans, Entity{"id": id, "name": "Test Bean"})
		return nil
	}); err != nil {
		t.Fatalf("seeding bean: %v", err)
	}

	var calls []int64
	orig := BeanImageHook
	BeanImageHook = func(beanID int64) { calls = append(calls, beanID) }
	t.Cleanup(func() { BeanImageHook = orig })

	SetBeanImage(repo, t.TempDir(), id, "https://kaffeebraun.com/bean.jpg")

	if len(calls) != 1 || calls[0] != id {
		t.Fatalf("BeanImageHook calls = %v, want exactly [%d]", calls, id)
	}
	fresh, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}
	if ext, _ := fresh.Beans[0]["image"].(string); ext == "" {
		t.Fatalf("bean image extension not stored: %#v", fresh.Beans[0]["image"])
	}
}

// TestSetBeanImage_NoHookOnDownloadFailure covers the other half of #1580: a
// download that never produced an image must not announce one.
func TestSetBeanImage_NoHookOnDownloadFailure(t *testing.T) {
	_, repo, _ := newTestHandlers(t)

	calls := 0
	orig := BeanImageHook
	BeanImageHook = func(int64) { calls++ }
	t.Cleanup(func() { BeanImageHook = orig })

	// A non-allowlisted host makes fetchBeanImage return "" without any
	// network round trip.
	SetBeanImage(repo, t.TempDir(), 1, "https://evil.example/x.jpg")

	if calls != 0 {
		t.Fatalf("BeanImageHook fired %d times on a failed download, want 0", calls)
	}
}

// TestSetBeanImage_NoHookWhenBeanDeleted covers #1580's race: the download
// finished but the bean was deleted meanwhile, so nothing was stored.
func TestSetBeanImage_NoHookWhenBeanDeleted(t *testing.T) {
	_, repo, _ := newTestHandlers(t)
	withFakeLookup(t, map[string][]net.IP{"kaffeebraun.com": {net.ParseIP("93.184.216.34")}})
	withFakeImageClient(t, "image/jpeg", makeJPEG(t, 16, 16))

	calls := 0
	orig := BeanImageHook
	BeanImageHook = func(int64) { calls++ }
	t.Cleanup(func() { BeanImageHook = orig })

	// The library is empty, so repo.Update returns ErrSkipSave.
	SetBeanImage(repo, t.TempDir(), 424242, "https://kaffeebraun.com/bean.jpg")

	if calls != 0 {
		t.Fatalf("BeanImageHook fired %d times for a deleted bean, want 0", calls)
	}
}

// TestLowerOrEmpty_UnicodeCaseFolding guards #901's fix: a plain A-Z byte
// fold left accented grinder names (Éureka, Mühle) comparing unequal to
// their own lowercase form. strings.ToLower is Unicode-case-folding-aware,
// matching JS's String.prototype.toLowerCase() for these inputs.
func TestLowerOrEmpty_UnicodeCaseFolding(t *testing.T) {
	cases := []struct{ a, b string }{
		{"Éureka", "éureka"},
		{"MÜHLE", "mühle"},
		{"Über Grinder", "über grinder"},
	}
	for _, c := range cases {
		la, lb := lowerOrEmpty(c.a), lowerOrEmpty(c.b)
		if la != lb {
			t.Errorf("lowerOrEmpty(%q)=%q != lowerOrEmpty(%q)=%q", c.a, la, c.b, lb)
		}
	}
}

// TestUpsertKnownGrindSetting_UnicodeGrinderNameDedups exercises
// lowerOrEmpty's real caller: two grinder names differing only by accent
// case must be treated as the same grinder and dedup to a single entry,
// with the newest write winning.
func TestUpsertKnownGrindSetting_UnicodeGrinderNameDedups(t *testing.T) {
	lib := &Library{Beans: []Entity{{"id": int64(1), "name": "Test Bean"}}}

	if _, ok := UpsertKnownGrindSetting(lib, 1, "Éureka Mignon", "12"); !ok {
		t.Fatalf("expected bean id 1 to match")
	}
	bean, ok := UpsertKnownGrindSetting(lib, 1, "éureka mignon", "14")
	if !ok {
		t.Fatalf("expected bean id 1 to match")
	}
	settings, _ := bean["knownGrindSettings"].([]any)
	if len(settings) != 1 {
		t.Fatalf("expected accent-case-insensitive dedup to leave 1 entry, got %d: %+v", len(settings), settings)
	}
	entry, _ := settings[0].(Entity)
	if entry["grindSetting"] != "14" {
		t.Fatalf("expected newest grind setting to win, got %+v", entry)
	}
}
