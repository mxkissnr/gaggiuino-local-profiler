import type { components } from './schema.gen.js';
import type { ShotDatapoints } from '../utils.js';

// Hand-maintained domain types for the GLP REST API (#1110, package A3a).
//
// schema.gen.ts is generated from go/internal/system/openapi.yaml, but that
// spec is documentation-grade rather than contract-grade: it under-documents
// most response payloads. The backend's shot record in particular is a
// `map[string]any` by design (see go/internal/shots/model.go's Shot type) —
// the machine-reported payload is a separate cross-repo contract the add-on
// must pass through byte-for-byte without knowing every field — so the eight
// fields openapi.yaml's Shot schema lists are a small subset of what a
// response actually carries.
//
// These types fill the gaps the generated ones leave. They are the frontend's
// view of the payload, not a mirror of the backend struct: define what the
// views/components actually read, and grow this file as the A3 sweeps convert
// call sites rather than guessing at the full machine payload up front.

type ShotSchema = components['schemas']['Shot'];
type AnnotationSchema = components['schemas']['Annotation'];

// Re-exported so call sites importing the API domain types have one surface;
// the datapoints shape itself lives in utils.ts (kept there because
// shot-curves.js maps lazy-fetched curves through it without an import cycle).
export type { ShotDatapoints };

/**
 * A shot's user-supplied annotation (`shot.annotation`). Extends the
 * documented Annotation with the fields the annotation panel writes and the
 * live reference selector reads but openapi.yaml doesn't list.
 */
export interface ShotAnnotation extends AnnotationSchema {
  /** Library bean the shot used (#450) — drives bean-stock/age math. */
  beanId?: number | null;
  /** Library basket the shot used (#635). */
  basketId?: number | null;
  /** Library puck screen the shot used (#635). */
  puckScreenId?: number | null;
  /** Bean age in days at brew time, computed on save. */
  beanAgeDays?: number | null;
  /** Selected brew recipe, if the install has any. */
  recipeId?: number | null;
  /** Selected frozen portion, if the install uses them. */
  frozenPortionId?: number | null;
  /** Barista-order drink type (orders feature). */
  drinkType?: string | null;
  /** Barista-order milk type id (orders feature). */
  milkType?: number | null;
  /** Score snapshot read by the live view's reference-shot selector. */
  score?: number | null;
}

/**
 * A hydrated shot record as the backend serves it (go/internal/shots/model.go
 * hydrateFields): the fixed shots-table columns, the decoded machine payload,
 * and the joined annotation. `datapoints` is present on GET
 * /api/shots/{id} (and /shots.json) but stripped from GET /api/shots metadata
 * rows (#957).
 */
export interface Shot extends Omit<ShotSchema, 'annotation' | 'duration' | 'profileName'> {
  /** Duration x 10; the DB column is nullable, hence null. */
  duration?: number | null;
  /** Null when the shot was stored without a profile name. */
  profileName?: string | null;
  /** Snake-case alias of profileName, served alongside it (card renderer reads it). */
  profile_name?: string | null;
  /** Multi-machine owner (#317); defaults to 1 backend-side. */
  machineId?: number | null;
  /** Machine-local shot number (toNativeShotID) — global id minus the machine offset. */
  nativeId?: number;
  /** Curve series, fetched per shot on demand (#957). */
  datapoints?: ShotDatapoints;
  /** Annotation row joined onto the shot; {} when the shot has no annotation. */
  annotation?: ShotAnnotation;
  /** Stored photo extension (see GET /api/shots/{id}/image), if any. */
  image?: string | null;
  /** GaggiMate BLE-scale flag, merged into datapoints by shot-curves.js. */
  gaggimateBleScale?: boolean | null;
}

/**
 * A shot row as GET /api/shots serves it: metadata only (no `datapoints`)
 * plus the score fields. GET /api/shots/{id} also adds `previousShot`;
 * `hasChartData`/`tempStabilityDev` are only computed for the paged metadata
 * list (go/internal/shots/handlers.go listShotsPage), hence optional here.
 */
export interface HydratedShot extends Shot {
  /** Computed 0-100 score; null when the shot has too little data to score. */
  score: number | null;
  /** Whether scoring detected the shot hit the bean's target. */
  usedBeanTarget: boolean;
  /** Paged list only: whether a chartable series exists. */
  hasChartData?: boolean;
  /** Paged list only: temperature-stability deviation. */
  tempStabilityDev?: number | null;
  /** Detail only: id of the previous same-profile shot (null if none). */
  previousShotId?: number | null;
  /** Detail only: the previous same-profile shot, already scored. */
  previousShot?: HydratedShot | null;
}

