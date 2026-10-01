// Command server is the Go rewrite's HTTP bootstrap: it wires internal/db,
// internal/auth, internal/ratelimit, internal/sse, internal/shots (Phase
// 1c), internal/library (Phase 1d), internal/machines (Phase 1e),
// internal/orders, internal/maintenance, internal/backup, internal/ha
// (Phase 1f), and internal/system (Phase 1g, issue #901) together into a
// real net/http server, in the same middleware order server.js actually
// registers its own (read that file, not a paraphrase of it — see the
// comment on the handler chain below).
//
// Every REST domain package the original Migrationsplan named now exists
// and is registered: GET /api/events (Phase 1b), /shots.json + /api/shots/*
// (Phase 1c), /api/library/* (Phase 1d), the machine-registry +
// machine-control + machine-profile domain (Phase 1e), /api/orders/*,
// /api/maintenance/*, GET/POST /api/backup + POST /api/restore (Phase 1f),
// and internal/system's GET /api/machine/status, GET /api/live/data,
// GET/POST /api/preheat*, GET /api/version, POST /api/demo/{seed,end}
// plus the background polling loop that backs them (Phase 1g). A handful
// of routes/system.js routes remain unrouted by design — see
// go/internal/system/doc.go's "Scope" section for exactly which and why
// (none of them are depended on by anything this phase ported). #977: this
// binary is now the repo-root Dockerfile's own CMD (glp-server) — it is
// the sole shipping entrypoint for every real install as of this cutover;
// server.js remains in the tree but is no longer built or run in the
// production image.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/backup"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/debug"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/httputil"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/importer"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/logbuf"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/mcp"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/mqtt"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/webapp"
)

// defaultPort matches lib/constants.js's DEFAULT_PORT (8099) — the port the
// Node app listens on today, confirmed against config.yaml's exposed add-on
// port. Overridable via GLP_PORT for local/dev runs of this binary outside
// the add-on container, same pattern as dbPath/tokenPath below.
const defaultPort = "8099"

// shutdownTimeout bounds how long main() waits for in-flight requests to
// drain during a graceful shutdown (SIGTERM/SIGINT) before giving up and
// returning anyway -- docker stop's own default grace period before SIGKILL
// is 10s, so this stays under that.
const shutdownTimeout = 8 * time.Second

// appConfig is the resolved runtime configuration buildApp needs — every
// field is an env-var read in production (configFromEnv) and an explicit
// value in tests (cmd/server's smoke test).
type appConfig struct {
	dbPath          string
	tokenPath       string
	port            string
	rateLimitWindow time.Duration
	rateLimitMax    int
	// logs is the in-memory ring of the app's own recent log output that
	// main() tees stderr into, handed to the MCP get_diagnostics tool. Nil in
	// tests that build appConfig directly, which the tool tolerates.
	logs mcp.LogSource
}

func configFromEnv() appConfig {
	return appConfig{
		dbPath:          getEnv("GLP_DB_PATH", db.DefaultPath),
		tokenPath:       getEnv("GLP_TOKEN_FILE", auth.DefaultTokenFile),
		port:            getEnv("GLP_PORT", defaultPort),
		rateLimitWindow: time.Duration(getEnvNumber("GLP_RATE_LIMIT_WINDOW_MS", float64(ratelimit.DefaultWindow/time.Millisecond))) * time.Millisecond,
		rateLimitMax:    int(getEnvNumber("GLP_RATE_LIMIT_MAX", float64(ratelimit.DefaultMax))),
	}
}

func main() {
	// Keep the app's own recent output in memory for the get_diagnostics MCP
	// developer tool while writing every line to stderr exactly as before.
	logs := logbuf.New(500)
	log.SetOutput(io.MultiWriter(os.Stderr, logs))

	cfg := configFromEnv()
	cfg.logs = logs

	handler, sqlDB, err := buildApp(context.Background(), cfg)
	if err != nil {
		log.Fatal(err)
	}
	defer sqlDB.Close()

	addr := ":" + cfg.port
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listening on %s: %v", addr, err)
	}

	srv := &http.Server{Handler: handler}

	// Graceful shutdown: docker stop sends SIGTERM to this process directly
	// (docker-entrypoint.sh execs it via su-exec, so there's no intermediate
	// shell to relay the signal) and waits a grace period before SIGKILL.
	// Catch it and drain in-flight requests via srv.Shutdown instead of
	// letting the process die mid-request; sqlDB.Close() (deferred above)
	// then runs once Serve returns below.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		log.Printf("received %s, shutting down gracefully", sig)
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("graceful shutdown did not complete cleanly: %v", err)
		}
	}()

	log.Printf("GLP Go server listening on port %s", cfg.port)
	if err := srv.Serve(tcpNoDelayListener{ln}); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

