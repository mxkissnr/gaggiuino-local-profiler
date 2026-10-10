package machines

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// This file covers the #1539 slice 5 cache-first profile list: after a machine
// has been read live once, GET /api/machine/profiles answers from the local
// cache at once and refreshes in the background, publishing the "profiles"
// kind only when something a client renders actually changed.
//
// The fixture is a scripted adapter (per-machine status/list, an optional
// block-until-released mode, and a channel signalling every ListProfiles call)
// so a test can tell a synchronous live read from the background refresh and
// wait for either deterministically. The writes the cache-first path never
// reaches are fakeBlockingAdapter's not-implemented panics.

type scriptedProfilesAdapter struct {
	fakeBlockingAdapter

	mu        sync.Mutex
	status    map[int64]Status
	list      map[int64][]ProfileSummary
	statusErr error
	listErr   error
	selectErr error
	block     bool
	// gate is closed by releaseBlocking to let a blocked live call proceed;
	// nil while not blocking.
	gate chan struct{}

	// listCalls receives the machine id on every ListProfiles call, so a test
	// can wait for the background refresh to reach the live read.
	listCalls chan int64
}

func newScriptedProfilesAdapter() *scriptedProfilesAdapter {
	return &scriptedProfilesAdapter{
		status:    map[int64]Status{},
		list:      map[int64][]ProfileSummary{},
		listCalls: make(chan int64, 64),
	}
}

func (a *scriptedProfilesAdapter) Capabilities() Capabilities {
	return Capabilities{ProfileEdit: true, SettingsProxy: true}
}

func (a *scriptedProfilesAdapter) setStatus(id int64, s Status) {
	a.mu.Lock()
	a.status[id] = s
	a.mu.Unlock()
}

func (a *scriptedProfilesAdapter) setList(id int64, list []ProfileSummary) {
	a.mu.Lock()
	a.list[id] = list
	a.mu.Unlock()
}

func (a *scriptedProfilesAdapter) setListErr(err error) {
	a.mu.Lock()
	a.listErr = err
	a.mu.Unlock()
}

func (a *scriptedProfilesAdapter) setSelectErr(err error) {
	a.mu.Lock()
	a.selectErr = err
	a.mu.Unlock()
}

// armBlocking makes the next live call block until releaseBlocking (or ctx is
// done), simulating a machine that stops answering on its own.
func (a *scriptedProfilesAdapter) armBlocking() {
	a.mu.Lock()
	a.block = true
	a.gate = make(chan struct{})
	a.mu.Unlock()
}

func (a *scriptedProfilesAdapter) releaseBlocking() {
	a.mu.Lock()
	gate := a.gate
	a.block = false
	a.mu.Unlock()
	if gate != nil {
		close(gate)
	}
}

