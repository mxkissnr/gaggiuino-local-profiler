# Acceptance protocols

Before each release the maintainer runs an acceptance pass against the
dev-channel build installed in Home Assistant and records the result here.
The pass verifies that every change in the release actually works for a user,
in the real app, against a real machine — something CI cannot cover.

This directory holds the format and the recorded protocols. Running a pass is
a manual step done before cutting a release; it is not wired into CI.

## Files

- `v<version>.md` — one protocol per release, named after the app version in
  `config.yaml` (for example `v3.2.0.md`).
- `v<version>/` — optional screenshots referenced from the protocol. The folder
  is optional; a protocol without images is fine.

## Header

Every protocol starts with the fields below, so a reader can tell exactly what
was tested:

- **App version** — the version from `config.yaml`, matching the file name.
- **Dev build tested** — the dev-channel build that was installed (commit or
  build date).
- **Date** — the day the pass was run.
- **Gaggiuino firmware** — the firmware version on the machine, or `n/a`.
- **GaggiMate firmware** — the firmware version plus whether it was a
  simulator or a physical device, or `n/a`.
- **Home Assistant version** — the Home Assistant version the dev build ran on.

## Table

One Markdown table lists every case:

| # | Case | Source | Method | Result | Evidence |
|---|------|--------|--------|--------|----------|

- **#** — a running number.
- **Case** — a short description of what was checked.
- **Source** — the CHANGELOG entry or issue number the case comes from.
- **Method** — one of the values below.
- **Result** — one of the values below.
- **Evidence** — a response excerpt, a screenshot file name, or a note.

### Methods

- `API` — the app's own API or its MCP server.
- `HA` — Home Assistant: integration entities, services and cards.
- `UI` — the browser through HA ingress, on desktop and mobile.
- `manual` — a step that needs the physical machine.
- `CI` — an internal change covered by the green CI run; list it in one row.

### Results

- `pass` — the case worked.
- `fail` — the case did not work. A release cannot go out with a failing case.
- `manual-pending` — a manual case that has not been run yet.
- `waived: <reason>` — a case skipped on purpose, with the reason written out.

## Core regression cases

These run on every release, in addition to the cases for the release's own
changes:

1. The app loads through ingress without console errors.
2. The shot list and a shot detail with its curve render.
3. The coffee library can create, edit and delete a bean on a test bean.
4. An order can be created and completed, including the milk deduction.
5. A backup export works, its size is plausible and every bundled image belongs to an entry, and it restores into a fresh instance with the same number of shots, library entries and images.
6. The HA integration entities are current and one service call succeeds.
7. The shot card and the order card render.
8. The MCP server answers a shot list request.
9. GaggiMate: connect, live status during a simulated brew, and a shot
   imported with its curve.

## GaggiMate simulator

The simulator is the official desktop simulator from `jniebuhr/gaggimate`
(`sim/README.md`, PlatformIO env `display-sim`): the real display firmware with
a simulated controller, serving the same WebUI and WebSocket API as the device.
It is added to the dev install as a second machine of type `gaggimate`. Its
address is environment-specific and never written into a protocol.

A brew can be started headless over `ws://<sim>/ws` (verified 2026-10-02):

```js
{ tp: 'req:change-mode', mode: 1 }                    // brew mode
{ tp: 'req:process:activate', ignoreWarnings: true }  // start the brew
// ~30 s: evt:status with process phases, then
// evt:shot-finished-stats + evt:history-shot-saved {id}
{ tp: 'req:process:deactivate' }
{ tp: 'req:change-mode', mode: 0 }                    // back to standby
```

GaggiMate core cases run against it:

- The machine is reachable and its firmware version is shown.
- Live status during the brew shows profile name, phase, pressure, flow and
  temperature.
- The shot is imported after `evt:history-shot-saved` and has a non-empty curve.
- Profile list, load, save and delete work on an `ACCEPTANCE-` profile.

For a new GaggiMate firmware (an `upstream-firmware` issue): rebuild the
simulator at the tag (`git checkout vX.Y.Z`, `scripts/build_webui.sh`,
`pio run -e display-sim`), restart it, run the core cases and post the result
on that issue. A failing case gets its own fix issue.

The protocol header names the simulator's firmware version, the tag it was
built from.

## Public content

The protocol is public. It must not contain LAN addresses, hostnames, tokens
or personal names. Screenshots show only the app, never the surrounding Home
Assistant UI.

`scripts/release-check.mts` rejects a protocol that leaks an RFC1918 private
IPv4 address, a hostname ending in `.local` or `.lan`, a JWT-like string or a
GitHub token prefix.

## Gate

A release needs a protocol for its version with no `fail` and no
`manual-pending` case. A skipped case needs an explicit `waived: <reason>`.

## Example

| # | Case | Source | Method | Result | Evidence |
|---|------|--------|--------|--------|----------|
| 1 | App loads through ingress without console errors | core | UI | pass | no console errors |
| 2 | Shot list and shot detail with curve render | core | UI | pass | screenshot: shot-detail.png |
| 3 | Order create and complete deducts the milk | #1199 | API | pass | response excerpt |
