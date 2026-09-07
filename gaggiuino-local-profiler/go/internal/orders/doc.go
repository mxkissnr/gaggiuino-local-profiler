// Package orders is the Go port of the barista-orders domain (Phase 1f,
// issue #901): routes/orders.js's REST endpoints and
// lib/services/OrderService.js's queue-ETA and order-lifecycle logic.
//
// glp-integration's orders_api.py and glp-order-card are the binding
// consumers of this contract — see openapi.yaml's Orders tag for the
// fields (order status enum, queue ETA, milk stock counts, notify
// mapping, etc.) that must stay exact. orders_api.py proxies a fixed
// allowlist of paths (/api/orders, /api/orders/{menu,settings,queue-eta,
// active-beans,mine}, /api/orders/{id}/{accept,complete,decline}) — every
// one of those is ported and covered by handlers_test.go's
// TestProxiedPaths_Answer200. The X-GLP-HA-User-ID header's precedence
// over both POST /api/orders' body field and GET /api/orders/mine's query
// parameter (#547) is ported exactly and covered by
// TestPlaceOrder_HAUserIDHeaderPrecedence/TestMine_HeaderPrecedenceOverQuery.
//
// _broadcastShopState/_getPreheatInfo (the shop-open/shop-closed HA push
// notification POST /api/orders/settings fires when `enabled` flips) were
// deferred out of this phase pending the default machine's live runtime
// state (machineOn/switchOnAt) and are now ported (#901 Phase 1g,
// handlers.go's broadcastShopState) — wired to internal/system's Poller
// via the PreheatInfoFunc callback SetPreheatInfoProvider takes, not a
// direct import (see handlers.go's header comment and
// go/internal/system/doc.go for why a callback, not an import).
//
// File layout:
//
//	options.go     isOrdersEnabled() — a narrow, single-field read of
//	                /data/options.json (see its own doc comment for why
//	                this duplicates a slice of the not-yet-ported system
//	                domain's options.json facade rather than blocking on it)
//	ratelimit.go    lib/helpers.js's rateLimit(key, maxPerMinute), the
//	                per-feature limiter POST /api/orders uses (distinct
//	                from internal/ratelimit's app-wide socket-keyed one)
//	repository.go   lib/repositories/OrderRepository.js — the `orders`
//	                table plus the menu/orders_settings/notify_mapping kv keys
//	service.go      lib/services/OrderService.js — resolveMachineId/
//	                resolveBeanId/computeQueueEta/place|accept|complete|
//	                declineOrder
//	handlers.go     routes/orders.js
//
// # Deliberately not ported
//
//   - _checkPreheatNotify's barista "preheat ready" HA push (the OTHER
//     preheat-related notification, distinct from the shop-broadcast
//     above) is internal/system's, not this package's — see that
//     package's doc.go.
//   - internal/ha (new in this phase) ports sendHaNotify/
//     getNotifyServices/getHaPersons only — getSwitchState/getHaLanguage/
//     callHaService/getHaState aren't needed by any route this domain
//     registers; see internal/ha's own doc comment.
//
// Machine/live-status fields like machineReachable, isLive, apiToken and
// targetAt belong to the system package's contract, not this one — see
// go/internal/system/doc.go. The isOrdersEnabled 404 ("orders feature not
// enabled") is this package's own feature-disabled gate, distinct from the
// settings-proxy's 501 in the machines package — see
// go/internal/machines/doc.go.
package orders
