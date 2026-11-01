// Package orders is the barista-orders domain: its REST endpoints and the
// queue-ETA and order-lifecycle logic.
//
// glp-integration's orders_api.py and glp-order-card are the binding
// consumers of this contract — see openapi.yaml's Orders tag for the
// fields (order status enum, queue ETA, milk stock counts, notify
// mapping, etc.) that must stay exact. orders_api.py proxies a fixed
// allowlist of paths (/api/orders, /api/orders/{menu,settings,queue-eta,
// active-beans,mine}, /api/orders/{id}/{accept,complete,decline}) — every
// one of those is implemented and covered by handlers_test.go's
// TestProxiedPaths_Answer200. The X-GLP-HA-User-ID header's precedence
// over both POST /api/orders' body field and GET /api/orders/mine's query
// parameter (#547) is implemented exactly and covered by
// TestPlaceOrder_HAUserIDHeaderPrecedence/TestMine_HeaderPrecedenceOverQuery.
//
// _broadcastShopState/_getPreheatInfo (the shop-open/shop-closed HA push
// notification POST /api/orders/settings fires when `enabled` flips) need
// the default machine's live runtime state (machineOn/switchOnAt) and live
// in handlers_shop.go's broadcastShopState — wired to internal/system's
// Poller via the PreheatInfoFunc callback SetPreheatInfoProvider takes, not a
// direct import (see go/internal/system/doc.go for why a callback).
//
// File layout:
//
//	options.go     isOrdersEnabled() — options.json's enable_orders via
//	                internal/config's shared Options() reader
//	repository.go   the `orders` table plus the menu/orders_settings/
//	                notify_mapping kv keys
//	service.go      resolveMachineId/resolveBeanId/computeQueueEta/
//	                place|accept|complete|declineOrder
//	handlers.go     route registration and shared handler plumbing
//	handlers_orders.go / handlers_shop.go  the REST handlers
//	handlers_kioskkey.go  GET /api/orders/kiosk-key and its rotate route
//	                (#1731), backed by internal/auth's KioskKeyStore
//	normalize.go    menu-item normalisation (NormalizeMenuItem)
//
// The barista "preheat ready" HA push is internal/system's (see that
// package's preheat.go); this package only provides the settings it reads.
//
// Machine/live-status fields like machineReachable, isLive, apiToken and
// targetAt belong to the system package's contract, not this one — see
// go/internal/system/doc.go. The isOrdersEnabled 404 ("orders feature not
// enabled") is this package's own feature-disabled gate, distinct from the
// settings-proxy's 501 in the machines package — see
// go/internal/machines/doc.go.
package orders
