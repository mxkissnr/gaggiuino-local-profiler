// Command server is the HTTP bootstrap: it wires internal/db, internal/auth,
// internal/ratelimit, internal/sse, internal/shots, internal/library,
// internal/machines, internal/orders, internal/maintenance, internal/backup,
// internal/ha, and internal/system together into a real net/http server; the
// handler chain below documents the middleware order.
//
// Every REST domain package now exists and is registered: GET /api/events,
// /shots.json + /api/shots/*, /api/library/*, the machine-registry +
// machine-control + machine-profile domain, /api/orders/*,
// /api/maintenance/*, GET/POST /api/backup + POST /api/restore, and
// internal/system's GET /api/machine/status, GET /api/live/data,
// GET/POST /api/preheat*, GET /api/version, POST /api/demo/{seed,end} plus
// the background polling loop that backs them. A handful of system routes
// remain unrouted by design — see go/internal/system/doc.go's "Scope"
// section for exactly which and why (none of them are depended on by
// anything shipped). #977: this binary is now the repo-root Dockerfile's own
// CMD (glp-server) — it is the sole shipping entrypoint for every real
// install as of this cutover; the legacy server is no longer built or run in
// the production image.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
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
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/config"
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
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/uiprefs"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/webapp"
)

// defaultPort is the port the add-on exposes (8099), confirmed against
// config.yaml's exposed add-on port. Overridable via GLP_PORT for local/dev
// runs of this binary outside the add-on container, same pattern as
// dbPath/tokenPath below.
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
	// allowedHosts are extra exact Host names the app will answer for, beyond
	// the always-allowed IP literals, localhost, single-label names and
	// .local names — from options.json's allowed_hosts plus
	// GLP_ALLOWED_HOSTS. #1430.
	allowedHosts    []string
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
		allowedHosts:    auth.ParseAllowedHosts(readAllowedHostsOption() + " " + os.Getenv("GLP_ALLOWED_HOSTS")),
	}
}

