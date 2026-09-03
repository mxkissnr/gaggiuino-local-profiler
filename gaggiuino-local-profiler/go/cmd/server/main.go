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
// (none of them are depended on by anything this phase ported). This
// binary is not wired into the Docker image, CI, or the running add-on;
// the Node app (server.js) remains the sole shipping entrypoint until the
// rollout plan in go/README.md says otherwise.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/achievements"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/auth"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/backup"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/db"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/debug"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ha"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/img"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/importer"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/library"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/machines"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/maintenance"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/mqtt"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/orders"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/ratelimit"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/shots"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/sse"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/system"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/web"
	"github.com/mxkissnr/gaggiuino-local-profiler/go/internal/webapp"
)

// defaultPort matches lib/constants.js's DEFAULT_PORT (8099) — the port the
// Node app listens on today, confirmed against config.yaml's exposed add-on
// port. Overridable via GLP_PORT for local/dev runs of this binary outside
// the add-on container, same pattern as dbPath/tokenPath below.
const defaultPort = "8099"

// appConfig is the resolved runtime configuration buildApp needs — every
// field is an env-var read in production (configFromEnv) and an explicit
// value in tests (cmd/server's smoke test).
type appConfig struct {
	dbPath          string
	tokenPath       string
	port            string
	rateLimitWindow time.Duration
	rateLimitMax    int
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
	cfg := configFromEnv()

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

	log.Printf("GLP Go server listening on port %s", cfg.port)
	srv := &http.Server{Handler: handler}
	if err := srv.Serve(tcpNoDelayListener{ln}); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}

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

	// Phase 1 (#901): internal/web's templ pages are no longer the app's
	// primary UI — internal/webapp serves the production Vite SPA at the
	// root (see below). The templ pages are frozen as a no-JS fallback view
	// and move behind a /ui/ prefix: they register on this dedicated
	// sub-mux, which mux mounts under /ui/ via http.StripPrefix after every
	// web.*Handlers has registered. StripPrefix removes the "/ui" segment
	// before the sub-mux matches, so "GET /shots" inside internal/web is
	// reached as GET /ui/shots, "GET /web/static/..." as GET
	// /ui/web/static/..., etc. — every relative href/hx-* in those templates
	// still resolves correctly because the whole route subtree moved one
	// segment deeper together (see internal/web.Handlers.RegisterRoutes).
	uiMux := http.NewServeMux()
	// Bare GET /ui/ -> the first templ page, via a genuinely relative
	// Location so the browser resolves it against its own address bar
	// (Ingress prefix included), not the origin root — the same reasoning
	// internal/web/static/glp-token.js's doc comment spells out. After
	// StripPrefix this handler sees the path as "/".
	uiMux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "shots")
		w.WriteHeader(http.StatusFound)
	})

	shotsRepo := shots.NewRepository(sqlDB)
	shotsHandlers := shots.NewHandlers(shotsRepo)
	shotsHandlers.RegisterRoutes(mux)

	// Phase 2a (#901): the Go frontend foundation — GET /shots plus its two
	// htmx trash/restore actions, built on the same shots.Service the JSON
	// API above uses. Not yet reachable in production (this binary isn't
	// wired into the Docker image/CI — see go/README.md). Registered
	// outside /api/ so the read-only GET falls through auth.RequireToken's
	// static-asset bypass; the two POST actions do NOT get that bypass
	// (RequireToken scopes it to GET/HEAD) and require the same
	// token/Ingress trust the JSON API does — see internal/web/doc.go's
	// "Auth model" section.
	webHandlers := web.NewHandlers(shots.NewService(shotsRepo))
	webHandlers.RegisterRoutes(uiMux)

	libRepo := library.NewRepository(sqlDB)
	libraryHandlers := library.NewHandlers(libRepo, shotsRepo)
	libraryHandlers.RegisterRoutes(mux)

	// #961: one-time optimization of an already-populated image library —
	// downscale oversized JPEG/PNG photos, strip their metadata, and
	// generate thumbnails. Runs in the background (a large library is a lot
	// of decodes) and exactly once, gated by a kv flag; best-effort, keeps
	// the original bytes on any decode failure.
	go img.MigrateExisting(
		library.DefaultImageDir,
		func() (bool, error) { return db.GetKVBool(sqlDB, "images_optimized_v1") },
		func() error { return db.SetKVBool(sqlDB, "images_optimized_v1", true) },
		log.Printf,
	)

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

	// Phase 2b (#901): the Library domain's Go frontend pages — Beans (plus
	// its one htmx write action, toggle-active) and read-only lists for
	// Grinders/Baskets/Puck Screens/Milks/Recipes, built on the same
	// library.Repository/shots.Repository the JSON API above uses. Same
	// registration-outside-/api/ auth model as webHandlers above — see
	// internal/web/doc.go's "Auth model" section.
	webLibraryHandlers := web.NewLibraryHandlers(libRepo, shotsRepo)
	webLibraryHandlers.RegisterRoutes(uiMux)

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
	machinesHandlers := machines.NewHandlers(registry, hub)
	machinesHandlers.RegisterRoutes(mux)

	// Phase 2e (#901): routes/debug.js — GET /api/debug/export-db,
	// POST /api/debug/import-db (both gated on GLP_DEV_BUILD) — plus
	// routes/system.js's H2 GET /api/debug/machine (registered only when
	// NODE_ENV !== 'production'). importDB's own http.MaxBytesReader is the
	// route-scoped 500 MB body ceiling server.js:192 sets with
	// express.raw({ limit: '500mb' }) — see the handler-chain comment below
	// and go/internal/debug/debug.go.
	//
	// Phase 3 (#901): GET /api/debug/ingress (+ /sse-probe) — a Go-only
	// HA-ingress self-diagnostic for opening through the real HA panel, same
	// NODE_ENV != production gating as /api/debug/machine. See
	// go/internal/debug/ingress.go.
	debug.NewHandlers(sqlDB, dbPath, registry).RegisterRoutes(mux)

	haClient := ha.NewClientFromEnv()
	ordersRepo := orders.NewRepository(sqlDB)
	ordersHandlers := orders.NewHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient)
	ordersHandlers.RegisterRoutes(mux)

	// Phase 2d (#901): the Orders domain's Go frontend pages — the barista
	// queue (GET /orders, with accept/complete/decline htmx actions) and the
	// customer ordering form (GET /menu, with its one write action) — built
	// on the same orders.Repository/Service dependencies the JSON API above
	// uses, via its own *orders.Service instance (see
	// internal/web/handlers_orders.go's own doc comment for why a second
	// instance, not ordersHandlers' internal one). Same
	// registration-outside-/api/ auth model as every other web.*Handlers.
	// hub (the same one wired into sseHandler above) lets that second
	// Service instance's OnQueueChanged callback push a live orders-update
	// SSE event to every open /orders tab (#901, a later pass — see
	// templates/orders.templ's own doc comment).
	webOrdersHandlers := web.NewOrdersHandlers(ordersRepo, shotsRepo, libRepo, registry, haClient, hub)
	webOrdersHandlers.RegisterRoutes(uiMux)

	// #901 code review (CONFIRMED finding #2): ordersHandlers (REST, above)
	// and webOrdersHandlers each own an independent *orders.Service — only
	// the web one had OnQueueChanged wired, so an order mutated through the
	// REST API alone (glp-integration, or any other external client) never
	// published a live orders-update event. Wire the same publish function
	// onto the REST instance's Service too, closing that gap without
	// collapsing the two Service instances into one — see
	// orders.Handlers.Service's and web.OrdersHandlers.PublishQueueUpdate's
	// own doc comments for why two instances sharing one publish function is
	// the chosen fix, not a shared-instance refactor.
	ordersHandlers.Service().OnQueueChanged = webOrdersHandlers.PublishQueueUpdate

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
	// Closes internal/orders' shop-broadcast deferral (see
	// internal/orders/doc.go and internal/system/doc.go's "internal/orders'
	// shop-broadcast" section for why this is a callback, not an import).
	ordersHandlers.SetPreheatInfoProvider(poller.PreheatInfo)

	demoService := system.NewDemoService(sqlDB, shotsRepo, libRepo)
	systemHandlers := system.NewHandlers(poller, demoService, token)
	systemHandlers.RegisterRoutes(mux)

	// Phase 2c (#901): the Machines domain's Go frontend pages — the
	// machines list (default/reachable badges, set-default and delete htmx
	// actions) plus GET /live, the live shot chart page whose actual chart
	// is a standalone vanilla-JS SSE consumer (static/live.js), not an htmx
	// fragment page — see internal/web/handlers_machines.go and
	// templates/live.templ's own doc comments. poller is passed so the
	// machines list can show the default machine's live reachable status
	// (internal/system.Poller.StatusInfo) and GET /live can name the
	// current default machine. Same registration-outside-/api/ auth model
	// as every other web.*Handlers above.
	webMachinesHandlers := web.NewMachinesHandlers(registry, poller)
	webMachinesHandlers.RegisterRoutes(uiMux)

	// Phase 2e (#901): GET /settings, the default machine's Gaggiuino
	// settings categories (read-only boiler/led/scales/system, editable
	// display), built on machines.Adapter's GetSettings/UpdateSettings via
	// machinesHandlers.GetAdapter — the same *machines.Handlers instance
	// internal/system's poller (above) already shares, not a second one.
	// Same registration-outside-/api/ auth model as every other
	// web.*Handlers. See internal/web/handlers_settings.go's own doc
	// comment for the full scope (one editable category, no per-machine
	// switcher, raw-JSON round trip to preserve the settings bool-as-string
	// quirk unchanged).
	webSettingsHandlers := web.NewSettingsHandlers(registry, machinesHandlers)
	webSettingsHandlers.RegisterRoutes(uiMux)

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

	// Phase 2e (#901): the Maintenance domain's Go frontend page —
	// GET /maintenance (per-machine task list + a machine switcher) plus
	// its one htmx write action, "mark done", built on
	// maintenance.MarkTaskDone (service.go) — the same function
	// maintenanceHandlers' own REST taskDone handler now calls too, so both
	// paths write the identical maintenance_log side effect. Same
	// registration-outside-/api/ auth model as every other web.*Handlers.
	webMaintenanceHandlers := web.NewMaintenanceHandlers(maintenanceRepo, shotsRepo, libRepo, registry)
	webMaintenanceHandlers.RegisterRoutes(uiMux)

	backupHandlers := backup.NewHandlers(backup.Dependencies{
		DB:              sqlDB,
		ShotsRepo:       shotsRepo,
		LibRepo:         libRepo,
		OrdersRepo:      ordersRepo,
		MaintenanceRepo: maintenanceRepo,
		Registry:        registry,
		// Token/TokenFile: a restored API token is persisted to
		// tokenPath but does NOT take effect in this already-running
		// process — see backup.Dependencies.Token's doc comment.
		Token:     token,
		TokenFile: tokenPath,
	})
	backupHandlers.RegisterRoutes(mux)

	// Phase 2e (#901): GET /backup — a download link for the GET /api/backup
	// export above, plus an explicit note that restore isn't built into
	// this page yet. No dependencies: this page only links to the existing
	// backup REST handler, it doesn't call into internal/backup itself. See
	// internal/web/handlers_backup.go's own doc comment for why a full
	// upload+restore UI is deliberately out of this phase's scope.
	webBackupHandlers := web.NewBackupHandlers()
	webBackupHandlers.RegisterRoutes(uiMux)

	// Phase 1 (#901): mount the frozen templ pages under /ui/ now that every
	// web.*Handlers has registered on uiMux. http.StripPrefix("/ui", ...)
	// trims the segment before uiMux matches; ServeMux redirects a bare
	// "/ui" to "/ui/" on its own because of this "/ui/" subtree pattern.
	mux.Handle("/ui/", http.StripPrefix("/ui", uiMux))

	// Phase 1 (#901): the production frontend. internal/webapp embeds and
	// serves the existing Vite SPA bundle (gaggiuino-local-profiler/
	// public-src, built to public/) — byte-for-byte the UI the Node app
	// serves today, REST+SSE only, all relative paths. Registered last so
	// its catch-all "GET /" only ever runs for paths no more-specific
	// pattern (every /api/*, /shots.json, the /ui/ subtree above) claimed.
	// Same registration-outside-/api/ auth model as the templ pages: GET
	// falls through auth.RequireToken's static-asset bypass, exactly as the
	// Node app's own express.static frontend does. See internal/webapp/doc.go.
	webapp.NewHandlers().RegisterRoutes(mux)

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
