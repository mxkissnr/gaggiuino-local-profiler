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
profile.

## Rules

- **Nothing twice.** Every number or fact appears once per page. Before adding one, check the verdict, the other sections and the charts.
- **Use space well.** No empty boxes and no half-empty rows or columns. Desktop gets its own two-column layout with balanced columns, never a stretched phone view. Maps and charts zoom to the part that matters.
- **Love for detail.** Every view gets small coffee touches (a crema dot for a 100, ice for frozen beans, cup streaks, travelling bean routes, fact cards). They respect `prefers-reduced-motion` and are never loud. Easter eggs never appear in release notes, docs or public issues.
- **Mobile is designed, not shrunk.** Design at 390 px first; touch targets are at least 44 px.
- **One visual system.** One radius token, surface colour instead of borders, `tabular-nums` for numbers, one score colour scale (ok / warn / err), Figtree for text and Fraunces for large display numbers, warmth through colour rather than typography.
- **Readable.** Contrast of at least 4.5:1, labels included; both light and dark theme.
- **No generic look.** No default font stacks, no purple gradients, no emoji, no interchangeable dashboard cards; every element earns its place with real data.
- **Six languages.** Every visible string goes through `t()` in all six language files.

## Checklist before a UI pull request

- [ ] Verdict and toolbar present.
- [ ] No number twice.
- [ ] Screenshot at 390 px and at 1280 px attached.
- [ ] Every clickable target opens its details.
- [ ] Reduced motion checked.
- [ ] Light and dark theme checked.
- [ ] All six languages.
