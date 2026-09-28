package library

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// doRequestJSON runs method/path/body through mux and returns the recorder.
// Unlike doJSON it never touches testing.T, so the goroutines in the test
// below can call it safely (testing.T.Fatalf must run on the test goroutine).
func doRequestJSON(mux *http.ServeMux, method, path string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// TestUpdate_ConcurrentHandlersLoseNothing is the handler-level #1199
// regression test: 20 concurrent POST .../new-bag calls on bean A race 20
// concurrent POST .../restock calls on milk B. Both handlers used to do an
// unguarded GetLibrary -> mutate -> SaveLibrary per request, so writers that
// read the same blob raced and dropped each other's change; now that both go
// through Repository.Update they serialise on the shared write lock and
// every write lands.
func TestUpdate_ConcurrentHandlersLoseNothing(t *testing.T) {
	h, repo, _ := newTestHandlers(t)
	mux := newMux(h)

	// Bean A starts bagless; each new-bag call appends exactly one bag.
	beanID, _ := createTestBean(t, mux, nil)

	rec := doJSON(t, mux, http.MethodPost, "/api/library/milk", mustMarshal(t, map[string]any{"name": "Whole Milk", "stockMl": 100}))
	if rec.Code != http.StatusOK {
		t.Fatalf("create milk: status = %d; body=%s", rec.Code, rec.Body.String())
	}
	milkID := int64(decodeBody(t, rec.Body.Bytes())["id"].(float64))

	newBagBody := mustMarshal(t, map[string]any{"stock_g": 250})
	restockBody := mustMarshal(t, map[string]any{"ml": 10})

	const perKind = 20
	var wg sync.WaitGroup
	errs := make(chan error, 2*perKind)
	for i := 0; i < perKind; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := doRequestJSON(mux, http.MethodPost, "/api/library/bean/"+itoa(beanID)+"/new-bag", newBagBody)
			if r.Code != http.StatusOK {
				errs <- fmt.Errorf("new-bag status = %d; body=%s", r.Code, r.Body.String())
			}
		}()
	}
	for i := 0; i < perKind; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := doRequestJSON(mux, http.MethodPost, "/api/library/milk/"+itoa(milkID)+"/restock", restockBody)
			if r.Code != http.StatusOK {
				errs <- fmt.Errorf("restock status = %d; body=%s", r.Code, r.Body.String())
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent handler: %v", err)
	}

	lib, err := repo.GetLibrary()
	if err != nil {
		t.Fatalf("GetLibrary: %v", err)
	}

	beanBags := -1
	for _, b := range lib.Beans {
		if id, ok := idOf(b, "id"); ok && id == beanID {
			beanBags = len(bagsOf(b))
		}
	}
	if beanBags != perKind {
		t.Errorf("bean A bags = %d, want %d (lost new-bag appends)", beanBags, perKind)
	}

	milkStock := float64(-1)
	for _, m := range lib.Milks {
		if id, ok := idOf(m, "id"); ok && id == milkID {
			milkStock, _ = jsParseFloat(m["stockMl"])
		}
	}
	if want := float64(100 + perKind*10); milkStock != want {
		t.Errorf("milk B stockMl = %v, want %v (lost restocks)", milkStock, want)
	}
}
