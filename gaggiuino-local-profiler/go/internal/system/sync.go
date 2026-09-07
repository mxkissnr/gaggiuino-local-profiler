package system

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports the part of lib/sync.js POST /api/sync actually needs
// (Phase 2a, #901): a manual trigger of the default machine's shot-history
// pull loop — syncShots()'s `${machineUrl}/latest` probe + `${machineUrl}/
// {id}` backfill, including the #341 machine-1 scoping and #719
// oversized-id guard on the local max-id it catches up from, the #721
// 404 -> blocklist skip, and the state.lastSyncTime/lastSyncError/
// machineReachable writes GET /api/status reports.
//
// Deliberately still NOT ported here (unchanged from doc.go's "Deliberately
// not ported" — lib/sync.js as a whole is its own future phase):
//
//   - syncOtherMachines()/syncMachineShots() — the adapter-driven pull for
//     non-default registered machines (#341). The Go machines.Adapter
//     interface has no GetShot/GetLatestShotId methods yet; adding them is
//     machines-domain work, out of this endpoint's scope. A manual sync
//     here therefore covers the default machine only, same as every
//     single-machine install (the overwhelming majority) already gets.
//   - syncNativeMaintenance() (#578) — needs lib/maintenance-sync.js, a
//     maintenance-domain port.
//   - scheduleNextSync()'s retry/backoff timer and state.syncRetryCount —
//     nothing drives an automatic sync loop in this Go port yet, so a
//     retry schedule has nothing to hang off. GET /api/status's
//     syncRetryCount stays 0.
//   - the SYNC_PROGRESS / SYNC_COMPLETE bus events (state.syncProgress) —
//     no event bus in this port, and system/doc.go already documents
//     state.syncProgress as unported. The backfill still runs; it just
//     doesn't stream a progress bar.

// manualSyncCooldown mirrors routes/system.js's `now - state.lastManualSync
// < 30000` guard.
const manualSyncCooldown = 30 * time.Second

// syncHTTPTimeout mirrors lib/sync.js's per-request `{ timeout: 10000 }`.
const syncHTTPTimeout = 10 * time.Second

// syncClient is a dedicated client so the per-request timeout above is
// explicit and independent of ha.Client / adapter clients.
var syncClient = &http.Client{Timeout: syncHTTPTimeout}

// SetShotsRepo wires the shots Repository the manual-sync pull loop
// persists into. Kept a setter (not a NewPoller parameter) so the three
// existing NewPoller call sites — none of which exercise sync — stay
// unchanged; cmd/server calls this once at startup. A nil repo (every test
// that doesn't set it) makes RunManualSync a logged no-op rather than a
// panic.
func (p *Poller) SetShotsRepo(repo *shots.Repository) { p.shots = repo }

// SyncState is the subset of pollGlobalState GET /api/status's
// lastSync/lastSyncError fields read (Phase 2a wired these — before, both
// were permanently null per doc.go).
type SyncState struct {
	LastSync      *string
	LastSyncError *string
}

// SyncState snapshots the sync-progress fields.
func (p *Poller) SyncState() SyncState {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	return SyncState{LastSync: p.state.lastSyncTime, LastSyncError: p.state.lastSyncError}
}

// tryStartManualSync ports the `now - state.lastManualSync < 30000` cooldown
// check + `state.lastManualSync = now` claim as one atomic step. Returns
// false when a sync ran less than 30s ago.
func (p *Poller) tryStartManualSync() bool {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	now := time.Now()
	if !p.state.lastManualSync.IsZero() && now.Sub(p.state.lastManualSync) < manualSyncCooldown {
		return false
	}
	p.state.lastManualSync = now
	return true
}

// RunManualSync ports lib/sync.js's syncAllMachines() as far as this phase
// ports it: the default machine's syncShots() pull loop. Safe to call in a
// goroutine (routes/system.js fires it un-awaited after responding 200).
func (p *Poller) RunManualSync(ctx context.Context) {
	if p.shots == nil {
		log.Printf("system: manual sync requested but no shots repo wired — skipping")
		return
	}
	if err := p.syncDefaultMachineShots(ctx); err != nil {
		log.Printf("system: manual sync error: %v", err)
	}
}

