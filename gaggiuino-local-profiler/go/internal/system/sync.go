package system

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
)

// This file ports the part of lib/sync.js POST /api/sync actually needs
// (Phase 2a, #901): a manual trigger of the default machine's shot-history
// pull loop — syncShots()'s `${machineUrl}/latest` probe + `${machineUrl}/
// {id}` backfill, including the #341/#1147 machine scoping and #719
// oversized-id guard on the local max-id it catches up from, the #721
// 404 -> blocklist skip, and the state.lastSyncTime/lastSyncError/
// machineReachable writes GET /api/status reports. The GaggiMate default
// machine path (syncGaggiMateShots) is scoped to that machine's own id
// range too (#1147), so a GaggiMate set as the default imports its shots
// under its own machine instead of the first machine's.
//
// #1146 adds syncOtherMachines() on top: after the default machine, every
// other enabled registered machine is pulled up from its own last-synced
// native shot id — a GaggiMate through syncGaggiMateShots, a Gaggiuino
// through syncGaggiuinoMachineShots (the same /api/shots REST surface as the
// default path, re-keyed under the machine's own global id range, #341). One
// machine failing never stops the others, and a non-default machine never
// writes the default-only sync state (lastSyncTime/lastSyncError/
// machineReachable/lastMachineError/cachedMachineVersion).
//
// Deliberately still NOT ported here (unchanged from doc.go's "Deliberately
// not ported" — lib/sync.js as a whole is its own future phase):
//
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
// explicit and independent of ha.Client / adapter clients. It dials
// through machines.NewGuardedHTTPClient (#1049) rather than a bare
// *http.Client: fetchLatestShotID/fetchShot hit the default machine's own
// BaseURLFor host, the same SSRF-guarded threat model as every other
// machine call in this app, and a bare client's http.DefaultTransport
// would re-resolve that hostname unguarded at connect time.
var syncClient = machines.NewGuardedHTTPClient(syncHTTPTimeout)

// errMalformedShot tags a fully received 200 response whose body
// json.Unmarshal could not read (#1151). The sync loop catches it and skips
// that one shot — the Go equivalent of Node's "invalid data" branch —
// instead of aborting the whole sync and leaving every newer shot
// unimported forever. It is deliberately NOT the same as a transport error:
// a dropped connection or a cancelled ctx aborts the sync instead, so the
// next run retries — otherwise a later shot landing above this one would
// hide it for good.
var errMalformedShot = errors.New("malformed shot body")

// syncBaseURLFor resolves a machine's base URL for the pull loop. A
// package-level var (rather than machines.BaseURLFor called inline) so a
// test can point the loop at an httptest fake machine: BaseURLFor's SSRF
// guard deliberately rejects loopback hosts, and machines' own
// allowLoopbackMachineHost test seam is unexported and unreachable here.
var syncBaseURLFor = machines.BaseURLFor

// syncFetchGaggiMateIndex/syncFetchGaggiMateShot are the GaggiMate history
// seams, package-level vars for the same reason as syncBaseURLFor above: a
// test backs the pull loop with in-process fakes instead of the real HTTP
// fetchers.
var syncFetchGaggiMateIndex = machines.FetchGaggiMateIndex
var syncFetchGaggiMateShot = machines.FetchGaggiMateShot

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

// RunManualSync ports lib/sync.js's syncAllMachines(): the default machine's
// syncShots() pull loop, then every other enabled registered machine
// (#1146). Safe to call in a goroutine (routes/system.js fires it un-awaited
// after responding 200). Retry/backoff is unaffected by other machines'
// outcomes — they only log.
func (p *Poller) RunManualSync(ctx context.Context) {
	if p.shots == nil {
		log.Printf("system: manual sync requested but no shots repo wired — skipping")
		return
	}
	if err := p.syncDefaultMachineShots(ctx); err != nil {
		log.Printf("system: manual sync error: %v", err)
	}
	p.syncOtherMachines(ctx)
}