// readAllowedHostsOption reads options.json's allowed_hosts string (the
// Supervisor-written add-on option, see config.yaml). A missing file,
// unparseable JSON or an absent key all yield "" — the same
// fail-open-to-empty behaviour the other option readers rely on, so an
// install with no extra hosts behaves exactly as before #1430.
func readAllowedHostsOption() string {
	data, err := os.ReadFile(config.OptionsFile)
	if err != nil {
		return ""
	}
	var opts struct {
		AllowedHosts string `json:"allowed_hosts"`
	}
	if err := json.Unmarshal(data, &opts); err != nil {
		return ""
	}
	return opts.AllowedHosts
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
// chain. Extracted from main() so cmd/server's HA-ingress smoke test can
// exercise the real middleware stack + real handlers end to end. ctx bounds
// the background poller's tickers — cancelling it shuts the poller (and its
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
	// Prime is wired below, once poller exists: it primes a newly-connected
	// client with the current preheat-update/live-snapshot snapshot
	// (buildPreheatResponse()/buildLiveDataResponse(), both synchronous reads)
	// before subscribing it to the Hub. The sync-progress priming loop has no
	// equivalent yet (state.syncProgress isn't implemented — see
	// internal/system/doc.go).

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
		// #1525: reclaim image files (and their thumbnails) no library entry
		// or existing shot refers to — leftovers from deleted entries, purged
		// shots and old renames. Runs after the migration so a photo it just
		// generated a thumbnail for is already referenced. A failed reference
		// lookup removes nothing.
		backup.CleanupOrphanedImages(library.DefaultImageDir, libRepo, shotsRepo, log.Printf)
	})

	// Wire the share-card renderer's two cross-domain lookups. Closures keep
	// internal/shots from importing internal/db or internal/library.
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

	// Fire-and-forget bean-region geocoding: library.CreateBean/UpdateBean
	// call library.GeocodeHook without waiting when a bean's region is
	// set/changed. Set here (nil in tests) to keep those functions'
	// signatures unchanged.
	geocoder := library.NewGeocoder(libRepo)
	library.GeocodeHook = func(beanID int64, _, _ string) {
		geocoder.GeocodeBean(context.Background(), beanID)
	}

	// The bean-import domain — GET /api/import/url plus GET/POST
	// /api/import/settings. beans is the loadLibrary().beans lookup the
	// duplicate-warning check needs, passed as a callback (not a library
	// import) the same way library.GeocodeHook is wired above.
	importerHandlers := importer.NewHandlers(importer.NewRepository(sqlDB), func() []map[string]any {
		lib, err := libRepo.GetLibrary()
		if err != nil {
			return nil
		}
		return lib.Beans
	})
	importerHandlers.RegisterRoutes(mux)

	registry := machines.NewRegistry(sqlDB)
	// Startup logRegistrySnapshot() (#714) — behind debug_logging (#977
	// follow-up), so it's a no-op unless that option is on. Nothing has
	// necessarily called EnsureDefaultMachine yet at this point (it's a lazy,
	// per-request call — see its own doc comment), so a genuinely fresh /data
	// can log "(none)" here even though the default machine appears a moment
	// later on the first real request.
	registry.LogRegistrySnapshot()
	profilesRepo := machines.NewProfilesRepository(sqlDB)
	machinesHandlers := machines.NewHandlers(registry, hub, profilesRepo)
	machinesHandlers.RegisterRoutes(mux)

	// The debug domain — GET /api/debug/export-db, POST /api/debug/import-db,
	// GET /api/debug/machine, and GET /api/debug/ingress (+ /sse-probe), a
	// Go-only HA-ingress self-diagnostic for opening through the real HA
	// panel. All of them (and the two ingress routes below) are gated on
	// GLP_DEV_BUILD (#1051: previously /api/debug/machine and the ingress
	// routes used a NODE_ENV != production check instead, but nothing in the
	// shipped image ever sets NODE_ENV, so they were live on every real
	// install). importDB's own http.MaxBytesReader is the route-scoped 500 MB
	// body ceiling — see the handler-chain comment below and
	// go/internal/debug/debug.go.
	debug.NewHandlers(sqlDB, dbPath, registry).RegisterRoutes(mux)

	haClient := ha.NewClientFromEnv()
	ordersRepo := orders.NewRepository(sqlDB)
	// #1411: annotating a shot books milk stock and frozen-portion counts on
	// the server inside the same locked save; injected here because
	// internal/shots cannot import internal/library or internal/orders, like
	// SetBeanSource.
	shots.SetAnnotationStockHook(func(prev, next map[string]any) error {
		return library.ApplyAnnotationStock(libRepo, ordersRepo.GetMenu, prev, next)
	})
	ordersHandlers := orders.NewHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient)
	ordersHandlers.RegisterRoutes(mux)

	// The background polling loop that backs GET /api/machine/status,
	// GET /api/live/data, GET/POST /api/preheat*, and the
	// live-snapshot/preheat-update SSE events — see internal/system/doc.go
	// for the full scope and what it deliberately leaves out. poller.Start
	// launches its own 30s HA-check/preheat tickers bound to ctx; the process
	// runs until the OS kills it (no graceful-shutdown signal handling exists
	// in this binary yet, same as every other domain package here), so ctx is
	// background — cancelling it would only matter for a future
	// clean-shutdown path.
	poller := system.NewPoller(registry, machinesHandlers, hub, haClient)
	// #1409: a GaggiMate firmware v1.9.0+ evt:history-shot-saved frame syncs the
	// default machine's shot history right away instead of waiting for the
	// post-brew timer. The hook hand-offs to SafeGo inside SyncAfterShotSaved.
	machinesHandlers.SetOnShotSaved(poller.SyncAfterShotSaved)
	// #1543: a default-machine switch while the new default is already on
	// would otherwise leave the preheat countdown stuck at the full window;
	// reset the poller's preheat session for the new default.
	machinesHandlers.SetOnDefaultChanged(poller.HandleDefaultMachineChange)
	// POST /api/sync's manual shot-history pull loop persists through
	// shotsRepo — see go/internal/system/sync.go.
	poller.SetShotsRepo(shotsRepo)
	// Offline profile editor (2026-09-09): pushes locally-saved profile
	// edits to the machine on reconnect/after a brew/periodically — see
	// go/internal/system/profile_sync.go.
	poller.SetProfilesRepo(profilesRepo)

	// MQTT live-data transport (#608). mqttRepo is the Settings-page toggle +
	// broker connection (kv.key = 'mqtt_settings', no migration needed).
	// mqttTransport is the transport dispatch seam — wired into the poller so
	// the default machine's live reads go to the MQTT subscription instead of
	// the adapter's WS session whenever the toggle selects it. The 4
	// /api/mqtt/* routes reuse machinesHandlers' GetAdapter
	// (apply-to-machine) and haClient's Supervisor access (discovery).
	mqttRepo := mqtt.NewRepository(sqlDB)
	mqttTransport := mqtt.NewTransport(mqtt.NewClient(), mqttRepo)
	poller.SetLiveTransport(mqttTransport)
	mqtt.NewHandlers(mqttRepo, mqttTransport, registry, machinesHandlers, haClient).RegisterRoutes(mux)

	poller.Start(ctx)

	// #1152: purge expired trash once at startup and then every 24h —
	// StartTrashPurge does the immediate purge plus a 24h ticker bound to ctx.
	shots.StartTrashPurge(ctx, shots.NewService(shotsRepo), 24*time.Hour)

	// Closes internal/orders' shop-broadcast deferral (see
	// internal/orders/doc.go and internal/system/doc.go's "internal/orders'
	// shop-broadcast" section for why this is a callback, not an import).
	ordersHandlers.SetPreheatInfoProvider(poller.PreheatInfo)

	demoService := system.NewDemoService(sqlDB, shotsRepo, libRepo)
	systemHandlers := system.NewHandlers(poller, demoService, token)
	systemHandlers.RegisterRoutes(mux)

	// #1375: per-install UI choices (view/filter/sort) that follow the user
	// across devices, kept in the kv table under 'ui_prefs'.
	uiprefsHandlers := uiprefs.NewHandlers(uiprefs.NewRepository(sqlDB))
	uiprefsHandlers.RegisterRoutes(mux)

	// Prime a newly-connected client with the current preheat/live snapshot
	// before subscribing it to future pushes — see the Prime field's doc
	// comment above.
	sseHandler.Prime = func() []sse.Event {
		return []sse.Event{
			{Type: sse.EventPreheatUpdate, Data: poller.PreheatStatus()},
			{Type: sse.EventLiveSnapshot, Data: poller.LiveData()},
		}
	}

	maintenanceRepo := maintenance.NewRepository(sqlDB, libRepo)
	maintenanceHandlers := maintenance.NewHandlers(maintenanceRepo, shotsRepo, libRepo, registry)
	maintenanceHandlers.RegisterRoutes(mux)
	// Deleting a grinder now also removes its `grinder_{id}` maintenance-table
	// row, via a callback (not a direct import) since internal/maintenance
	// already imports internal/library (the gap flagged in
	// internal/library/doc.go).
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

	// MCP (#1196, #1288): the Model Context Protocol server is always mounted
	// under /api/ so auth.RequireToken guards it with X-GLP-Token like every
	// other API route. Whether it answers is decided per request from the
	// app-database-backed 'mcp_settings' row: while disabled it 404s, and
	// enabling it (or its write/developer opt-ins) via GET/POST
	// /api/mcp/settings takes effect without a restart. Registered here —
	// after the library, registry, poller and maintenance wiring — so the
	// read-only library/status/analytics tools get their dependencies.
	mcpRepo := mcp.NewRepository(sqlDB)
	mux.Handle(mcp.Path, mcp.NewHandler(mcp.Deps{
		Shots:           shots.NewService(shotsRepo),
		ShotsRepo:       shotsRepo,
		Library:         libRepo,
		Maintenance:     maintenanceRepo,
		Registry:        registry,
		Poller:          poller,
		Logs:            cfg.logs,
		Sync:            poller,
		Preheat:         poller,
		Version:         system.Version(),
		RateLimitWindow: rateLimitWindow,
		RateLimitMax:    rateLimitMax,
		Settings:        mcpRepo,
	}))
	mcp.NewSettingsHandlers(mcpRepo).RegisterRoutes(mux)

	// The achievements ("stamp card") domain — GET /api/achievements. Pure
	// logic reading across shots, library, orders, maintenance, machines and
	// the cached version check (systemHandlers.CachedVersion, via a callback
	// — no cross-domain import). See go/internal/achievements/doc.go, incl.
	// the documented "no event bus" design (evaluate-before-read instead).
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

	// #1286: the achievements domain has no event bus, so the four live-moment
	// badges are driven by explicit callbacks. R1 wired the two profile badges
	// (first_profile/profile_edit) from the machines handlers once a profile
	// create/update has fully succeeded; R2 wires the backup and restock badges
	// from the backup/library handlers (see those packages' SetOn* setters).
	// Best-effort: an EvaluateEvent failure is logged only -- the originating
	// request itself already succeeded and must not be affected.
	machinesHandlers.SetOnProfileSaved(func(action string) {
		if _, err := achievementsSvc.EvaluateEvent(&achievements.Event{
			Type:    "profile-saved",
			Payload: map[string]any{"action": action},
		}); err != nil {
			log.Printf("achievements: evaluating profile-saved %q failed: %v", action, err)
		}
	})
	libraryHandlers.SetOnBeanRestocked(func(wasEmpty bool) {
		if _, err := achievementsSvc.EvaluateEvent(&achievements.Event{
			Type:    "bean-changed",
			Payload: map[string]any{"reason": "restock", "wasEmpty": wasEmpty},
		}); err != nil {
			log.Printf("achievements: evaluating bean-changed restock (wasEmpty=%t) failed: %v", wasEmpty, err)
		}
	})

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
	backupHandlers.SetOnExported(func() {
		if _, err := achievementsSvc.EvaluateEvent(&achievements.Event{Type: "backup-exported"}); err != nil {
			log.Printf("achievements: evaluating backup-exported failed: %v", err)
		}
	})

	// The production frontend. internal/webapp embeds and serves the existing
	// Vite SPA bundle (gaggiuino-local-profiler/public-src, built to public/)
	// — REST+SSE only, all relative paths. Registered last so its catch-all
	// "GET /" only ever runs for paths no more-specific pattern (every /api/*
	// route, /shots.json) claimed. Same registration-outside-/api/ auth model
	// as those: GET falls through auth.RequireToken's static-asset bypass,
	// exactly as the static frontend always has. See internal/webapp/doc.go.
	webapp.NewHandlers().RegisterRoutes(mux)
	// The on-device cut-out models, served same-origin for the browser to fetch
	// before it has a token. GLP_MODELS_DIR is the download-on-first-use cache
	// dir: the first GET for a model downloads it from the pinned glp-models
	// release into that dir. It is unset outside the image, which disables the
	// route (every request 404s).
	webapp.NewModelHandlers(getEnv("GLP_MODELS_DIR", "")).RegisterRoutes(mux)

	if onMux != nil {
		onMux(mux)
	}

	limiter := ratelimit.New(rateLimitWindow, rateLimitMax)

	// The middleware order: security headers, then the known-host check, then
	// the app-level rate limiter (deliberately ahead of auth so it also caps
	// unauthenticated login/token-probing traffic), then token auth. Read from
	// the innermost handler outward, this chain applies auth first, rate-limit
	// second, the known-host check third and security headers last, which is
	// the correct nesting to make requests experience them in that order.
	//
	// auth.RequireKnownHost sits ahead of the rate limiter on purpose: a
	// request for an unknown Host is refused with 421 before it costs a
	// rate-limit slot or reaches any handler, including the public
	// GET /api/token.
	//
	// There is no global body-parser step to slot in here: net/http reads a
	// request body lazily per-handler, not through a chained global
	// middleware, so there is nothing to add. Instead each handler bounds its
	// own request body size per-route — internal/debug's importDB, for one,
	// wraps its body in http.MaxBytesReader at the 500 MB ceiling.
	handler := auth.SecurityHeaders(
		auth.RequireKnownHost(cfg.allowedHosts)(
			limiter.Middleware(
				auth.RequireToken(token)(mux),
			),
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

// getEnvNumber parses GLP_RATE_LIMIT_WINDOW_MS/GLP_RATE_LIMIT_MAX: an unset
// env var, one that fails to parse as a number, or one that parses to 0 all
// fall back to def, including that a literal "0" override is treated the same
// as no override.
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
// accepted connection. Go's net.TCPConn already defaults NoDelay to true for
// every connection Go's own net package creates (see
// net.TCPConn.SetNoDelay's doc comment), so this wrapper is defense-in-depth
// that makes the guarantee explicit at the listener level for every
// connection this process accepts (see internal/sse/doc.go).
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