// syncDefaultMachineShots ports syncShots(defaultRuntime) — the default
// machine branch only.
func (p *Poller) syncDefaultMachineShots(ctx context.Context) error {
	// #655: skip (without touching lastSyncTime/lastSyncError) when the
	// machine is known off — checkAndApplyMachinePower already drove the
	// status dot red, and stamping "synced now" here would lie.
	snap := p.runtime.Get()
	switchEntity := p.defaultSwitchEntity()
	if !snap.MachineOn && switchEntity != "" {
		return nil
	}

	// #773: one sync at a time.
	p.state.mu.Lock()
	if p.state.defaultSyncInFlight {
		p.state.mu.Unlock()
		return nil
	}
	p.state.defaultSyncInFlight = true
	p.state.mu.Unlock()
	defer func() {
		p.state.mu.Lock()
		p.state.defaultSyncInFlight = false
		p.state.mu.Unlock()
	}()

	machine, err := p.registry.GetDefaultMachine()
	if err != nil || machine == nil {
		return err
	}
	// #718: no host configured anywhere — nothing to sync.
	if machine.Host == "" {
		return nil
	}

	// #952 Part B: GaggiMate uses binary index.bin/.slog history files, not
	// the Gaggiuino /api/shots REST surface. Dispatch to dedicated sync path.
	if machine.Type == "gaggimate" {
		return p.syncGaggiMateShots(ctx, machine)
	}

	base, err := machines.BaseURLFor(ctx, machine)
	if err != nil {
		return fmt.Errorf("resolving machine URL: %w", err)
	}
	machineURL := base + "/api/shots"

	latestMachineID, err := p.fetchLatestShotID(ctx, machineURL)
	if err != nil {
		p.recordSyncError(err)
		return err
	}
	p.recordMachineReachable()
	if latestMachineID == nil {
		log.Printf("system: sync: machine /latest returned no lastShotId — skipped")
		return nil
	}

	blocklist, err := p.shots.GetBlocklist()
	if err != nil {
		return err
	}
	maxLocalID, err := p.shots.MaxNativeShotID(1)
	if err != nil {
		return err
	}
	effectiveMax := maxLocalID
	for _, b := range blocklist {
		if n, perr := strconv.ParseInt(b, 10, 64); perr == nil && n > effectiveMax {
			effectiveMax = n
		}
	}

	if effectiveMax >= *latestMachineID {
		log.Printf("system: sync: already up to date (shots: %d)", maxLocalID)
		p.recordSyncSuccess()
		return nil
	}

	for i := effectiveMax + 1; i <= *latestMachineID; i++ {
		shot, status, err := p.fetchShot(ctx, machineURL, i)
		if err != nil {
			if status == http.StatusNotFound {
				// #721: shot permanently gone — blocklist it and skip past.
				log.Printf("system: sync: shot %d not found on machine (404) — marking permanently missing", i)
				if aerr := p.shots.AppendToBlocklist(strconv.FormatInt(i, 10)); aerr != nil {
					return aerr
				}
				continue
			}
			p.recordSyncError(err)
			return err
		}
		if shot["id"] == nil || shot["datapoints"] == nil {
			log.Printf("system: sync: shot %d has invalid data — skipped", i)
			continue
		}
		p.captureMachineVersionFromShot(shot)
		p.state.mu.Lock()
		ver := p.state.cachedMachineVersion
		p.state.mu.Unlock()
		if ver != nil {
			shot["glpFirmwareVersion"] = *ver
		}
		if uerr := p.shots.Upsert(shots.Shot(shot)); uerr != nil {
			p.recordSyncError(uerr)
			return uerr
		}
	}

	log.Printf("system: sync complete: caught up to shot %d", *latestMachineID)
	p.recordSyncSuccess()
	return nil
}