// backfillShots is the one catch-up loop both sync paths run: read the
// blocklist, resume after the highest native id already stored locally for
// machineID, then fetch every id up to latestNative, blocklisting 404s,
// skipping malformed bodies and shots without id/datapoints, and passing each
// fetched shot through prepare for that path's own re-keying before Upsert.
// It deliberately writes no sync state — recordSyncSuccess/recordSyncError/
// recordMachineReachable stay in the callers, so the default-only reachability
// stamping is unchanged.
//
// The first return value reports whether the error is one the caller should
// stamp via recordSyncError: true for a fetch transport error or an Upsert
// failure (the machine/sync failed), false for a local DB error (GetBlocklist,
// MaxNativeShotID, AppendToBlocklist, prepare), which must not flip a reachable
// machine
// offline.
func (p *Poller) backfillShots(
	ctx context.Context,
	machineID, latestNative int64,
	fetch func(ctx context.Context, native int64) (map[string]any, int, error),
	prepare func(shot map[string]any, native int64) (bool, error),
	logs backfillLogs,
) (recordErr bool, err error) {
	blocklist, err := p.shots.GetBlocklist()
	if err != nil {
		return false, err
	}
	maxLocalID, err := p.shots.MaxNativeShotID(machineID)
	if err != nil {
		return false, err
	}
	effectiveMax := effectiveSyncMax(machineID, maxLocalID, blocklist)

	if effectiveMax >= latestNative {
		log.Printf("%s: already up to date (shots: %d)", logs.prefix, maxLocalID)
		return false, nil
	}

	for i := effectiveMax + 1; i <= latestNative; i++ {
		shot, status, err := fetch(ctx, i)
		if err != nil {
			if status == http.StatusNotFound {
				// #721: shot permanently gone — blocklist it and skip past.
				log.Printf("%s: shot %d not found%s (404) — marking permanently missing", logs.prefix, i, logs.notFoundSuffix)
				if aerr := p.shots.AppendToBlocklist(strconv.FormatInt(shots.ToGlobalShotID(machineID, i), 10)); aerr != nil {
					return false, aerr
				}
				continue
			}
			if errors.Is(err, errMalformedShot) {
				// #1151: one damaged shot must not stop the shots above it
				// importing. No blocklist entry — that means "permanently
				// missing on the machine", which we cannot know here.
				log.Printf("%s: shot %d has malformed data (%v) — skipped", logs.prefix, i, err)
				continue
			}
			return true, err
		}
		if shot["id"] == nil || shot["datapoints"] == nil {
			log.Printf("%s: shot %d %s — skipped", logs.prefix, i, logs.invalidReason)
			continue
		}
		keep, perr := prepare(shot, i)
		if perr != nil {
			return false, perr
		}
		if !keep {
			continue
		}
		if uerr := p.shots.Upsert(shots.Shot(shot)); uerr != nil {
			return true, uerr
		}
	}

	log.Printf("%s complete: caught up to shot %d", logs.prefix, latestNative)
	return false, nil
}

// backfillLogs carries each sync path's existing log wording into the shared
// loop: the prefix names the path, and the suffix/reason keep the 404 and
// invalid-shot lines byte-for-byte as they read before the two loops merged.
type backfillLogs struct {
	prefix         string
	notFoundSuffix string
	invalidReason  string
}