// onMux lets tests inspect the fully-registered mux (openapi_routes_test.go).
var onMux func(*http.ServeMux)

// buildApp wires every internal/* domain into the full net/http handler
// chain server.js registers, exactly as main() did inline before Phase 3
// (#901) split it out so cmd/server's HA-ingress smoke test can exercise
// the real middleware stack + real handlers end to end. ctx bounds the
// background poller's tickers — cancelling it shuts the poller (and its
// live-poll goroutine) down cleanly. The returned *sql.DB is the caller's
// to Close.
func buildApp(ctx context.Context, cfg appConfig) (http.Handler, *sql.DB, error) {
	dbPath := cfg.dbPath
	tokenPath := cfg.tokenPath
	rateLimitWindow := cfg.rateLimitWindow
	rateLimitMax := cfg.rateLimitMax

	sqlDB, err := db.Open(dbPath)
	if err != nil {
		return nil, nil, fmt.Errorf("opening database at %s: %w", dbPath, err)
	}

	token, err := auth.LoadOrCreateToken(tokenPath)
	if err != nil {
		sqlDB.Close()
		return nil, nil, fmt.Errorf("loading API token from %s: %w", tokenPath, err)
	}

	hub := sse.NewHub()
	sseHandler := &sse.Handler{Hub: hub}
	// Prime is wired below, once poller exists — routes/sse.js primes a
	// newly-connected client with the current preheat-update/live-snapshot
	// snapshot (buildPreheatResponse()/buildLiveDataResponse(), both
	// synchronous reads) before subscribing it to the Hub. The
	// sync-progress priming loop Node also does has no Go equivalent yet
	// (state.syncProgress isn't ported — see internal/system/doc.go).

	mux := http.NewServeMux()
	mux.Handle("/api/events", sseHandler)

	shotsRepo := shots.NewRepository(sqlDB)
	shotsHandlers := shots.NewHandlers(shotsRepo)
	shotsHandlers.RegisterRoutes(mux)

	libRepo := library.NewRepository(sqlDB)
	// #1198: server-side scoring resolves each shot's own library bean
	// (beanId-first, coffee-name fallback) so the list, share card and API
	// agree with what the achievement badges assume. internal/shots can't
	// import internal/library (library imports shots), so the lookup is
	// injected here; without it scoring keeps the generic fixed bands.
	shots.SetBeanSource(func() (func(shots.Shot) *shots.Bean, error) {
		lib, err := libRepo.GetLibrary()
		if err != nil {
			return nil, err
		}
		beans := lib.Beans
		return func(s shots.Shot) *shots.Bean {
			return library.ScoreBean(s, beans)
		}, nil
	})
	libraryHandlers := library.NewHandlers(libRepo, shotsRepo)
	libraryHandlers.RegisterRoutes(mux)

	// #961: one-time optimization of an already-populated image library —
	// downscale oversized JPEG/PNG photos, strip their metadata, and
	// generate thumbnails. Runs in the background (a large library is a lot
	// of decodes) and exactly once, gated by a kv flag; best-effort, keeps
	// the original bytes on any decode failure.
	httputil.SafeGo("main: image migration", func() {
		img.MigrateExisting(
			library.DefaultImageDir,
			func() (bool, error) { return db.GetKVBool(sqlDB, "images_optimized_v1") },
			func() error { return db.SetKVBool(sqlDB, "images_optimized_v1", true) },
			log.Printf,
		)
	})

	// Phase 2f (#901): wire the share-card renderer's two cross-domain
	// lookups (lib/card.js does both through a lazy require + try/catch).
	// Closures keep internal/shots from importing internal/db or
	// internal/library.
	shotsHandlers.SetCardDeps(
		func() string {
			id, err := db.EnsureInstallID(sqlDB)
			if err != nil || id == "" {
				return ""
			}
			return shots.InstallCodeFor(id)
		},
		func(coffeeName string) string { return library.ResolveBeanOriginCode(coffeeName, libRepo) },
	)

	// Phase 2g (#901): fire-and-forget bean-region geocoding
	// (lib/geo.js + LibraryService.geocodeBean). library.CreateBean/
	// UpdateBean call library.GeocodeHook un-awaited when a bean's region
	// is set/changed — the Go equivalent of routes/library/beans.js's
	// `libraryService.geocodeBean(id).catch(() => {})`. Set here (nil in
	// tests) to keep those functions' signatures unchanged.
	geocoder := library.NewGeocoder(libRepo)
	library.GeocodeHook = func(beanID int64, _, _ string) {
		geocoder.GeocodeBean(context.Background(), beanID)
	}

	// Phase 2c (#901): the bean-import domain — GET /api/import/url plus
	// GET/POST /api/import/settings. beans is the loadLibrary().beans lookup
	// routes/import.js's duplicate-warning check needs, passed as a callback
	// (not a library import) the same way library.GeocodeHook is wired below.
	importerHandlers := importer.NewHandlers(importer.NewRepository(sqlDB), func() []map[string]any {
		lib, err := libRepo.GetLibrary()
		if err != nil {
			return nil
		}
		return lib.Beans
	})
	importerHandlers.RegisterRoutes(mux)

	registry := machines.NewRegistry(sqlDB)
	// ports server.js's startup registry.logRegistrySnapshot() (#714) --
	// behind debug_logging (#977 follow-up), so it's a no-op unless that
	// option is on. Unlike Node, nothing has necessarily called
	// EnsureDefaultMachine yet at this point (it's a lazy, per-request call
	// in this Go port — see its own doc comment), so a genuinely fresh /data
	// can log "(none)" here even though the default machine appears a
	// moment later on the first real request.
	registry.LogRegistrySnapshot()
	profilesRepo := machines.NewProfilesRepository(sqlDB)
	machinesHandlers := machines.NewHandlers(registry, hub, profilesRepo)
	machinesHandlers.RegisterRoutes(mux)

	// Phase 2e (#901): routes/debug.js — GET /api/debug/export-db,
	// POST /api/debug/import-db — plus routes/system.js's H2 GET
	// /api/debug/machine. All three (and the two ingress routes below) are
	// gated on GLP_DEV_BUILD (#1051: previously /api/debug/machine and the
	// ingress routes used a NODE_ENV != production check instead, but
	// nothing in the shipped image ever sets NODE_ENV, so they were live on
	// every real install). importDB's own http.MaxBytesReader is the
	// route-scoped 500 MB body ceiling server.js:192 sets with
	// express.raw({ limit: '500mb' }) — see the handler-chain comment below
	// and go/internal/debug/debug.go.
	//
	// Phase 3 (#901): GET /api/debug/ingress (+ /sse-probe) — a Go-only
	// HA-ingress self-diagnostic for opening through the real HA panel, same
	// GLP_DEV_BUILD gating as /api/debug/machine. See
	// go/internal/debug/ingress.go.
	debug.NewHandlers(sqlDB, dbPath, registry).RegisterRoutes(mux)

	haClient := ha.NewClientFromEnv()
	ordersRepo := orders.NewRepository(sqlDB)
	ordersHandlers := orders.NewHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient)
	ordersHandlers.RegisterRoutes(mux)

	// Phase 1g (#901): the background polling loop that backs
	// GET /api/machine/status, GET /api/live/data, GET/POST /api/preheat*,
	// and the live-snapshot/preheat-update SSE events — see
	// internal/system/doc.go for the full scope and what it deliberately
	// doesn't port. poller.Start launches its own 30s HA-check/preheat
	// tickers bound to ctx; the process runs until the OS kills it (no
	// graceful-shutdown signal handling exists in this binary yet, same as
	// every other domain package here), so ctx is background — cancelling
	// it would only matter for a future clean-shutdown path.
	poller := system.NewPoller(registry, machinesHandlers, hub, haClient)
	// Phase 2a (#901): POST /api/sync's manual shot-history pull loop
	// persists through shotsRepo — see go/internal/system/sync.go.
	poller.SetShotsRepo(shotsRepo)
	// Offline profile editor (2026-09-09): pushes locally-saved profile
	// edits to the machine on reconnect/after a brew/periodically — see
	// go/internal/system/profile_sync.go.
	poller.SetProfilesRepo(profilesRepo)

	// Phase 2d (#901): MQTT live-data transport (#608). mqttRepo is the
	// Settings-page toggle + broker connection (kv.key = 'mqtt_settings', no
	// migration needed). mqttTransport is lib/live-transport.js's dispatch
	// seam — wired into the poller so the default machine's live reads go to
	// the MQTT subscription instead of the adapter's WS session whenever the
	// toggle selects it. The 4 /api/mqtt/* routes reuse machinesHandlers'
	// GetAdapter (apply-to-machine) and haClient's Supervisor access
	// (discovery).
	mqttRepo := mqtt.NewRepository(sqlDB)
	mqttTransport := mqtt.NewTransport(mqtt.NewClient(), mqttRepo)
	poller.SetLiveTransport(mqttTransport)
	mqtt.NewHandlers(mqttRepo, mqttTransport, registry, machinesHandlers, haClient).RegisterRoutes(mux)

	poller.Start(ctx)

	// #1152: Node ran purgeExpiredTrash once at startup and then every 24h
	// (server.js's startup call + its setInterval). StartTrashPurge mirrors
	// both — the immediate purge plus a 24h ticker bound to ctx.
	shots.StartTrashPurge(ctx, shots.NewService(shotsRepo), 24*time.Hour)

	// Closes internal/orders' shop-broadcast deferral (see
	// internal/orders/doc.go and internal/system/doc.go's "internal/orders'
	// shop-broadcast" section for why this is a callback, not an import).
	ordersHandlers.SetPreheatInfoProvider(poller.PreheatInfo)

	demoService := system.NewDemoService(sqlDB, shotsRepo, libRepo)
	systemHandlers := system.NewHandlers(poller, demoService, token)
	systemHandlers.RegisterRoutes(mux)

	// routes/sse.js primes a newly-connected client with the current
	// preheat/live snapshot before subscribing it to future pushes — see
	// the Prime field's doc comment above.
	sseHandler.Prime = func() []sse.Event {
		return []sse.Event{
			{Type: sse.EventPreheatUpdate, Data: poller.PreheatStatus()},
			{Type: sse.EventLiveSnapshot, Data: poller.LiveData()},
		}
	}

	maintenanceRepo := maintenance.NewRepository(sqlDB, libRepo)
	maintenanceHandlers := maintenance.NewHandlers(maintenanceRepo, shotsRepo, libRepo, registry)
	maintenanceHandlers.RegisterRoutes(mux)
	// #901 (Phase 1f): closes the Phase 1d gap flagged in
	// internal/library/doc.go — deleting a grinder now also removes its
	// `grinder_{id}` maintenance-table row, via a callback (not a direct
	// import) since internal/maintenance already imports internal/library.
	libraryHandlers.SetOnGrinderDeleted(maintenanceRepo.DeleteGrinderTask)

	// #1136: a firmware update triggered from the app shows up in the
	// machine's maintenance log. Wired as a callback (not a direct import)
	// for the same import-cycle reason as the grinder-delete hook above --
	// internal/maintenance already imports internal/machines. The note records
	// the from/to firmware versions (best-effort: either may be blank) and the
	// shot count is scoped to the machine like every other non-global task,
	// reusing maintenance.ShotCountFor rather than duplicating the logic.
	machinesHandlers.SetOnFirmwareUpdate(func(m *machines.Machine, from, to string) error {
		notes := maintenance.FirmwareUpdateNote(from, to)
		shotCount := maintenance.ShotCountFor(shotsRepo, "firmware_update", m.ID)
		_, err := maintenanceRepo.AddMaintenanceLogEntry("firmware_update", notes, m.Host, shotCount, m.ID)
		return err
	})

	// MCP (#1196): the Model Context Protocol server is off by default; when
	// enabled, mount its streamable-HTTP endpoint under /api/ so auth.RequireToken
	// guards it with X-GLP-Token like every other API route. Registered here —
	// after the library, registry, poller and maintenance wiring — so the
	// read-only library/status/analytics tools get their dependencies.
	if mcp.Enabled() {
		mux.Handle(mcp.Path, mcp.NewHandler(mcp.Deps{
			Shots:               shots.NewService(shotsRepo),
			ShotsRepo:           shotsRepo,
			Library:             libRepo,
			Maintenance:         maintenanceRepo,
			Registry:            registry,
			Poller:              poller,
			Logs:                cfg.logs,
			Sync:                poller,
			Preheat:             poller,
			Version:             system.Version(),
			RateLimitWindow:     rateLimitWindow,
			RateLimitMax:        rateLimitMax,
			AllowWrite:          mcp.WriteEnabled(),
			AllowDeveloperTools: mcp.DeveloperToolsEnabled(),
		}))
	}

	// Phase 2b (#901): the achievements ("stamp card") domain —
	// GET /api/achievements. A pure-logic port reading across shots,
	// library, orders, maintenance, machines and the cached version check
	// (systemHandlers.CachedVersion, via a callback — no cross-domain
	// import). See go/internal/achievements/doc.go, incl. the documented
	// "no event bus" deviation (evaluate-before-read instead).
	achievementsRepo := achievements.NewRepository(sqlDB)
	achievementsSvc := achievements.NewService(achievementsRepo, achievements.Deps{
		Shots:       shotsRepo,
		Library:     libRepo,
		Orders:      ordersRepo,
		Maintenance: maintenanceRepo,
		Registry:    registry,
		VersionFn: func() achievements.VersionCache {
			latest, updateAvailable := systemHandlers.CachedVersion()
			return achievements.VersionCache{Latest: latest, UpdateAvailable: updateAvailable}
		},
	})
	achievements.NewHandlers(achievementsSvc).RegisterRoutes(mux)

	backupHandlers := backup.NewHandlers(backup.Dependencies{
		DB:               sqlDB,
		ShotsRepo:        shotsRepo,
		LibRepo:          libRepo,
		OrdersRepo:       ordersRepo,
		MaintenanceRepo:  maintenanceRepo,
		Registry:         registry,
		AchievementsRepo: achievementsRepo,
		// Token/TokenFile: a restored API token is persisted to
		// tokenPath but does NOT take effect in this already-running
		// process — see backup.Dependencies.Token's doc comment.
		Token:     token,
		TokenFile: tokenPath,
	})
	backupHandlers.RegisterRoutes(mux)

	// Phase 1 (#901): the production frontend. internal/webapp embeds and
	// serves the existing Vite SPA bundle (gaggiuino-local-profiler/
	// public-src, built to public/) — byte-for-byte the UI the Node app
	// serves today, REST+SSE only, all relative paths. Registered last so
	// its catch-all "GET /" only ever runs for paths no more-specific
	// pattern (every /api/* route, /shots.json) claimed. Same
	// registration-outside-/api/ auth model as those: GET falls through
	// auth.RequireToken's static-asset bypass, exactly as the Node app's own
	// express.static frontend does. See internal/webapp/doc.go.
	webapp.NewHandlers().RegisterRoutes(mux)

	if onMux != nil {
		onMux(mux)
	}

	limiter := ratelimit.New(rateLimitWindow, rateLimitMax)

	// server.js's ACTUAL app.use() order — security headers (lines ~83-98),
	// then the app-level rate limiter (line 104, deliberately ahead of auth
	// so it also caps unauthenticated login/token-probing traffic, per
	// lib/middleware/rateLimit.js's own comment), then token auth
	// (lines ~144-173). Read from the innermost handler outward, this chain
	// applies auth first, rate-limit second, security headers last, which
	// is the correct nesting to make requests experience them in that
	// server.js order.
	//
	// server.js's body-parser step (lines ~178-193) has no Go equivalent to
	// slot in here: net/http reads a request body lazily per-handler, not
	// through a chained global middleware, so there is nothing to add yet.
	// Phase 1c's handlers each bound their own request body size per-route
	// the way routes/backup.js's /api/restore and routes/debug.js's
	// /api/debug/import-db use route-scoped express.json()/express.raw()
	// limits today — internal/debug's importDB, for one, wraps its body in
	// http.MaxBytesReader at server.js:192's exact 500 MB ceiling.
	handler := auth.SecurityHeaders(
		limiter.Middleware(
			auth.RequireToken(token)(mux),
		),
	)

	return handler, sqlDB, nil
}

