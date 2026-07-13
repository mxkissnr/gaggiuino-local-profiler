// Interface documentation for machine adapters (#317). This file is not
// required anywhere at runtime — lib/machines/index.js's getAdapter()
// require()s the concrete gaggiuino/gaggimate adapter modules directly — it
// exists purely so the shared method contract lives in one place instead of
// being re-derived from each adapter's own comments.
//
// Every adapter module (lib/machines/gaggiuino/adapter.js,
// lib/machines/gaggimate/adapter.js) exports the following async functions,
// all taking the machine registry row (lib/machines/registry.js's shape:
// {id, name, type, host, switchEntity, isDefault, enabled}) as their first
// argument:
//
//   getStatus(machine)                 -> { reachable, temperature, targetTemperature,
//                                            pressure, weight, brewing, steamOn,
//                                            profileId, profileName, raw }
//   getLatestShotId(machine)           -> nativeId (machine's own numbering) | null
//   getShot(machine, nativeId)         -> shot payload in GLP's canonical shot
//                                          shape (datapoints, profile, timestamp, ...)
//   listProfiles(machine)              -> [{ id, name }, ...]
//   getProfile(machine, id)            -> full profile detail (phases etc.)
//   createProfile(machine, profile)    -> { id, name }
//   updateProfile(machine, profile)    -> { id, name }
//   deleteProfile(machine, id)         -> remaining profile list | ok marker
//   selectProfile(machine, id)         -> { ok }
//   capabilities()                     -> { profileEdit, brewStart, preheat,
//                                            volumetric, history } (sync, no args)
//
// The canonical data model (shot datapoints ×10-scaled, profile editor
// shape) stays Gaggiuino-flavored — the GaggiMate adapter maps into it and
// documents what's lossy (see lib/machines/gaggimate/history.js).
module.exports = {};