func (a *scriptedProfilesAdapter) waitLive(ctx context.Context) error {
	a.mu.Lock()
	block, gate := a.block, a.gate
	a.mu.Unlock()
	if !block {
		return nil
	}
	if gate == nil {
		<-ctx.Done()
		return ctx.Err()
	}
	select {
	case <-gate:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *scriptedProfilesAdapter) GetStatus(ctx context.Context, m *Machine) (Status, error) {
	if err := a.waitLive(ctx); err != nil {
		return Status{}, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.statusErr != nil {
		return Status{}, a.statusErr
	}
	return a.status[m.ID], nil
}

func (a *scriptedProfilesAdapter) ListProfiles(ctx context.Context, m *Machine) ([]ProfileSummary, error) {
	if err := a.waitLive(ctx); err != nil {
		return nil, err
	}
	select {
	case a.listCalls <- m.ID:
	default:
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.listErr != nil {
		return nil, a.listErr
	}
	return a.list[m.ID], nil
}

func (a *scriptedProfilesAdapter) SelectProfile(context.Context, *Machine, string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.selectErr
}

func intPtr(n int) *int { return &n }

// newCacheFirstFixture builds a Handlers with a scripted gaggimate adapter and
// one machine, returning the mux and machine id too.
func newCacheFirstFixture(t *testing.T) (*Handlers, *scriptedProfilesAdapter, *http.ServeMux, int64) {
	t.Helper()
	registry, sqlDB := newTestRegistry(t)
	adapter := newScriptedProfilesAdapter()
	h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: NewProfilesRepository(sqlDB)}
	machine, err := registry.CreateMachine(MachineInput{
		Name: strPtr("Scripted GaggiMate"), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1"),
	})
	if err != nil {
		t.Fatalf("CreateMachine: %v", err)
	}
	return h, adapter, newMux(h), machine.ID
}

func profilesListReq(machineID int64) *http.Request {
	return httptest.NewRequest(http.MethodGet, "/api/machine/profiles?machineId="+strconv.FormatInt(machineID, 10), nil)
}

// drainListCalls empties the adapter's call channel so a later wait sees only
// the calls a test is interested in.
func drainListCalls(a *scriptedProfilesAdapter) {
	for {
		select {
		case <-a.listCalls:
		default:
			return
		}
	}
}

// waitRefreshIdle waits until the machine's background refresh goroutine has
// finished (cleared its in-flight marker), so the test never races it.
func waitRefreshIdle(t *testing.T, h *Handlers, machineID int64) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		h.profilesMu.Lock()
		busy := h.profilesRefreshing[machineID]
		h.profilesMu.Unlock()
		if !busy {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("background profiles refresh for machine %d did not finish", machineID)
}

// TestListMachineProfiles_FirstGetLiveThenCacheFirstAnswersBeforeBlockingAdapter
// is the core of the slice: the first GET has nothing cached and goes live,
// while a second GET answers from the cache (stale: false, remembered current)
// without waiting for an adapter that has stopped answering.
func TestListMachineProfiles_FirstGetLiveThenCacheFirstAnswersBeforeBlockingAdapter(t *testing.T) {
	h, adapter, mux, machineID := newCacheFirstFixture(t)
	adapter.setStatus(machineID, Status{ProfileID: intPtr(1), ProfileName: strPtr("Espresso")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}})

	rec := doRequest(mux, profilesListReq(machineID))
	if rec.Code != http.StatusOK {
		t.Fatalf("first list status = %d, body = %s", rec.Code, rec.Body)
	}
	first := decodeBody(t, rec.Body.Bytes())
	if first["stale"] != false {
		t.Errorf("first GET stale = %v, want false (live)", first["stale"])
	}
	if first["current"] != "Espresso" || first["currentId"] != float64(1) {
		t.Errorf("first GET current = %v/%v, want Espresso/1", first["current"], first["currentId"])
	}

	drainListCalls(adapter)
	adapter.armBlocking()
	start := time.Now()
	rec = doRequest(mux, profilesListReq(machineID))
	elapsed := time.Since(start)
	adapter.releaseBlocking()
	waitRefreshIdle(t, h, machineID)

	// A live read against the blocked adapter would have paid
	// profileLiveFetchTimeout; the cache-first answer must return well under it.
	if elapsed > profileLiveFetchTimeout/2 {
		t.Fatalf("second GET took %v; want a cache-first answer well under %v", elapsed, profileLiveFetchTimeout)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("second list status = %d, body = %s", rec.Code, rec.Body)
	}
	second := decodeBody(t, rec.Body.Bytes())
	if second["stale"] != false {
		t.Errorf("second GET stale = %v, want false (cache-first)", second["stale"])
	}
	if second["current"] != "Espresso" || second["currentId"] != float64(1) {
		t.Errorf("second GET current = %v/%v, want the remembered Espresso/1", second["current"], second["currentId"])
	}
	optionsRaw, _ := second["optionsRaw"].([]any)
	if len(optionsRaw) != 1 {
		t.Fatalf("second GET optionsRaw = %+v, want the one cached profile", optionsRaw)
	}
}

// TestListMachineProfiles_CacheFirstNotifiesOnceOnRemoteChange pins that a
// changed machine-side list produces exactly one notify for that machine, while
// the cache-first response itself still shows the pre-change rows.
func TestListMachineProfiles_CacheFirstNotifiesOnceOnRemoteChange(t *testing.T) {
	h, adapter, mux, machineID := newCacheFirstFixture(t)
	notifies := make(chan int64, 8)
	h.SetOnProfilesChanged(func(id int64) { notifies <- id })
	adapter.setStatus(machineID, Status{ProfileID: intPtr(1), ProfileName: strPtr("Espresso")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}})

	doRequest(mux, profilesListReq(machineID)) // first GET: live, remembers current

	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}, {ID: "2", Name: "Lungo"}})

	rec := doRequest(mux, profilesListReq(machineID))
	body := decodeBody(t, rec.Body.Bytes())
	if optionsRaw, _ := body["optionsRaw"].([]any); len(optionsRaw) != 1 {
		t.Fatalf("cache-first response optionsRaw = %+v, want the pre-change single row", optionsRaw)
	}

	waitRefreshIdle(t, h, machineID)

	select {
	case id := <-notifies:
		if id != machineID {
			t.Fatalf("notify machine = %d, want %d", id, machineID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a profiles-changed notify for the changed list")
	}
	select {
	case extra := <-notifies:
		t.Fatalf("expected exactly one notify, got extra for machine %d", extra)
	case <-time.After(50 * time.Millisecond):
	}
}

// TestListMachineProfiles_CacheFirstNoNotifyWhenUnchanged is the converse: a
// refresh that sees the same list must not notify.
func TestListMachineProfiles_CacheFirstNoNotifyWhenUnchanged(t *testing.T) {
	h, adapter, mux, machineID := newCacheFirstFixture(t)
	notifies := make(chan int64, 8)
	h.SetOnProfilesChanged(func(id int64) { notifies <- id })
	adapter.setStatus(machineID, Status{ProfileID: intPtr(1), ProfileName: strPtr("Espresso")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}})

	doRequest(mux, profilesListReq(machineID)) // first GET: live
	drainListCalls(adapter)

	doRequest(mux, profilesListReq(machineID)) // cache-first, background refresh
	waitRefreshIdle(t, h, machineID)

	// The background refresh did run (it reached the live list read)...
	select {
	case <-adapter.listCalls:
	default:
		t.Fatal("cache-first GET did not trigger a background refresh")
	}
	// ...and, seeing the same list, did not notify.
	select {
	case id := <-notifies:
		t.Fatalf("unexpected notify for machine %d on an unchanged list", id)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestListMachineProfiles_TwoMachinesIndependent pins the per-machine keying:
// a change on one machine notifies for it only, while a second machine with its
// own remembered current is untouched.
func TestListMachineProfiles_TwoMachinesIndependent(t *testing.T) {
	registry, sqlDB := newTestRegistry(t)
	adapter := newScriptedProfilesAdapter()
	h := &Handlers{registry: registry, gaggimate: adapter, profilesRepo: NewProfilesRepository(sqlDB)}
	mux := newMux(h)

	mk := func(name string) int64 {
		m, err := registry.CreateMachine(MachineInput{Name: strPtr(name), Type: strPtr("gaggimate"), Host: strPtr("http://192.0.2.1")})
		if err != nil {
			t.Fatalf("CreateMachine(%s): %v", name, err)
		}
		return m.ID
	}
	a, b := mk("A"), mk("B")
	adapter.setStatus(a, Status{ProfileID: intPtr(1), ProfileName: strPtr("A1")})
	adapter.setList(a, []ProfileSummary{{ID: "1", Name: "A1"}})
	adapter.setStatus(b, Status{ProfileID: intPtr(2), ProfileName: strPtr("B1")})
	adapter.setList(b, []ProfileSummary{{ID: "2", Name: "B1"}})

	notifies := make(chan int64, 8)
	h.SetOnProfilesChanged(func(id int64) { notifies <- id })

	doRequest(mux, profilesListReq(a)) // live
	doRequest(mux, profilesListReq(b)) // live

	// Only A's remote list changes.
	adapter.setList(a, []ProfileSummary{{ID: "1", Name: "A1"}, {ID: "3", Name: "A2"}})
	doRequest(mux, profilesListReq(a)) // cache-first + refresh
	waitRefreshIdle(t, h, a)

	select {
	case id := <-notifies:
		if id != a {
			t.Fatalf("notify machine = %d, want only A (%d)", id, a)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("expected a notify for machine A")
	}

	// B is unchanged: its cache-first GET answers with B's own remembered rows
	// and its refresh must not notify.
	rec := doRequest(mux, profilesListReq(b))
	body := decodeBody(t, rec.Body.Bytes())
	if body["current"] != "B1" || body["currentId"] != float64(2) {
		t.Errorf("machine B current = %v/%v, want its own B1/2", body["current"], body["currentId"])
	}
	waitRefreshIdle(t, h, b)
	select {
	case id := <-notifies:
		t.Fatalf("unexpected notify for machine %d on B's unchanged list", id)
	case <-time.After(150 * time.Millisecond):
	}
}

// TestListMachineProfiles_RefreshListFailureForgetsCurrent pins that a failed
// background list read drops the remembered current (and notifies), so the next
// GET goes live again rather than serving a stale cache-first answer forever.
func TestListMachineProfiles_RefreshListFailureForgetsCurrent(t *testing.T) {
	h, adapter, mux, machineID := newCacheFirstFixture(t)
	notifies := make(chan int64, 8)
	h.SetOnProfilesChanged(func(id int64) { notifies <- id })
	adapter.setStatus(machineID, Status{ProfileID: intPtr(1), ProfileName: strPtr("Espresso")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}})

	doRequest(mux, profilesListReq(machineID)) // first GET: live, remembers current

	adapter.setListErr(errors.New("machine unreachable"))
	doRequest(mux, profilesListReq(machineID)) // cache-first; refresh fails
	waitRefreshIdle(t, h, machineID)

	if _, ok := h.rememberedProfilesCurrent(machineID); ok {
		t.Fatal("remembered current still present after a failed refresh; want it forgotten")
	}
	select {
	case <-notifies:
	case <-time.After(2 * time.Second):
		t.Fatal("expected a notify after the failed refresh")
	}

	// With nothing remembered the next GET must go live: the still-failing
	// adapter makes that visible as a stale cache fallback, not a cache-first
	// stale:false answer.
	rec := doRequest(mux, profilesListReq(machineID))
	body := decodeBody(t, rec.Body.Bytes())
	if body["stale"] != true {
		t.Errorf("GET after a forgotten current stale = %v, want true (live path fell back)", body["stale"])
	}
}

// TestSetMachineProfile_ForgetsCurrentSoNextGetGoesLive pins that selecting a
// profile drops the remembered current, so the next GET reads live and reflects
// the new selection instead of the cache-first path flipping it back (the HA
// integration's profile select).
func TestSetMachineProfile_ForgetsCurrentSoNextGetGoesLive(t *testing.T) {
	h, adapter, mux, machineID := newCacheFirstFixture(t)
	adapter.setStatus(machineID, Status{ProfileID: intPtr(1), ProfileName: strPtr("Espresso")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}})

	doRequest(mux, profilesListReq(machineID)) // first GET: live, remembers current

	setBody := `{"id":"2","machineId":` + strconv.FormatInt(machineID, 10) + `}`
	rec := doRequest(mux, httptest.NewRequest(http.MethodPost, "/api/machine/profile/set", strings.NewReader(setBody)))
	if rec.Code != http.StatusOK {
		t.Fatalf("set status = %d, body = %s", rec.Code, rec.Body)
	}
	if _, ok := h.rememberedProfilesCurrent(machineID); ok {
		t.Fatal("remembered current still present after a successful profile set")
	}

	// The machine now reports the selected profile plus a new one; the next GET
	// must reflect that live list, not the one-row cache.
	adapter.setStatus(machineID, Status{ProfileID: intPtr(2), ProfileName: strPtr("Lungo")})
	adapter.setList(machineID, []ProfileSummary{{ID: "1", Name: "Espresso"}, {ID: "2", Name: "Lungo"}})

	rec = doRequest(mux, profilesListReq(machineID))
	body := decodeBody(t, rec.Body.Bytes())
	if optionsRaw, _ := body["optionsRaw"].([]any); len(optionsRaw) != 2 {
		t.Fatalf("GET after set optionsRaw = %+v, want the live two-row list", optionsRaw)
	}
	if body["current"] != "Lungo" || body["currentId"] != float64(2) {
		t.Errorf("GET after set current = %v/%v, want Lungo/2", body["current"], body["currentId"])
	}
}