// syncDefaultMachineShots ports syncShots(defaultRuntime) — the default
// machine branch only. Like the other two paths it is scoped to the default
// machine's own id range (#1162): before that fix a Gaggiuino whose id is not
// 1 but which is the default machine had its whole history filed under
// machine 1.
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

	base, err := syncBaseURLFor(ctx, machine)
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

	recordErr, err := p.backfillShots(ctx, machine.ID, *latestMachineID,
		func(ctx context.Context, native int64) (map[string]any, int, error) {
			return p.fetchShot(ctx, machineURL, native)
		},
		func(shot map[string]any, native int64) (bool, error) {
			// Some firmware reports the shot id as a JSON string; normalize it to
			// int64 so shotInsertArgs stores the real id instead of 0 (which would
			// make every shot overwrite the previous one).
			if _, ok := jsNumberToInt64(shot["id"]); !ok {
				log.Printf("system: sync: shot %d has unparseable id %#v — skipped", native, shot["id"])
				return false, nil
			}
			// #1162: store the default machine's shots under its own global id range,
			// like every other machine's, instead of machine 1's native ids.
			shot["id"] = shots.ToGlobalShotID(machine.ID, native)
			shot["machineId"] = machine.ID
			p.captureMachineVersionFromShot(shot)
			p.state.mu.Lock()
			ver := p.state.cachedMachineVersion
			p.state.mu.Unlock()
			if ver != nil {
				shot["glpFirmwareVersion"] = *ver
			}
			// A shot this machine already filed under machine 1 (same native id and
			// timestamp) is moved to its new global id rather than upserted as a
			// duplicate. The move preserves the row's stored data (image, firmware
			// version), so skip the Upsert that would overwrite it.
			if machine.ID != 1 {
				if ts, ok := jsNumberToInt64(shot["timestamp"]); ok {
					moved, merr := p.shots.MoveMisfiledShot(native, ts, machine.ID)
					if merr != nil {
						return false, merr
					}
					if moved {
						log.Printf("system: sync: moved shot %d filed under machine 1 to machine %d (#1162)", native, machine.ID)
						return false, nil
					}
				}
			}
			return true, nil
		},
		backfillLogs{prefix: "system: sync", notFoundSuffix: " on machine", invalidReason: "has invalid data"})
	if err != nil {
		if recordErr {
			p.recordSyncError(err)
		}
		return err
	}
	p.recordSyncSuccess()
	return nil
}

// syncOtherMachines ports syncOtherMachines() (#341, #1146): after the
// default machine's own pull, catch up every OTHER enabled registered machine
// from its own last-synced native shot id. A GaggiMate goes through
// syncGaggiMateShots, a Gaggiuino through syncGaggiuinoMachineShots. Each
// machine's error is logged on its own and the loop moves on, so one machine
// failing never stops the others — the caller's retry/backoff stays driven by
// the default machine's result alone.
func (p *Poller) syncOtherMachines(ctx context.Context) {
	list, err := p.registry.ListMachines()
	if err != nil {
		log.Printf("system: sync: listing machines: %v", err)
		return
	}
	for i := range list {
		machine := &list[i]
		// #718: an unconfigured machine has no host to dial.
		if !machine.Enabled || machine.IsDefault || machine.Host == "" {
			continue
		}
		// #773: one sync per machine at a time — a different machine's id is
		// unaffected, matching Node's state.otherMachineSyncInFlight.
		if !p.beginOtherMachineSync(machine.ID) {
			continue
		}
		err := p.syncOneOtherMachine(ctx, machine)
		p.endOtherMachineSync(machine.ID)
		if err != nil {
			log.Printf("system: sync (%s): %v", machine.Name, err)
		}
	}
}

// syncOneOtherMachine dispatches one non-default machine to its type's pull
// loop.
func (p *Poller) syncOneOtherMachine(ctx context.Context, machine *machines.Machine) error {
	if machine.Type == "gaggimate" {
		return p.syncGaggiMateShots(ctx, machine)
	}
	return p.syncGaggiuinoMachineShots(ctx, machine)
}

// beginOtherMachineSync/endOtherMachineSync are the #773 per-machine
// single-run guard behind otherSyncInFlight — the same locking pattern as
// defaultSyncInFlight, but keyed by machine id.
func (p *Poller) beginOtherMachineSync(machineID int64) bool {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	if p.state.otherSyncInFlight[machineID] {
		return false
	}
	if p.state.otherSyncInFlight == nil {
		p.state.otherSyncInFlight = map[int64]bool{}
	}
	p.state.otherSyncInFlight[machineID] = true
	return true
}

func (p *Poller) endOtherMachineSync(machineID int64) {
	p.state.mu.Lock()
	defer p.state.mu.Unlock()
	delete(p.state.otherSyncInFlight, machineID)
}

