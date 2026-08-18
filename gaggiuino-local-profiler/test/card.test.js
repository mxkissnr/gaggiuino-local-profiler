import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const {
  installCodeFor,
  INSTALL_CODE_ALPHABET,
  CARD_TOKENS,
  buildPalette,
  LINE_COLORS,
  contrastRatio,
  hexToRgbArr,
  scoreColor,
  generateShareCard,
} = require('../lib/card');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

// #811: install code always rendered on the share card, derived from the
// existing kv.install_id UUID (lib/db.js ensureInstallId(), #751) -- no new
// field, no new generation.
describe('installCodeFor (#811)', () => {
  it('is pinned against a fixed UUID -- must never silently change', () => {
    // If this ever goes red after an innocent-looking refactor, STOP: the
    // algorithm changing means every code already printed on a screenshot
    // out in the wild stops matching its owner's actual install.
    expect(installCodeFor('123e4567-e89b-12d3-a456-426614174000')).toBe('JAZE-NFFK');
  });

  it('is deterministic -- same UUID always yields the same code', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    expect(installCodeFor(uuid)).toBe(installCodeFor(uuid));
  });

  it('differs for a different UUID', () => {
    expect(installCodeFor('00000000-0000-0000-0000-000000000000'))
      .not.toBe(installCodeFor('ffffffff-ffff-ffff-ffff-ffffffffffff'));
  });

  it('renders as AAAA-AAAA using only the curated alphabet', () => {
    const code = installCodeFor('123e4567-e89b-12d3-a456-426614174000');
    const alphaClass = INSTALL_CODE_ALPHABET.split('').join('');
    expect(code).toMatch(new RegExp(`^[${alphaClass}]{4}-[${alphaClass}]{4}$`));
  });

  it('alphabet excludes every visually-ambiguous character (0/O, 1/I/l)', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(INSTALL_CODE_ALPHABET).not.toContain(ch);
    }
    expect(new Set(INSTALL_CODE_ALPHABET.split('')).size).toBe(INSTALL_CODE_ALPHABET.length);
  });
});

// #811: buildPalette() no longer draws lines (border/borderDim) that fail
// WCAG 1.4.11 (>=3:1 for non-text lines) against the surfaces they're
// actually stroked on -- see LINE_COLORS in lib/card.js for how they're
// derived (lift toward text colour, same mechanic as glp-lovelace-card's
// _applyAccentLineContrast() for --glp-aline).
describe('buildPalette() line contrast (#811)', () => {
  const combos = [
    ['amber', 'dark'], ['amber', 'light'],
    ['crema', 'dark'], ['crema', 'light'],
    ['ocean', 'dark'], ['ocean', 'light'],
  ];

  it.each(combos)('border/borderDim clear 3:1 against bgChart and bgCard (%s/%s)', (accent, theme) => {
    const GLP = buildPalette(accent, theme);
    expect(contrastRatio(hexToRgbArr(GLP.border), hexToRgbArr(GLP.bgChart))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hexToRgbArr(GLP.border), hexToRgbArr(GLP.bgCard))).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(hexToRgbArr(GLP.borderDim), hexToRgbArr(GLP.bgChart))).toBeGreaterThanOrEqual(3);
  });

  it('borderDim is no longer identical to bgChart (previously an invisible stroke)', () => {
    for (const [accent, theme] of combos) {
      const GLP = buildPalette(accent, theme);
      expect(GLP.borderDim).not.toBe(GLP.bgChart);
    }
  });

  it('text roles clear 4.5:1 against every surface, for every mirrored theme/accent combo', () => {
    for (const gray of Object.values(CARD_TOKENS.gray)) {
      for (const bgKey of ['950', '900', '800']) {
        for (const textKey of ['200', '400', '500']) {
          const ratio = contrastRatio(hexToRgbArr(gray[textKey]), hexToRgbArr(gray[bgKey]));
          expect(ratio).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('LINE_COLORS has an entry for every CARD_TOKENS.gray combo', () => {
    expect(Object.keys(LINE_COLORS).sort()).toEqual(Object.keys(CARD_TOKENS.gray).sort());
  });

  // #811 "Instrument" Fix 2: the chart's own bgChart/border box is gone on
  // the current palette, so its axis gridlines/labels (still GLP.border/
  // GLP.textMute) now render directly against GLP.bg (the page background)
  // instead. This was never checked before -- the box always stood between
  // them -- so it needs its own assertion, not just the bgChart/bgCard one
  // above.
  it('border/borderDim also clear 3:1 against bg (#811 Fix 2: chart lost its bgChart backdrop)', () => {
    for (const [accent, theme] of combos) {
      const GLP = buildPalette(accent, theme);
      expect(contrastRatio(hexToRgbArr(GLP.border), hexToRgbArr(GLP.bg))).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hexToRgbArr(GLP.borderDim), hexToRgbArr(GLP.bg))).toBeGreaterThanOrEqual(3);
    }
  });

  // The frozen legacy line colour was only ever lifted against bgChart/
  // bgCard (see LINE_COLORS above) and was NEVER meant to stand against bg
  // directly -- it measures well under 3:1 there. This is exactly why Fix 2
  // keeps LEGACY_GLP's chart box: removing it would silently regress this.
  it('legacy border fails 3:1 against bg -- documents why Fix 2 keeps the legacy chart box', () => {
    const legacy = buildPalette();
    expect(contrastRatio(hexToRgbArr(legacy.border), hexToRgbArr(legacy.bg))).toBeLessThan(3);
  });
});

// #811 "Instrument" Fix 1 + Fix 2: generateShareCard() end-to-end render
// checks. Pixel-sampled against the actual PNG output (decoded back via
// @napi-rs/canvas) rather than asserting on canvas mock-call args, so these
// catch what the eye would actually see.
function makeTestShot(id) {
  return {
    id,
    timestamp: 1700000000,
    duration: 280,
    annotation: { coffee: 'Test Bean', dose: 15, totalWeight: 36 },
    datapoints: {
      pressure: Array.from({ length: 30 }, (_, i) => 50 + i * 2),
      temperature: Array(30).fill(930),
      timeInShot: Array.from({ length: 30 }, (_, i) => i * 10),
    },
  };
}

async function decodePixels(pngBuffer) {
  const img = await loadImage(pngBuffer);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { ctx, width: img.width, height: img.height };
}

function countColor(imageData, [r, g, b]) {
  const d = imageData.data;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === r && d[i + 1] === g && d[i + 2] === b) count++;
  }
  return count;
}

