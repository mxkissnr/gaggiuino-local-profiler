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