/**
 * GET/POST /api/shots/defaults (#654) — the per-install values pre-filled
 * into a brand-new shot's annotation panel. Mirrors
 * go/internal/shots/defaults.go's stored blob exactly (all seven keys are
 * always present; nil values stay null, the string stays "").
 */
export interface ShotDefaults {
  drinkType: string | null;
  coffee: string | null;
  beanId: number | null;
  basketId: number | null;
  puckScreenId: number | null;
  grinder: string;
  dose: number | null;
}

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
export interface QueuePosition {
  position: number;
  suggestedEta: number;
}

/**
 * GET /api/orders/queue-eta — mirrors go/internal/orders/service.go's
 * QueueEta: rolling prep-time estimate plus a queue position for every
 * pending order.
 */
export interface QueueEta {
  acceptedRemaining: number;
  pendingCount: number;
  prepTime: number;
  positions: Record<string, QueuePosition>;
}

/**
 * One row of GET /api/orders/milk-stock: a library milk entity plus the two
 * order-derived fields go/internal/orders' handler adds.
 */
export interface MilkStock {
  id?: number;
  name?: string;
  emoji?: string;
  stockMl?: number;
  /** Total ml active (accepted + pending) orders demand of this milk. */
  demand: number;
  /** stockMl - demand, floored at 0. */
  remaining: number;
}

/** One row of GET /api/orders/stats's `customers`. */
export interface OrderCustomerStat {
  name: string;
  count: number;
  favItem: string | null;
  lastAt: number;
}

/** GET /api/orders/stats — completed-order rollups (go/internal/orders' stats handler). */
export interface OrderStats {
  total: number;
  customers: OrderCustomerStat[];
  mostPopular: { item: string; count: number } | null;
  /** Only present when more than one machine has completed orders. */
  byMachine?: { machineId: number; machineName: string | null; count: number }[] | null;
}

/** One HA notify service (go/internal/ha's NotifyService). */
export interface NotifyService {
  id: string;
  name: string;
}

/** GET /api/orders/notify-mapping — per-HA-user mapping plus the known customer names. */
export interface NotifyMappingView {
  mapping: NotifyMapping;
  customers: Record<string, string>;
}

// ── Library (go/internal/library) ────────────────────────────────────────

export type Bean = components['schemas']['Bean'];
export type Grinder = components['schemas']['Grinder'];
export type Basket = components['schemas']['Basket'];
export type PuckScreen = components['schemas']['PuckScreen'];
export type Recipe = components['schemas']['Recipe'];
export type Milk = components['schemas']['Milk'];

/** GET /api/library — the whole snapshot the Library tab renders from. */
export type CoffeeLibrary = components['schemas']['Library'];

// ── Machines (go/internal/machines) ──────────────────────────────────────

export type Machine = components['schemas']['Machine'];
export type MachineInput = components['schemas']['MachineInput'];

type MachineProfileInput = components['schemas']['MachineProfileInput'];

/**
 * A machine profile as GET/POST/PUT /api/machine/profile[/{id}] carries it.
 * Covers both shapes the app touches: the Gaggiuino one
 * (MachineProfileInput — name/phases/recipe/...) and the GaggiMate one
 * gaggimate-profile-editor.js uses (label/description/temperature/phases).
 */
export interface MachineProfile {
  id?: string | number;
  name?: string;
  label?: string;
  description?: string;
  temperature?: number;
  type?: string;
  utility?: boolean;
  favorite?: boolean;
  waterTemperature?: number;
  phases?: MachineProfileInput['phases'];
  recipe?: MachineProfileInput['recipe'];
  globalStopConditions?: MachineProfileInput['globalStopConditions'];
  [key: string]: unknown;
}

/** GET /api/machine/profiles — the profile list plus its offline/stale flag. */
export interface MachineProfileList {
  optionsRaw?: MachineProfile[];
  stale?: boolean;
}

/** GET /api/machine/settings — the opaque per-machine settings blob (only `releaseChannel` is read today). */
export interface MachineSystemSettings {
  releaseChannel?: number;
  [key: string]: unknown;
}

/** GET /api/machine/firmware/version — the machine's OTA status. */
export interface FirmwareVersion {
  installed?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  releaseUrl?: string | null;
  [key: string]: unknown;
}

/** GET /api/machine/firmware/progress — one poll of the OTA progress. */
export interface FirmwareProgress {
  status?: string;
  [key: string]: unknown;
}

/** POST/PUT /api/machines body — the fields the Settings machine form sends. */
export interface MachineSaveInput {
  name: string;
  type: 'gaggiuino' | 'gaggimate';
  host: string;
  switchEntity?: string | null;
  theme?: unknown;
  hasWaterSensor?: boolean;
}
