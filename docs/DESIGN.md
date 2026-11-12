# Design language

The app runs inside Home Assistant, so every page follows Home Assistant's interaction patterns. They are built with the app's own tokens, fonts and colours; no Home Assistant or other UI library is added.

## Page anatomy

1. **Verdict first.** One sentence on what is going on, and one big number next to it.
2. **Top app bar.** Menu or back, the page title, search and an overflow menu. There is no second button row: rarely used actions go into the overflow menu.
3. **Filter chips** sit below the bar and filter the whole page.
4. **Cards group list rows.** A row has an icon or avatar, a title, a subtitle, a value and a chevron, with hairlines between rows. A card may carry a small grey heading with a counter. This replaces card stacks and tile grids. Pictures still come first where they carry information: charts, bean stickers, the machine icon.
5. **One floating action button** for the page's main action, if the page has one.
6. **A click opens details.** A centred dialog on desktop (900 px and wider), a bottom sheet with a handle on phones. The page itself does not grow.
7. **Settings are a grouped list** that leads to sub-pages, like Home Assistant's settings. On desktop the list sits on the left and the open sub-page on the right; on a phone the sub-page replaces the list and has a back arrow. A sub-page is a list of rows with the control on the right: a switch, pills, a dropdown, or a value with a chevron that opens a dialog.
8. **Rarely used things are folded away.** Like "Empty & archive" in the library.

Statistics (#1467), maintenance (#1923) and the coffee library's shelf still follow the earlier style: one sticky toolbar with search and chips, boxless sections under an accent heading, sticker tiles, and details in a popover next to the target on desktop. Their verdict, folds and two-column desktop layout already match these rules; the rest moves over in a later pass. Until then, a change to those pages keeps their current style rather than mixing the two.

## Rules

- **Nothing twice.** Every number or fact appears once per page. Before adding one, check the verdict, the other sections and the charts.
- **Use space well.** No empty boxes and no half-empty rows or columns. Desktop gets its own two-column layout with balanced columns, never a stretched phone view. Maps and charts zoom to the part that matters.
- **Long periods stay calm.** Past a month or so, the score trend draws one point per calendar day — a 7-day rolling mean with a low/high band and month-first tick labels — and a day opens its own detail. The coffee year sizes its cells so the last 22 weeks fill a phone's width and scrolls to the newest week, with a legend for the heat scale and the crema dot.
- **Love for detail.** Every view gets small coffee touches (a crema dot for a 100, ice for frozen beans, cup streaks, travelling bean routes, fact cards). They respect `prefers-reduced-motion` and are never loud. Easter eggs never appear in release notes, docs or public issues.
- **Mobile is designed, not shrunk.** Design at 390 px first; touch targets are at least 44 px.
- **One sheet header.** Every bottom sheet and its desktop dialog share the same bar: close on the left, the title, then the main actions as 44 px icons on the right, each with an `aria-label` through `t()`. There is no extra Cancel button; closing is the cancel. The bar stays at the top while the content scrolls and only then draws a hairline. The more menu keeps only what the bar does not already show. The pages that still use popovers (see above) give them the same bar.
- **One visual system.** One radius token, surface colour instead of borders, `tabular-nums` for numbers, one score colour scale (ok / warn / err), Figtree for text and Fraunces for large display numbers, warmth through colour rather than typography.
- **Readable.** Contrast of at least 4.5:1, labels included; both light and dark theme.
- **No generic look.** No default font stacks, no purple gradients, no emoji, no interchangeable dashboard cards; every element earns its place with real data.
- **Six languages.** Every visible string goes through `t()` in all six language files.

## Interaction rules

The same kind of control behaves the same way on every page.

- **Choosing.** Show a fixed set of up to 5 short options as visible pills. Use a dropdown for longer lists and for anything backed by the library. Use free text with suggestions only where new values are legitimate; never free text for a fixed set and never a native `<datalist>`. A visible choice is faster, and a mistyped value cannot split the data.
- **Saving.** Editing an existing entry saves automatically and shows a visible saved state; creating an entry uses a save button. Nothing is lost on edit, and a new entry only exists once the user decides it should.
- **Confirming.** No native `alert` or `confirm`. Use one dialog for irreversible actions and a toast with undo for everything else. Browser dialogs cannot be styled or translated consistently and block the page.
- **Errors.** Show field errors at the field and everything else as a toast. The user sees the problem where it can be fixed.
- **Numbers.** Put the unit in the label, always set min, max and step, and accept a comma as decimal separator. Users type in their own locale, and limits stop impossible values early.
- **Dates.** Format every date through one shared helper with a short and a long form. Views that format on their own drift apart.
- **Switches.** A toggle takes effect immediately; a checkbox belongs in a form with a save button. The control then tells the user whether anything still has to be saved.
- **States.** Every view defines its loading, empty and error state. No view is ever blank or stuck without saying why.

## Checklist before a UI pull request

- [ ] Verdict first.
- [ ] Top app bar with title, search and overflow menu; filter chips below it if the page filters.
- [ ] Lists are cards of rows (icon, title, subtitle, value, chevron), not card stacks or tile grids.
- [ ] No number twice.
- [ ] Screenshot at 390 px and at 1280 px attached.
- [ ] Every clickable row opens its details: a dialog on desktop, a bottom sheet on phones, close top left and no extra Cancel.
- [ ] Reduced motion checked.
- [ ] Light and dark theme checked.
- [ ] All six languages.
- [ ] Interaction rules followed: choosing, saving, confirming, errors, numbers, dates, switches.
- [ ] Loading, empty and error state defined for every view.
- [ ] No native `alert`, `confirm` or `<datalist>`.