func getEnv(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

// getEnvNumber ports lib/middleware/rateLimit.js's
// `Number(process.env.X) || default` pattern for GLP_RATE_LIMIT_WINDOW_MS/
// GLP_RATE_LIMIT_MAX: an unset env var, one that fails to parse as a number
// (JS's Number() returns NaN, which is falsy), or one that parses to 0
// (also falsy in JS) all fall back to def — matching the Node original's
// behavior exactly, including that a literal "0" override is treated the
// same as no override.
func getEnvNumber(name string, def float64) float64 {
	v, ok := os.LookupEnv(name)
	if !ok {
		return def
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n == 0 {
		return def
	}
	return n
}

// tcpNoDelayListener explicitly disables Nagle's algorithm on every
// accepted connection. routes/sse.js's #740 fix (res.socket.setNoDelay(true))
// has no real equivalent to port here: Go's net.TCPConn already defaults
// NoDelay to true for every connection Go's own net package creates (see
// net.TCPConn.SetNoDelay's doc comment) — Node's net.Socket defaults the
// other way, which is the only reason that explicit call exists there. This
// wrapper is defense-in-depth that makes the guarantee explicit at the
// listener level for every connection this process accepts, rather than a
// port of Node's per-connection workaround (see internal/sse/doc.go).
type tcpNoDelayListener struct{ net.Listener }

func (l tcpNoDelayListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return conn, err
	}
	if tcpConn, ok := conn.(*net.TCPConn); ok {
		_ = tcpConn.SetNoDelay(true)
	}
	return conn, nil
}