// syncGaggiuinoMachineShots ports syncMachineShots() for a non-default
// Gaggiuino machine: the same `${machineUrl}/latest` probe + `/api/shots/{id}`
// backfill as syncDefaultMachineShots, except each fetched shot is re-keyed
// under the machine's own global id range and stamped with its machine id
// (#341). It deliberately writes no default-only sync state — lastSyncTime/
// lastSyncError/machineReachable/lastMachineError and the firmware cache
// belong to the default machine (the backfillShots helper writes none either).
func (p *Poller) syncGaggiuinoMachineShots(ctx context.Context, machine *machines.Machine) error {
	base, err := syncBaseURLFor(ctx, machine)
	if err != nil {
		return fmt.Errorf("resolving machine URL: %w", err)
	}
	machineURL := base + "/api/shots"

	latestNativeID, err := p.fetchLatestShotID(ctx, machineURL)
	if err != nil {
		return err
	}
	if latestNativeID == nil {
		log.Printf("system: sync (%s): machine /latest returned no lastShotId — skipped", machine.Name)
		return nil
	}

	_, err = p.backfillShots(ctx, machine.ID, *latestNativeID,
		func(ctx context.Context, native int64) (map[string]any, int, error) {
			return p.fetchShot(ctx, machineURL, native)
		},
		func(shot map[string]any, native int64) (bool, error) {
			// #1142: some firmware reports the shot id as a JSON string. An
			// unparseable one isn't a shot we can key, so skip it — and the
			// stored id is always this machine's global id, never the
			// reported value (a machine reports its own native ids).
			if _, ok := jsNumberToInt64(shot["id"]); !ok {
				log.Printf("system: sync (%s): shot %d has unparseable id %#v — skipped", machine.Name, native, shot["id"])
				return false, nil
			}
			shot["id"] = shots.ToGlobalShotID(machine.ID, native)
			shot["machineId"] = machine.ID
			return true, nil
		},
		backfillLogs{prefix: "system: sync (" + machine.Name + ")", notFoundSuffix: " on machine", invalidReason: "has invalid data"})
	return err
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
		if _, serr := adapter.GetStatus(ctx, machine); serr == nil && machine.IsDefault {
			p.recordMachineReachable()
		}
	}

	base, berr := syncBaseURLFor(ctx, machine)
	if berr != nil {
		log.Printf("system: gaggimate sync: machine URL unresolvable: %v", berr)
		return nil
	}

	latestMachineID, err := syncFetchGaggiMateIndex(ctx, base)
	if err != nil {
		// HTTP unreachable — machine may still be live via WS (e.g. only HTTP
		// is blocked). Not a hard error: return nil so the caller doesn't stamp
		// a sync failure and the next tick retries.
		log.Printf("system: gaggimate sync: history unreachable: %v", err)
		return nil
	}
	if latestMachineID == 0 {
		log.Printf("system: gaggimate sync: no shots on machine")
		if machine.IsDefault {
			p.recordSyncSuccess()
		}
		return nil
	}

	recordErr, err := p.backfillShots(ctx, machine.ID, latestMachineID,
		func(ctx context.Context, native int64) (map[string]any, int, error) {
			return syncFetchGaggiMateShot(ctx, base, native)
		},
		func(shot map[string]any, native int64) (bool, error) {
			// #1147: index.bin reports the machine's own native ids, but shots are
			// stored under globally-unique ids (global = machineID*offset+native).
			// Re-key and stamp the machine so a GaggiMate set as the default lands
			// under its own machine instead of machine 1.
			shot["id"] = shots.ToGlobalShotID(machine.ID, native)
			shot["machineId"] = machine.ID
			return true, nil
		},
		backfillLogs{prefix: "system: gaggimate sync", invalidReason: "has no id/datapoints"})
	if err != nil {
		if recordErr && machine.IsDefault {
			p.recordSyncError(err)
		}
		return err
	}
	if machine.IsDefault {
		p.recordSyncSuccess()
	}
	return nil
}