// Old ring badge centre -- scx/scy from the (now legacy-only) SCORE BADGE
// block in lib/card.js: scx = W - PX - 88, scy = BAR_H + HH + 90.
const RING_CX = 1080 - 52 - 88;
const RING_CY = 4 + 76 + 90;

describe('generateShareCard() ring removal (#811 "Instrument" Fix 1)', () => {
  it('current palette: nothing is drawn at the old ring centre any more -- identical with and without a score', async () => {
    const withScore = await generateShareCard(makeTestShot(1), 87, 'square', 'amber', 'dark');
    const noScore   = await generateShareCard(makeTestShot(1), null, 'square', 'amber', 'dark');
    const { ctx: ctxWith } = await decodePixels(withScore);
    const { ctx: ctxNo }   = await decodePixels(noScore);
    expect(Array.from(ctxWith.getImageData(RING_CX, RING_CY, 1, 1).data))
      .toEqual(Array.from(ctxNo.getImageData(RING_CX, RING_CY, 1, 1).data));
  });

  it('legacy snapshot (buildPalette() with no args): still paints the ring disc at the same centre, unchanged', async () => {
    const withScore = await generateShareCard(makeTestShot(2), 87, 'square');
    const noScore   = await generateShareCard(makeTestShot(2), null, 'square');
    const { ctx: ctxWith } = await decodePixels(withScore);
    const { ctx: ctxNo }   = await decodePixels(noScore);
    expect(Array.from(ctxWith.getImageData(RING_CX, RING_CY, 1, 1).data))
      .not.toEqual(Array.from(ctxNo.getImageData(RING_CX, RING_CY, 1, 1).data));
  });

  it('current palette: draws the score number itself, in scoreColor(), on the verdict line -- not just the phrase (which the pre-#811 code already drew there)', async () => {
    const buf = await generateShareCard(makeTestShot(5), 87, 'square', 'amber', 'dark');
    const { ctx } = await decodePixels(buf);
    const GLP    = buildPalette('amber', 'dark');
    const sColor = scoreColor(87, GLP);
    // Wide strip just below the headline baseline where the verdict number/
    // separator/phrase line sits (left-aligned at PX=52). A solid count of
    // exact sColor pixels there can only come from the bold 62px score
    // digits -- the phrase text itself is always GLP.textDim, never sColor,
    // so this fails if the number is dropped and only the phrase survives.
    const count = countColor(ctx.getImageData(52, 150, 400, 80), hexToRgbArr(sColor));
    expect(count).toBeGreaterThan(200);
  });
});

