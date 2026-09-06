package system

import (
	"context"
	"log"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
)

// sync_triggers.go ports the three automatic drivers of the default
// machine's shot-history pull that live in lib/sync.js / lib/poll.js
// (#953). Before this, sync.go only exposed RunManualSync (POST /api/sync),
// so a new shot never landed in the Go build until the barista hit "Sync"
// by hand:
//
//   - syncAfterBrew (lib/sync.js:52): 3s after a brew finishes, pull the
//     shot the machine just wrote.
//   - scheduleNextSync (lib/sync.js:329): a periodic pull every
//     sync_interval minutes, with a short retry-backoff sequence on
//     failure before falling back to the regular cadence.
//   - #725 reachability recovery (lib/poll.js:228): when the machine goes
//     unreachable->reachable again and a sync is known to be outstanding,
//     catch up immediately instead of waiting for the next scheduled pull.
//
// syncOtherMachines / native-maintenance sync / SYNC_PROGRESS events stay
// unported (see sync.go + doc.go) — this only adds triggers for the
// default-machine loop that sync.go already implements.

// Tunables, package-level so tests can shrink them (restore with defer).
var (
	// syncAfterBrewDelay mirrors lib/poll.js's setTimeout(syncAfterBrew, 3000).
	syncAfterBrewDelay = 3 * time.Second
	// syncRetryDelays ports lib/sync.js's SYNC_RETRY_DELAYS: the backoff
	// sequence tried after a failed scheduled sync before resuming the
	// regular sync_interval cadence.
	syncRetryDelays = []time.Duration{30 * time.Second, 60 * time.Second, 120 * time.Second}
)

// syncIntervalOverride, when non-zero, replaces loadSyncIntervalMinutes()
// for the periodic scheduler — tests set it so the loop fires in
// milliseconds instead of minutes.
func (p *Poller) regularSyncInterval() time.Duration {
	if p.syncIntervalOverride > 0 {
		return p.syncIntervalOverride
	}
	return time.Duration(loadSyncIntervalMinutes()) * time.Minute
}

// syncOnce runs one default-machine pull — syncDefaultMachineShots, unless
// a test has installed a syncFn seam.
func (p *Poller) syncOnce(ctx context.Context) error {
	if p.syncFn != nil {
		return p.syncFn(ctx)
	}
	return p.syncDefaultMachineShots(ctx)
}

// syncCtx returns the poller-lifetime context an auto-sync goroutine should
// run under — Start()'s ctx, or context.Background() when Start was never
// called (unit tests that drive triggers directly).
func (p *Poller) syncCtx() context.Context {
	if p.lifeCtx != nil {
		return p.lifeCtx
	}
	return context.Background()
}

// scheduleSyncAfterBrew ports lib/poll.js's `setTimeout(syncAfterBrew,
// 3000)` fired from the brew-finished branch: wait 3s (the machine needs a
// moment to persist the shot), then pull, logging the new shot id(s) the
// way syncAfterBrew() does. Single-flight is handled inside
// syncDefaultMachineShots (defaultSyncInFlight, #773).
func (p *Poller) scheduleSyncAfterBrew() {
	if p.shots == nil {
		return
	}
	ctx := p.syncCtx()
	httputil.SafeGo("system: post-brew sync", func() {
		select {
		case <-time.After(syncAfterBrewDelay):
		case <-ctx.Done():
			return
		}
		prevMax, _ := p.shots.MaxNativeShotID(1)
		if err := p.syncOnce(ctx); err != nil {
			log.Printf("system: post-brew sync failed: %v", err)
			return
		}
		if newMax, _ := p.shots.MaxNativeShotID(1); newMax > prevMax {
			log.Printf("system: post-brew sync: caught up to new shot #%d", newMax)
		}
	})
}

// maybeCatchUpAfterRecovery ports lib/poll.js's #725 block: called from the
// status-poll success path with the reachability value observed on the
// PREVIOUS poll. A false->true transition, plus either a recorded sync
// error or no successful sync ever, means the shot history is behind — pull
// now rather than waiting up to a full sync_interval. Fire-and-forget: it
// must never block or fail the live poll.
func (p *Poller) maybeCatchUpAfterRecovery(prevReachable *bool) {
	if p.shots == nil || prevReachable == nil || *prevReachable {
		return
	}
	p.state.mu.Lock()
	outstanding := p.state.lastSyncError != nil || p.state.lastSyncTime == nil
	p.state.mu.Unlock()
	if !outstanding {
		return
	}
	ctx := p.syncCtx()
	httputil.SafeGo("system: catch-up sync", func() {
		if err := p.syncOnce(ctx); err != nil {
			log.Printf("system: catch-up sync after reachability recovery failed: %v", err)
		}
	})
}

// runScheduledSync ports lib/sync.js's scheduleNextSync() recursion as a
// context-driven loop: sync every regularSyncInterval() (retry == 0); after
// a failure, retry on the syncRetryDelays sequence (30s / 60s / 120s),
// capping at the last delay for a persistent outage exactly like Node's
// `Math.min(retryCount + 1, SYNC_RETRY_DELAYS.length)`. A success resets to
// the regular cadence. Started from Start(); exits on context cancel.
func (p *Poller) runScheduledSync(ctx context.Context) {
	if p.shots == nil {
		return
	}
	retry := 0
	for {
		var delay time.Duration
		if retry >= 1 && retry <= len(syncRetryDelays) {
			delay = syncRetryDelays[retry-1]
			log.Printf("system: sync retry %d/%d in %s", retry, len(syncRetryDelays), delay)
		} else {
			delay = p.regularSyncInterval()
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}

		if err := p.syncOnce(ctx); err != nil {
			log.Printf("system: scheduled sync failed: %v", err)
			if retry++; retry > len(syncRetryDelays) {
				retry = len(syncRetryDelays)
			}
			continue
		}
		retry = 0
	}
}