// fetchLatestShotID ports `axios.get(${machineUrl}/latest)` +
// `latestResponse.data?.[0]?.lastShotId`. A nil return means the machine
// reported no lastShotId (a valid, non-error "nothing to sync" state).
func (p *Poller) fetchLatestShotID(ctx context.Context, machineURL string) (*int64, error) {
	debugLogf("GET %s/latest", machineURL) // ports lib/sync.js's debugLog(`GET ${machineUrl}/latest`), #714
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
	debugLogf("/latest lastShotId=%d", id) // ports lib/sync.js's debugLog(`/latest raw response: ...`)
	return &id, nil
}

// fetchShot ports `axios.get(${machineUrl}/{i})`. status is the HTTP status
// on an error (0 for a transport error), so the caller can special-case
// 404 the way lib/sync.js's `err.response?.status === 404` branch does.
func (p *Poller) fetchShot(ctx context.Context, machineURL string, id int64) (map[string]any, int, error) {
	shotStartedAt := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, machineURL+"/"+strconv.FormatInt(id, 10), nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := syncClient.Do(req)
	if err != nil {
		// ports lib/sync.js's debugLog(`GET ${machineUrl}/${i} failed after ${ms}ms: ${err.message}`)
		debugLogf("GET %s/%d failed after %dms: %v", machineURL, id, time.Since(shotStartedAt).Milliseconds(), err)
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		debugLogf("GET %s/%d failed after %dms: HTTP %d", machineURL, id, time.Since(shotStartedAt).Milliseconds(), resp.StatusCode)
		return nil, resp.StatusCode, fmt.Errorf("machine returned HTTP %d for shot %d", resp.StatusCode, id)
	}
	// Read the whole body before decoding. A read failure means the response
	// was cut short — a dropped connection or a cancelled ctx, which surfaces
	// as io.ErrUnexpectedEOF rather than a net.Error — and must abort the sync
	// so the next run retries this shot. Tagging it as malformed would skip it
	// for good once a later shot lands above it (#1151).
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, resp.StatusCode, err
	}
	var shot map[string]any
	if err := json.Unmarshal(body, &shot); err != nil {
		// #1151: a fully received 200 whose body we still can't decode is
		// hopeless data, not a transient failure — tag it so the caller skips
		// only this shot and carries on.
		return nil, resp.StatusCode, fmt.Errorf("shot %d: %w: %v", id, errMalformedShot, err)
	}
	// ports lib/sync.js's debugLog(`GET ${machineUrl}/${i} -> ${ms}ms`)
	debugLogf("GET %s/%d -> %dms", machineURL, id, time.Since(shotStartedAt).Milliseconds())
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

// effectiveSyncMax returns the shot id the sync should resume after for
// machineID: the highest native id already stored locally for that machine,
// advanced only by blocklist entries that belong to that machine's own native
// id range. A blocklist entry is a *global* id
// (machineID*shots.MachineIDOffset + nativeId), so another machine's or a
// demo id must not advance the cursor — otherwise it would push effectiveMax
// past every one of this machine's own ids for good (#1147, #1148). For
// machine 1 this is exactly the old 0 < n < 10M check.
func effectiveSyncMax(machineID, maxLocalNative int64, blocklist []string) int64 {
	effectiveMax := maxLocalNative
	for _, b := range blocklist {
		if n, perr := strconv.ParseInt(b, 10, 64); perr == nil {
			if native, ok := shots.NativeShotIDIfOwned(machineID, n); ok && native > effectiveMax {
				effectiveMax = native
			}
		}
	}
	return effectiveMax
}

// jsNumberToInt64 accepts the float64 encoding/json produces for a JSON
// number, an int64, or a numeric JSON string (some firmware builds quote
// the id), matching lib/sync.js tolerating whatever the machine's
// firmware sends — JS coerced a string id, this port has to parse it.
func jsNumberToInt64(v any) (int64, bool) {
	switch t := v.(type) {
	case float64:
		return int64(t), true
	case int64:
		return t, true
	case json.Number:
		n, err := t.Int64()
		return n, err == nil
	case string:
		n, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
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
