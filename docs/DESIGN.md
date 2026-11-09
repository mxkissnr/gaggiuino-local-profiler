# Design language

The redesigned coffee library is the reference for every page of the app.

## Page anatomy

1. **Verdict first.** One sentence on what is going on, and one big number next to it.
2. **One toolbar.** Search and chips, filtering the whole page. It stays sticky at the top.
3. **Sections without boxes.** An accent-coloured heading with a grey counter, content directly below.
4. **Pictures before words.** Sticker tiles, graphs, rows with dividers instead of card stacks.
5. **A click opens details.** A popover next to the target on desktop (900 px and wider), a bottom sheet on phones. The page itself does not grow.
6. **Rarely used things are folded away.** Like "Empty & archive" in the library.

Statistics (`gaggiuino-local-profiler/public-src/views/analytics.ts`, #1467) is
the reference for the first two: a one-line verdict with the period's average
score, and one sticky toolbar that filters the whole page by period, bean or
profile. It also puts rules 3 and 6 to work: boxless sections under an accent
heading with a grey counter, and the rarer charts folded away behind a "More
insights" summary, with a two-column desktop layout for the rest.

## Rules

- **Nothing twice.** Every number or fact appears once per page. Before adding one, check the verdict, the other sections and the charts.
- **Use space well.** No empty boxes and no half-empty rows or columns. Desktop gets its own two-column layout with balanced columns, never a stretched phone view. Maps and charts zoom to the part that matters.
- **Long periods stay calm.** Past a month or so, the score trend draws one point per calendar day — a 7-day rolling mean with a low/high band and month-first tick labels — and a day opens its own detail. The coffee year sizes its cells so the last 22 weeks fill a phone's width and scrolls to the newest week, with a legend for the heat scale and the crema dot.
- **Love for detail.** Every view gets small coffee touches (a crema dot for a 100, ice for frozen beans, cup streaks, travelling bean routes, fact cards). They respect `prefers-reduced-motion` and are never loud. Easter eggs never appear in release notes, docs or public issues.
- **Mobile is designed, not shrunk.** Design at 390 px first; touch targets are at least 44 px.
- **One sheet header.** Every bottom sheet and its desktop popover share the same bar: close on the left, the title, then the main actions as 44 px icons on the right, each with an `aria-label` through `t()`. It stays at the top while the content scrolls and only then draws a hairline. The more menu keeps only what the bar does not already show.
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

- [ ] Verdict and toolbar present.
- [ ] No number twice.
- [ ] Screenshot at 390 px and at 1280 px attached.
- [ ] Every clickable target opens its details.
- [ ] Reduced motion checked.
- [ ] Light and dark theme checked.
- [ ] All six languages.
- [ ] Interaction rules followed: choosing, saving, confirming, errors, numbers, dates, switches.
- [ ] Loading, empty and error state defined for every view.
- [ ] No native `alert`, `confirm` or `<datalist>`.
