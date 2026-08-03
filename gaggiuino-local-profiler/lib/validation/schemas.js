const { z } = require('zod');
const { THEME_PRESET_KEYS } = require('../machines/theme-presets');

const annotationSchema = z.object({
    coffee:        z.string().max(200).optional(),
    grindSetting:  z.string().max(50).optional(),
    notes:         z.string().max(2000).optional(),
    // #434: the frontend sends drinkType: null for "no drink assigned" (see
    // annotation.js's `?.value || null`) — same shape as the milkType bug
    // below, just missed the first time. Without .nullable() every annotate
    // call with no drink selected (the common case for any install without
    // the Orders feature's drink menu populated) failed validation with a 400.
    drinkType:     z.string().max(50).nullable().optional(),
    // Milk ids are numeric (Date.now(), see routes/library.js POST /api/library/milk),
    // and the frontend always sends milkType as parseInt(...) — a string type here
    // rejected every annotate call that included a selected milk with a 400, which
    // silently broke both the annotation save and the milk-stock deduction nested
    // inside its success handler.
    milkType:      z.number().int().nullable().optional(),
    rating:        z.number().int().min(1).max(5).nullable().optional(),
    score:         z.number().nullable().optional(),
    recipeId:      z.number().int().nullable().optional(),
    // #456: stable link to library.beans[].id, set when the user picked a bean
    // from the annotation panel's dropdown (or it was carried through
    // quick-clone / the dial-in wizard). Preferred over the free-text `coffee`
    // name for shot->bean matching, since a bean deleted+reimported gets a new
    // id but the same name — beanId survives renames, name-matching doesn't.
    // `coffee` is kept as-is regardless (display value / CSV export / snapshot).
    beanId:        z.number().int().nullable().optional(),
    // Bag-within-bean identity (if ever revived) — distinct from beanId (bean
    // identity) above. Currently unused; do not conflate the two.
    beanBagId:     z.number().int().nullable().optional(),
    // #502: which frozen-portion batch (bag.frozenPortions[].id) this shot's
    // dose came from, an explicit choice in the annotation panel — null
    // means "not frozen" was explicitly picked, same as no bean picked at
    // all being distinct from "unset". The library-stock deduction itself
    // happens client-side (public-src/views/shots/annotation.js
    // _maybeAdjustFrozenPortion, mirroring the existing milk-deduction
    // pattern), not here — this field is just the durable record.
    frozenPortionId: z.number().int().nullable().optional(),
}).passthrough();

const beanSchema = z.object({
    name:      z.string().min(1).max(200),
    roaster:   z.string().max(200).optional().default(''),
    origin:    z.string().max(200).optional().default(''),
    variety:   z.string().max(200).optional().default(''),
    species:   z.enum(['', 'Arabica', 'Robusta', 'Liberica', 'Blend']).optional().default(''),
    category:  z.enum(['speciality', 'normal']).optional().default('normal'),
    process:   z.string().max(200).optional().default(''),
    roastDate: z.string().optional().default(''),
    weight:    z.number().positive().optional().nullable(),
    notes:     z.string().max(1000).optional().default(''),
}).passthrough();

const grinderSchema = z.object({
    name:  z.string().min(1).max(200),
    notes: z.string().max(1000).optional().default(''),
}).passthrough();

const recipeSchema = z.object({
    name:  z.string().min(1).max(200),
    notes: z.string().max(1000).optional().default(''),
    steps: z.array(z.object({
        label: z.string().max(200),
        value: z.string().max(200),
    })).optional().default([]),
}).passthrough();

const maintenanceLogSchema = z.object({
    task:    z.string().min(1).max(100),
    notes:   z.string().max(1000).optional().default(''),
    machine: z.string().max(200).optional().default(''),
});

const orderSchema = z.object({
    drinkId:    z.string().min(1).max(50),
    personName: z.string().min(1).max(200),
    notes:      z.string().max(500).optional().default(''),
}).passthrough();

// ── Machine profile (#307) ──────────────────────────────────────────────
// Mirrors lib/gaggiuino-ws-client.js's toWireProfile(): type/curve accept
// either the machine's enum strings ("PRESSURE", "LINEAR", ...) or their
// numeric wire values, since the app sends strings but a raw numeric value
// (e.g. round-tripped from the machine) must also validate.
const phaseTypeSchema  = z.union([z.enum(['FLOW', 'PRESSURE', 'MANUAL']), z.number().int().min(0).max(2)]);
const curveSchema      = z.union([z.enum(['EASE_IN_OUT', 'EASE_IN', 'EASE_OUT', 'LINEAR', 'INSTANT']), z.number().int().min(0).max(4)]);

const transitionSchema = z.object({
    start:  z.number().optional(),
    end:    z.number().optional(),
    curve:  curveSchema.optional(),
    time:   z.number().optional(),
    volume: z.number().optional(),
}).optional();

const phaseStopConditionsSchema = z.object({
    time:               z.number().optional(),
    pressureAbove:      z.number().optional(),
    pressureBelow:      z.number().optional(),
    flowAbove:          z.number().optional(),
    flowBelow:          z.number().optional(),
    weight:             z.number().optional(),
    waterPumpedInPhase: z.number().optional(),
}).optional();

const phaseSchema = z.object({
    name:             z.string().max(100).optional(),
    type:             phaseTypeSchema,
    target:           transitionSchema,
    restriction:      z.number().optional(),
    stopConditions:   phaseStopConditionsSchema,
    waterTemperature: z.number().optional(),
    skip:             z.boolean().optional(),
});

const globalStopConditionsSchema = z.object({
    time:                       z.number().optional(),
    weight:                     z.number().optional(),
    waterPumped:                z.number().optional(),
    switchToManualPressureCtrl: z.boolean().optional(),
    switchToManuaFlowCtrl:      z.boolean().optional(),
}).optional();

const brewRecipeSchema = z.object({
    coffeeIn:  z.number().optional(),
    coffeeOut: z.number().optional(),
    ratio:     z.number().optional(),
}).optional();

const profileSchema = z.object({
    id:                   z.number().int().optional(),
    name:                 z.string().min(1).max(200),
    phases:               z.array(phaseSchema).min(1),
    globalStopConditions: globalStopConditionsSchema,
    waterTemperature:     z.number().optional(),
    recipe:               brewRecipeSchema,
});

// ── Machine registry (#317) ─────────────────────────────────────────────
// Machine theme (#594): stored as-is in machines.theme (see lib/db.js's
// machines table comment for the exact JSON contract). Hex colours are
// validated strictly (#rrggbb only, no CSS colour names/functions) since
// this value is interpolated straight into SVG/CSS on both the app and the
// Lovelace cards — anything looser risks CSS/markup injection.
const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb hex colour');
const themeSchema = z.union([
    z.object({ preset: z.enum(THEME_PRESET_KEYS) }).strict(),
    z.object({ a: hexColorSchema, b: hexColorSchema }).strict(),
]).nullable();

const machineSchema = z.object({
    name:         z.string().min(1).max(100),
    type:         z.enum(['gaggiuino', 'gaggimate']),
    host:         z.string().min(1).max(255),
    switchEntity: z.string().max(200).optional().nullable(),
    theme:        themeSchema.optional(),
    enabled:      z.boolean().optional().default(true),
});

module.exports = {
    annotationSchema,
    beanSchema,
    grinderSchema,
    recipeSchema,
    maintenanceLogSchema,
    orderSchema,
    profileSchema,
    machineSchema,
};