// syncGaggiMateShots ports syncMachineShots() for GaggiMate (#952 Part B):
// probes reachability via the WS adapter (live cache), then fetches
// /api/history/index.bin to find the latest shot ID and pulls missing .slog
// files — same blocklist/404 logic as the Gaggiuino path above.
// HTTP unreachable is not an error: the adapter probe already recorded
// reachability, so we return nil and skip the sync (the next scheduled tick
// will retry).
func (p *Poller) syncGaggiMateShots(ctx context.Context, machine *machines.Machine) error {
	// Probe via adapter (WS cache) — this sets MachineReachable independent of
	// whether the HTTP history endpoint is up.
	adapter, err := p.adapters.GetAdapter(machine)
	if err == nil {
		if _, serr := adapter.GetStatus(ctx, machine); serr == nil {
			p.recordMachineReachable()
		}
	}

	base, berr := machines.BaseURLFor(ctx, machine)
	if berr != nil {
		log.Printf("system: gaggimate sync: machine URL unresolvable: %v", berr)
		return nil
	}

	latestMachineID, err := machines.FetchGaggiMateIndex(ctx, base)
	if err != nil {
		// HTTP unreachable — machine may still be live via WS (e.g. only HTTP
		// is blocked). Not a hard error: return nil so the caller doesn't stamp
		// a sync failure and the next tick retries.
		log.Printf("system: gaggimate sync: history unreachable: %v", err)
		return nil
	}
	if latestMachineID == 0 {
		log.Printf("system: gaggimate sync: no shots on machine")
		p.recordSyncSuccess()
		return nil
	}

	blocklist, err := p.shots.GetBlocklist()
	if err != nil {
		return err
	}
	maxLocalID, err := p.shots.MaxNativeShotID(1)
	if err != nil {
		return err
	}
	effectiveMax := maxLocalID
	for _, b := range blocklist {
		if n, perr := strconv.ParseInt(b, 10, 64); perr == nil && n > effectiveMax {
			effectiveMax = n
		}
	}

	if effectiveMax >= latestMachineID {
		log.Printf("system: gaggimate sync: already up to date (shots: %d)", maxLocalID)
		p.recordSyncSuccess()
		return nil
	}

	for i := effectiveMax + 1; i <= latestMachineID; i++ {
		shot, status, err := machines.FetchGaggiMateShot(ctx, base, i)
		if err != nil {
			if status == http.StatusNotFound {
				log.Printf("system: gaggimate sync: shot %d not found (404) — marking permanently missing", i)
				if aerr := p.shots.AppendToBlocklist(strconv.FormatInt(i, 10)); aerr != nil {
					return aerr
				}
				continue
			}
			p.recordSyncError(err)
			return err
		}
		if shot["id"] == nil || shot["datapoints"] == nil {
			log.Printf("system: gaggimate sync: shot %d has no id/datapoints — skipped", i)
			continue
		}

		if uerr := p.shots.Upsert(shots.Shot(shot)); uerr != nil {
			p.recordSyncError(uerr)
			return uerr
		}
	}

	log.Printf("system: gaggimate sync complete: caught up to shot %d", latestMachineID)
	p.recordSyncSuccess()
	return nil
}

// fetchLatestShotID ports `axios.get(${machineUrl}/latest)` +
// `latestResponse.data?.[0]?.lastShotId`. A nil return means the machine
// reported no lastShotId (a valid, non-error "nothing to sync" state).
func (p *Poller) fetchLatestShotID(ctx context.Context, machineURL string) (*int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, machineURL+"/latest", nil)
	if err != nil {
		return nil, err
	}
	resp, err := syncClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("machine /latest returned HTTP %d", resp.StatusCode)
	}
	var rows []map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	id, ok := jsNumberToInt64(rows[0]["lastShotId"])
	if !ok {
		return nil, nil
	}
	return &id, nil
}

// fetchShot ports `axios.get(${machineUrl}/{i})`. status is the HTTP status
// on an error (0 for a transport error), so the caller can special-case
// 404 the way lib/sync.js's `err.response?.status === 404` branch does.
func (p *Poller) fetchShot(ctx context.Context, machineURL string, id int64) (map[string]any, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, machineURL+"/"+strconv.FormatInt(id, 10), nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := syncClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, resp.StatusCode, fmt.Errorf("machine returned HTTP %d for shot %d", resp.StatusCode, id)
	}
	var shot map[string]any
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&shot); err != nil {
		return nil, resp.StatusCode, err
	}
	return shot, resp.StatusCode, nil
}

// captureMachineVersionFromShot ports syncShots()'s inline
// `if (!state.cachedMachineVersion) { ... }` firmware sniff.
func (p *Poller) captureMachineVersionFromShot(shot map[string]any) {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	if p.state.cachedMachineVersion != nil {
		return
	}
	for _, key := range []string{"softwareVersion", "firmware", "buildNumber", "buildDate", "version"} {
		if v, ok := shot[key]; ok {
			if s := jsStringify(v); s != "" {
				p.state.cachedMachineVersion = &s
				log.Printf("system: Gaggiuino firmware (from shot): %s", s)
				return
			}
		}
	}
}

func (p *Poller) recordMachineReachable() {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	reachable := true
	p.state.machineReachable = &reachable
	p.state.lastMachineError = nil
	now := time.Now().UnixMilli()
	p.state.lastMachineSuccess = &now
}

func (p *Poller) recordSyncSuccess() {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	p.state.lastSyncTime = &now
	p.state.lastSyncError = nil
}

func (p *Poller) recordSyncError(err error) {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	msg := redactURLs(err.Error())
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	p.state.lastSyncError = &msg
	p.state.lastSyncTime = &now
	reachable := false
	p.state.machineReachable = &reachable
	p.state.lastMachineError = &msg
}

// jsNumberToInt64 accepts the float64 encoding/json produces for a JSON
// number, or an int64, matching lib/sync.js tolerating whatever the
// machine's firmware sends.
func jsNumberToInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case json.Number:
		n, err := t.Int64()
		return n, err == nil
	}
	return 0, false
}

// jsStringify ports `String(ver)` for the firmware-field sniff: a JSON
// string stays itself, a JSON number prints without a trailing ".0".
func jsStringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return ""
}
