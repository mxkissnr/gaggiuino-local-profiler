import type { components } from './schema.gen.js';
import type { ShotDatapoints } from '../utils.js';

// Domain types for the GLP REST API (#1110, package A3a).
//
// schema.gen.ts is generated from go/internal/system/openapi.yaml, which is
// contract-grade for the shot payloads (#1103): the Annotation and Shot
// schemas document every field the Go handlers serve, and HydratedShot
// covers the list/detail projections. ShotAnnotation/Shot/HydratedShot below
// therefore alias the generated schemas; the only hand-written override is
// `datapoints`, whose per-series array shapes the spec models as an open
// object on purpose (go/internal/shots/model.go's Shot is a map[string]any).

// Re-exported so call sites importing the API domain types have one surface;
// the datapoints shape itself lives in utils.ts (kept there because
// shot-curves.js maps lazy-fetched curves through it without an import cycle).
export type { ShotDatapoints };

/** A shot's user-supplied annotation (`shot.annotation`), per openapi.yaml's Annotation. */
export type ShotAnnotation = components['schemas']['Annotation'];

/**
 * A hydrated shot record as the backend serves it (go/internal/shots/model.go
 * hydrateFields): the fixed shots-table columns, the decoded machine payload,
 * and the joined annotation.
 */
export type Shot = Omit<components['schemas']['Shot'], 'datapoints'> & {
  /**
   * Hand-written override: the spec models the machine curve series as an open
   * object, but the views read typed per-series arrays (utils.ts ShotDatapoints).
   */
  datapoints?: ShotDatapoints;
};

/**
 * A shot row as GET /api/shots (metadata only, no `datapoints`) and
 * GET /api/shots/{id} (full, plus `previousShot`) serve it, per openapi.yaml's
 * HydratedShot.
 */
export type HydratedShot = Omit<components['schemas']['HydratedShot'], 'datapoints' | 'previousShot'> & {
  /** Hand-written override: see Shot.datapoints above. */
  datapoints?: ShotDatapoints;
  /** Hand-written override so previousShot keeps the typed Shot, not the generated open-datapoints shape. */
  previousShot?: HydratedShot | null;
};

/**
 * GET/POST /api/shots/defaults (#654) — the per-install values pre-filled
 * into a brand-new shot's annotation panel. Mirrors
 * go/internal/shots/defaults.go's stored blob exactly (all seven keys are
 * always present; nil values stay null, the string stays "").
 */
export type ShotDefaults = components['schemas']['ShotDefaults'];

// ── Orders (go/internal/orders) ──────────────────────────────────────────

export type Order = components['schemas']['Order'];
export type MenuItem = components['schemas']['MenuItem'];
export type OrdersSettings = components['schemas']['OrdersSettings'];
/** Map of haUserId → notify service name ("notify.mobile_app_phone"). */
export type NotifyMapping = components['schemas']['NotifyMapping'];

/**
 * POST /api/orders/settings body — the backend requires `enabled` as a
 * boolean and overwrites the whole stored settings blob, so every save
 * round-trips the other keys it wants to keep.
 */
export type OrdersSettingsUpdate = OrdersSettings & { enabled: boolean };

/** One entry of GET /api/orders/queue-eta's `positions` map. */
export type QueuePosition = components['schemas']['QueuePosition'];

/**
 * GET /api/orders/queue-eta — mirrors go/internal/orders/service.go's
 * QueueEta: rolling prep-time estimate plus a queue position for every
 * pending order.
 */
export type QueueEta = components['schemas']['QueueEta'];

/**
 * One row of GET /api/orders/milk-stock: a library milk entity plus the two
 * order-derived fields go/internal/orders' handler adds.
 */
export type MilkStock = components['schemas']['MilkStock'];

/** One row of GET /api/orders/stats's `customers`. */
export type OrderCustomerStat = components['schemas']['OrderCustomerStat'];

/** GET /api/orders/stats — completed-order rollups (go/internal/orders' stats handler). */
export type OrderStats = components['schemas']['OrderStats'];

/** One HA notify service (go/internal/ha's NotifyService). */
export type NotifyService = components['schemas']['NotifyService'];

/** GET /api/orders/notify-mapping — per-HA-user mapping plus the known customer names. */
export type NotifyMappingView = components['schemas']['NotifyMappingView'];

// ── Library (go/internal/library) ────────────────────────────────────────

export type Bean = components['schemas']['Bean'];
export type Grinder = components['schemas']['Grinder'];
export type Basket = components['schemas']['Basket'];
export type PuckScreen = components['schemas']['PuckScreen'];
export type Recipe = components['schemas']['Recipe'];
export type Milk = components['schemas']['Milk'];

// Request bodies for the bag-queue endpoints (#1122) — generated from
// go/internal/system/openapi.yaml so api/library.ts never hand-maintains
// these shapes (maintainer review point 6).
export type NewBagInput = components['schemas']['NewBagInput'];
export type BagUpdateInput = components['schemas']['BagUpdateInput'];
export type ReorderBagsInput = components['schemas']['ReorderBagsInput'];
export type FreezePortionsInput = components['schemas']['FreezePortionsInput'];
export type ThawPortionInput = components['schemas']['ThawPortionInput'];
export type AdjustFrozenPortionInput = components['schemas']['AdjustFrozenPortionInput'];

/** GET /api/library — the whole snapshot the Library tab renders from. */
export type CoffeeLibrary = components['schemas']['Library'];

// ── Machines (go/internal/machines) ──────────────────────────────────────

export type Machine = components['schemas']['Machine'];
export type MachineInput = components['schemas']['MachineInput'];

/**
 * A machine profile as GET/POST/PUT /api/machine/profile[/{id}] carries it.
 * Covers both shapes the app touches: the Gaggiuino one
 * (name/phases/recipe/globalStopConditions/...) and the GaggiMate one
 * gaggimate-profile-editor.js uses (label/description/temperature/phases).
 */
export type MachineProfile = components['schemas']['MachineProfile'];

/** GET /api/machine/profiles — the profile list plus its offline/stale flag. */
export type MachineProfileList = components['schemas']['MachineProfileList'];

/** GET /api/machine/settings — the opaque per-machine settings blob (only `releaseChannel` is read today). */
export type MachineSystemSettings = components['schemas']['MachineSystemSettings'];

/** GET /api/machine/firmware/version — the machine's OTA status. */
export type FirmwareVersion = components['schemas']['FirmwareVersion'];

/** GET /api/machine/firmware/progress — one poll of the OTA progress. */
export type FirmwareProgress = components['schemas']['FirmwareProgress'];

/** POST/PUT /api/machines body — the fields the Settings machine form sends. */
export type MachineSaveInput = components['schemas']['MachineSaveInput'];

// ── MQTT (go/internal/mqtt) ──────────────────────────────────────────────

/**
 * GET/POST /api/mqtt/settings (go/internal/mqtt's SettingsView). GET is
 * redacted: it reports `hasPassword` instead of the stored password (#1050).
 * POST accepts the same keys plus the write-only `password`/`clearPassword`
 * pair.
 */
export type MqttSettings = components['schemas']['MqttSettings'];