describe('generateShareCard() chart container removal (#811 "Instrument" Fix 2)', () => {
  it('current palette: the large bgChart-filled chart box is gone -- only the small legend/stat chips still use that colour', async () => {
    const buf = await generateShareCard(makeTestShot(3), 87, 'square', 'amber', 'dark');
    const { ctx, width, height } = await decodePixels(buf);
    const GLP = buildPalette('amber', 'dark');
    const count = countColor(ctx.getImageData(0, 0, width, height), hexToRgbArr(GLP.bgChart));
    // Legend/stat chips alone total a few thousand px; the old chart box
    // covered several hundred thousand -- a wide, unambiguous margin.
    expect(count).toBeLessThan(20000);
  });

  it('legacy snapshot: the chart still paints its large bgChart-filled box, unchanged', async () => {
    const buf = await generateShareCard(makeTestShot(4), 87, 'square');
    const { ctx, width, height } = await decodePixels(buf);
    const legacy = buildPalette();
    const count = countColor(ctx.getImageData(0, 0, width, height), hexToRgbArr(legacy.bgChart));
    expect(count).toBeGreaterThan(100000);
  });
});

// #873 follow-up: the header/footer lost their accent bar and boxed fills on
// the current palette (only a 1px GLP.border hairline remains under the
// header and above the footer), and Story format additionally drops the
// shot#/date meta text from the header's top-right corner entirely.
describe('generateShareCard() header/footer boxless treatment (#873 follow-up)', () => {
  it('current palette, story format: the header top-right corner has nothing drawn in it -- no stray meta/footer text bleeding in', async () => {
    const buf = await generateShareCard(makeTestShot(6), 87, 'story', 'amber', 'dark');
    const { ctx, width } = await decodePixels(buf);
    const GLP = buildPalette('amber', 'dark');
    const bg = hexToRgbArr(GLP.bg);
    // Header is 76px tall (HH) starting at y=0 (no accent bar) on the current
    // palette, with a 1px GLP.border hairline right at its bottom edge
    // (y~75-76) -- that hairline is intentional and, being a 1px stroke at a
    // half-pixel-centred path, antialiases into a blend of GLP.border/GLP.bg
    // rather than either exact color, so it's excluded from this scan by
    // stopping at y=70. Everything above that, in the top-right quadrant
    // where the old shot#/date meta text used to sit, must be pure
    // background -- anything else means something is drawing where that
    // meta text used to go.
    const data = ctx.getImageData(700, 0, width - 700, 70).data;
    let stray = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== bg[0] || data[i + 1] !== bg[1] || data[i + 2] !== bg[2]) stray++;
    }
    expect(stray).toBe(0);
  });

  it('current palette, square format: the header top-right corner still shows the shot#/date meta text (unlike story format above)', async () => {
    const buf = await generateShareCard(makeTestShot(7), 87, 'square', 'amber', 'dark');
    const { ctx } = await decodePixels(buf);
    const GLP = buildPalette('amber', 'dark');
    const count = countColor(ctx.getImageData(700, 0, 380, 76), hexToRgbArr(GLP.textDim));
    expect(count).toBeGreaterThan(50);
  });

  it('legacy snapshot: header keeps its accent bar and filled box, unchanged', async () => {
    const buf = await generateShareCard(makeTestShot(8), 87, 'square');
    const { ctx, width } = await decodePixels(buf);
    const legacy = buildPalette();
    // Accent bar (y=0..4) is a gradient between accentFrom/accentTo -- just
    // confirm it's neither the page bg nor fully transparent, i.e. something
    // was actually painted there.
    const barPx = Array.from(ctx.getImageData(Math.round(width / 2), 2, 1, 1).data);
    expect(barPx.slice(0, 3)).not.toEqual(hexToRgbArr(legacy.bg));
    // Header box (bgCard fill) still present just under the bar.
    const headerCount = countColor(ctx.getImageData(0, 10, width, 60), hexToRgbArr(legacy.bgCard));
    expect(headerCount).toBeGreaterThan(10000);
  });

  // Story format's canvas is 1920px tall vs square's 1080px -- #873 follow-up
  // removed the old capping that kept the chart near-square in story format
  // and split the freed height into blank padding above/below it. The chart
  // should now grow into that freed height instead. Measured indirectly via
  // the pressure line's own vertical pixel span (GLP.cPressure, #3498db):
  // since the same data always occupies the same 0-12 bar fraction of the
  // plot, a taller plot stretches that line's absolute pixel span
  // proportionally. Empirically (this fixture): capped-old span ~950px,
  // fixed-new span ~1296px, new square format span ~456px -- the >2.3x
  // threshold below sits well clear of both the old-capped ratio (~2.1x)
  // and the new, fixed ratio (~2.8x).
  it('current palette: story format chart is taller than a simple 1.78x scale-up of square would explain -- it fills the freed height rather than staying capped near-square', async () => {
    const storyBuf  = await generateShareCard(makeTestShot(9), 87, 'story', 'amber', 'dark');
    const squareBuf = await generateShareCard(makeTestShot(10), 87, 'square', 'amber', 'dark');
    const cPressure = hexToRgbArr(buildPalette('amber', 'dark').cPressure);

    async function pressureLineSpan(buf) {
      const { ctx, width, height } = await decodePixels(buf);
      const data = ctx.getImageData(0, 0, width, height).data;
      let minY = null, maxY = null;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - cPressure[0]) <= 20 &&
              Math.abs(data[i + 1] - cPressure[1]) <= 20 &&
              Math.abs(data[i + 2] - cPressure[2]) <= 20) {
            if (minY === null) minY = y;
            maxY = y;
          }
        }
      }
      return maxY - minY;
    }

    const storySpan  = await pressureLineSpan(storyBuf);
    const squareSpan = await pressureLineSpan(squareBuf);
    expect(storySpan).toBeGreaterThan(squareSpan * 2.3);
  });
});

// #462's legacy snapshot must stay byte-for-byte so old cached/bookmarked
// card links keep looking exactly the way they always did -- this includes
// the borderDim === bgChart quirk being fixed above for the live path.
describe('buildPalette() legacy snapshot (#462)', () => {
  it('is untouched by the #811 token/line-colour work', () => {
    const GLP = buildPalette();
    expect(GLP.bg).toBe('#09090b');
    expect(GLP.border).toBe('#3f3f46');
    expect(GLP.borderDim).toBe('#27272a');
    expect(GLP.bgChart).toBe('#27272a');
  });
});


// scoreColor() previously used its own 80/60 thresholds and
// accentFrom/textDim/textMute -- a shared card could tell a different
// score story than the live UI's own scoreColor() (public-src/utils.js),
// which is var(--ok) >=90 / var(--warn) >=70 / var(--err) below, the "Score-
// Skala bleibt: grün >= 90, gelb >= 70, rot darunter" rule from the redesign
// plan. Now both agree.
describe('scoreColor() (#811)', () => {
  const GLP = buildPalette('amber', 'dark');

  it('is green (--ok) at and above 90', () => {
    expect(scoreColor(90, GLP)).toBe(GLP.ok);
    expect(scoreColor(99, GLP)).toBe(GLP.ok);
  });

  it('is yellow (--warn) from 70 up to (not including) 90', () => {
    expect(scoreColor(70, GLP)).toBe(GLP.warn);
    expect(scoreColor(89, GLP)).toBe(GLP.warn);
  });

  it('is red (--err) below 70', () => {
    expect(scoreColor(69, GLP)).toBe(GLP.err);
    expect(scoreColor(0, GLP)).toBe(GLP.err);
  });

  it('falls back to textMute when there is no score at all', () => {
    expect(scoreColor(null, GLP)).toBe(GLP.textMute);
  });

  // The frozen LEGACY_GLP snapshot (buildPalette() with no args, #462) has
  // no ok/warn/err -- old cached card links must keep rendering with the
  // original 80/60 thresholds, not silently pick up the new 90/70 ones.
  it('keeps the original 80/60 logic on the legacy snapshot, unchanged', () => {
    const legacy = buildPalette();
    expect(scoreColor(85, legacy)).toBe(legacy.accentFrom);
    expect(scoreColor(65, legacy)).toBe(legacy.textDim);
    expect(scoreColor(50, legacy)).toBe(legacy.textMute);
  });
});
