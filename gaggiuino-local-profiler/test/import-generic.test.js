import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cheerio = require('cheerio');

const { parseGenericShopifyProduct, parseOpenGraph, findDuplicateBean, enrichGenericBeanFromHtml } = require('../lib/import-generic');

// #555: real fixtures instead of hand-reconstructed ones, following the
// pattern test/import-parsers.test.js already uses for hoplo/elbgold.
//
// - sprout-flower-power.json: sproutcoffeeroasters.art's own
//   /products/flower-power.js Shopify product JSON endpoint, fetched
//   2026-07-29, unmodified.
// - sprout-flower-power.html: trimmed real HTML from the same product page
//   (title/subtitle block + the "Details" and "Brew Guide" accordions) —
//   see the fixture file's own header comment.
// - squaremile-red-brick.html: trimmed real HTML from
//   shop.squaremilecoffee.com/products/red-brick via a web.archive.org
//   capture (the live page has since dropped the bullet-recipe section,
//   #499) — origin-wrapper blend markup, .additional-info flavor line, and
//   .recipe-bullet "RECIPE DETAILS" block.
const sproutProduct = JSON.parse(readFileSync(new URL('./fixtures/sprout-flower-power.json', import.meta.url), 'utf8'));
const sproutHtml     = readFileSync(new URL('./fixtures/sprout-flower-power.html', import.meta.url), 'utf8');
const squaremileHtml = readFileSync(new URL('./fixtures/squaremile-red-brick.html', import.meta.url), 'utf8');

// squaremile-red-brick.html is inherently a two-component blend page (real
// products don't come in a conveniently single-origin variant) — the #471
// (pre-blend, single-origin) test scenarios need just one .origin-content
// block, sliced from the real fixture via cheerio rather than hand-typed.
const $squaremile          = cheerio.load(squaremileHtml);
const originWrapperHtml    = $squaremile.html($squaremile('.origin-content').first());
const additionalInfoHtml   = $squaremile.html($squaremile('.additional-info').first());
const bulletRecipeHtml     = $squaremile.html($squaremile('.recipe-bullet').first());

describe('parseGenericShopifyProduct', () => {
    it('falls back to the shop domain when the vendor field is not a roaster name', () => {
        // #400, verified against sproutcoffeeroasters.art: the shop misuses
        // the Shopify vendor field for a taxonomy tag ("adventurous")
        // instead of the roaster name.
        const bean = parseGenericShopifyProduct(sproutProduct, 'sproutcoffeeroasters.art');
        expect(bean.roaster).toBe('sproutcoffeeroasters.art');
        expect(bean.flavors).toContain('Jasmin'); // from the "Jasmine Petals" description prose
    });

    it('keeps a real-looking vendor name as the roaster', () => {
        const bean = parseGenericShopifyProduct({ ...sproutProduct, vendor: 'Elbgold Kaffeerösterei' }, 'elbgold.com');
        expect(bean.roaster).toBe('Elbgold Kaffeerösterei');
    });

    it('returns null when there is no title', () => {
        expect(parseGenericShopifyProduct({ vendor: 'adventurous' }, 'example.com')).toBeNull();
    });

    // #423, verified against sproutcoffeeroasters.art: a "Profile" option
    // listing which roast styles are actually buyable is a more reliable
    // roastType signal than tags, which can be an aspirational superset
    // (tags naming Espresso/Filter/Omni even when only two variants exist).
    // The real product's own options already exercise this (Profile:
    // Espresso+Filter -> omni); espresso-only and tags-only are derived
    // variants of the same real product, overriding just the field each
    // scenario needs.
    it('derives roastType from a profile/roast option before falling back to tags', () => {
        expect(parseGenericShopifyProduct(sproutProduct, 'sproutcoffeeroasters.art').roastType).toBe('omni');

        const espressoOnly = { ...sproutProduct, options: [{ name: 'Profile', values: ['Espresso'] }] };
        expect(parseGenericShopifyProduct(espressoOnly, 'sproutcoffeeroasters.art').roastType).toBe('espresso');
    });

    it('falls back to tags-based roastType when no profile/roast option exists', () => {
        const tagsOnly = { ...sproutProduct, options: [], tags: ['Roast_Filter'] };
        expect(parseGenericShopifyProduct(tagsOnly, 'sproutcoffeeroasters.art').roastType).toBe('filter');
    });

    it('leaves roastType null when neither options nor tags name a roast style', () => {
        const noRoastSignal = { ...sproutProduct, options: [], tags: [] };
        expect(parseGenericShopifyProduct(noRoastSignal, 'sproutcoffeeroasters.art').roastType).toBeNull();
    });
});

describe('enrichGenericBeanFromHtml', () => {
    const jsonOnlyBean = {
        name: 'Flower Power', roaster: 'sproutcoffeeroasters.art', notes: '',
        flavors: ['Jasmin'], origin: 'ET', origins: [{ code: 'ET' }],
        roastType: 'omni', imageUrl: null, price_eur: 18, importedAt: '2026-07-21',
    };

    it('fills in process/variety/producer/region/altitude_m from the Details accordion', () => {
        const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
        expect(bean.process).toBe('Anaerobic Natural');
        expect(bean.variety).toBe('74112, 74110');
        expect(bean.producer).toBe('Producers in the Yirgacheffe region');
        expect(bean.region).toBe('Banko Chelchele, Gedeb Zone, Southern Ethiopia');
        expect(bean.altitude_m).toBe(2100);
    });

    it('merges the h4 tasting-notes subtitle into flavors without dropping JSON-derived flavors', () => {
        const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
        expect(bean.flavors).toEqual(expect.arrayContaining(['Jasmin', 'White Peach', 'Strawberry', 'Jasmine']));
    });

    it('captures only the plain espresso recipe from the Brew Guide accordion, not Milky Espresso', () => {
        const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
        expect(bean.notes).toContain('Roaster brew guide (espresso):');
        expect(bean.notes).toContain('In: 19.7g');
        expect(bean.notes).toContain('Ratio: 1 - 2.4');
        expect(bean.notes).not.toContain('Milky Espresso');
    });

    it('never overwrites a field the JSON already populated', () => {
        const preFilled = { ...jsonOnlyBean, process: 'Washed', notes: 'already has notes' };
        const bean = enrichGenericBeanFromHtml(preFilled, sproutHtml);
        expect(bean.process).toBe('Washed');
        expect(bean.notes).toBe('already has notes');
    });

    // #433: real-world re-import ground truth (sproutcoffeeroasters.art/products/flower-power)
    // showed the structured brew fields staying empty even though the brew
    // guide text (asserted above) clearly contains them.
    describe('brew field extraction (#433)', () => {
        it('maps the espresso block\'s Temp/Time/Ratio lines into brewTempC/brewTimeS/brewRatio, resolving ranges via midpoint', () => {
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
            expect(bean.brewTempC).toBe(92.5); // midpoint of 92-93
            expect(bean.brewTimeS).toBe(28);   // round(midpoint(27,29))
            expect(bean.brewRatio).toBe('1:2.4'); // reformatted, not averaged
        });

        it('maps the pre-infusion caveat sentence into brewNotes even though it is nested under a different heading than the chosen recipe block', () => {
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
            expect(bean.brewNotes).toMatch(/^We have a slow/);
            expect(bean.brewNotes).toContain('avoid overextraction');
        });

        it('never overwrites brew fields the JSON/form already populated', () => {
            const preFilled = { ...jsonOnlyBean, brewTempC: 94, brewRatio: '1:2', brewTimeS: 30, brewNotes: 'existing note' };
            const bean = enrichGenericBeanFromHtml(preFilled, sproutHtml);
            expect(bean.brewTempC).toBe(94);
            expect(bean.brewRatio).toBe('1:2');
            expect(bean.brewTimeS).toBe(30);
            expect(bean.brewNotes).toBe('existing note');
        });

        it('leaves brew fields unset when there is no Brew Guide accordion', () => {
            const plainHtml = '<html><body><h1>Some Product</h1><p>Just a description.</p></body></html>';
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, plainHtml);
            expect(bean.brewTempC).toBeUndefined();
            expect(bean.brewRatio).toBeUndefined();
        });
    });

    // #451: "Milky Espresso" used to be discarded entirely once "Espresso"
    // was chosen for the bean's own brewTempC/brewRatio — now surfaced as an
    // opt-in Library Recipe import candidate instead.
    describe('extra brew guide recipe candidates (#451)', () => {
        it('surfaces the discarded Milky Espresso block as an extraBrewRecipes candidate', () => {
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, sproutHtml);
            expect(bean.extraBrewRecipes).toHaveLength(1);
            const recipe = bean.extraBrewRecipes[0];
            expect(recipe.name).toBe('Milky Espresso');
            expect(recipe.targetDose_g).toBe(20);
            expect(recipe.targetYield_g).toBe(38); // first number only, ignores "for a double, split..."
            expect(recipe.targetTime_s).toBe(29);  // round(midpoint(28,30))
            expect(recipe.waterTemp_c).toBe(92.5);
            expect(recipe.notes).toContain('Milky Espresso');
            expect(recipe.notes).toContain('In: 20g');
        });

        it('does not surface extraBrewRecipes when there is only one recipe block', () => {
            const html = '<details><summary>Brew Guide</summary><div class="details-content">'
                + '<p><span>Espresso<br>In: 19.7g<br>Out: 48g<br>Time: 27-29 seconds<br>Ratio: 1 - 2.4<br>Temp: 92-93 Celsius</span></p>'
                + '</div></details>';
            const bean = enrichGenericBeanFromHtml({ ...jsonOnlyBean, notes: '' }, html);
            expect(bean.extraBrewRecipes).toBeUndefined();
        });
    });

    // #433: reported symptom was literally "EspressoIn: 19.7gOut: 48g" — a
    // minified page's <br> tags with zero surrounding whitespace, which the
    // old code's plain .text() concatenated with no separator at all.
    it('keeps recipe lines separated even when the source HTML has no whitespace around <br> tags', () => {
        const minifiedBean = { ...jsonOnlyBean, notes: '' };
        const html = '<details><summary>Brew Guide</summary><div class="details-content">'
            + '<p><span>Espresso<br>In: 19.7g<br>Out: 48g<br>Time: 27-29 seconds<br>Ratio: 1 - 2.4<br>Temp: 92-93 Celsius</span></p>'
            + '</div></details>';
        const bean = enrichGenericBeanFromHtml(minifiedBean, html);
        expect(bean.notes).not.toContain('EspressoIn');
        expect(bean.notes).not.toContain('19.7gOut');
        expect(bean.notes).toContain('In: 19.7g');
        expect(bean.notes).toContain('Out: 48g');
        expect(bean.brewTempC).toBe(92.5);
        expect(bean.brewTimeS).toBe(28);
        expect(bean.brewRatio).toBe('1:2.4');
    });

    // #433: cheerio's plain .text() concatenates adjacent block-level content
    // (e.g. sibling <div> lines with no <br> and no separating whitespace)
    // with no separator at all — verify label/value scanning still works
    // for that shape, not just the <p>-tag/<br> shapes already covered above.
    it('reads label/value lines correctly when an accordion uses <div>-per-line with no separating whitespace', () => {
        const divHtml = `
            <details class="details">
                <summary class="details__header">Details</summary>
                <div class="details-content"><div>Process - Washed</div><div>Variety - Bourbon</div></div>
            </details>
        `;
        const bean = enrichGenericBeanFromHtml(jsonOnlyBean, divHtml);
        expect(bean.process).toBe('Washed');
        expect(bean.variety).toBe('Bourbon');
    });

    // #433, verified against sproutcoffeeroasters.art: the Shopify vendor
    // field is a taxonomy tag ("adventurous"), so parseGenericShopifyProduct
    // (tested above) falls back to the bare hostname — the HTML enrichment
    // pass should still recover a real display name when the page has one.
    describe('roaster fallback via og:site_name / logo alt (#433)', () => {
        const hostFallbackBean = { ...jsonOnlyBean, roaster: 'sproutcoffeeroasters.art' };

        it('prefers og:site_name when present', () => {
            const html = '<html><head><meta property="og:site_name" content="Sprout Coffee Roasters"></head><body></body></html>';
            const bean = enrichGenericBeanFromHtml(hostFallbackBean, html, 'sproutcoffeeroasters.art');
            expect(bean.roaster).toBe('Sprout Coffee Roasters');
        });

        it('falls back to the header-logo alt text when og:site_name is absent', () => {
            const html = '<html><body><img class="header-logo__image" alt="Sprout Coffee Roasters - Home"></body></html>';
            const bean = enrichGenericBeanFromHtml(hostFallbackBean, html, 'sproutcoffeeroasters.art');
            expect(bean.roaster).toBe('Sprout Coffee Roasters');
        });

        it('never overwrites a roaster that already looks like a real vendor name', () => {
            const realVendorBean = { ...jsonOnlyBean, roaster: 'Elbgold Kaffeerösterei' };
            const html = '<html><head><meta property="og:site_name" content="Some Other Shop"></head><body></body></html>';
            const bean = enrichGenericBeanFromHtml(realVendorBean, html, 'elbgold.com');
            expect(bean.roaster).toBe('Elbgold Kaffeerösterei');
        });

        it('leaves the hostname fallback in place when the HTML has no usable name signal either', () => {
            const bean = enrichGenericBeanFromHtml(hostFallbackBean, '<html><body><h1>No signals here</h1></body></html>', 'sproutcoffeeroasters.art');
            expect(bean.roaster).toBe('sproutcoffeeroasters.art');
        });
    });

    // #471, ground truth: shop.squaremilecoffee.com/products/red-brick — the
    // "Coffee information" origin-wrapper markup, no <details>/.details-content
    // anywhere on the page. originWrapperHtml is the first of the real,
    // fetched page's two .origin-content blend blocks (see the fixture-load
    // comment at the top of this file) — real markup, sliced to one
    // component for these pre-blend (#471) scenarios.
    describe('origin-wrapper markup (#471, no <details> accordion on the page)', () => {
        const jsonOnlyBean2 = { name: 'Red Brick', roaster: 'Square Mile Coffee Roasters', origins: [] };

        it('fills process/variety/producer/region from .origin-title + sibling <p> pairs', () => {
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean2, originWrapperHtml);
            expect(bean.process).toBe('White Honey');
            expect(bean.variety).toBe('Catuaí, Caturra');
            expect(bean.producer).toBe('Puente Tarrazú Micromill');
            expect(bean.region).toBe('Costa Rica');
        });

        it('resolves the Country label into an ISO origin code', () => {
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean2, originWrapperHtml);
            expect(bean.origin).toBe('CR');
            expect(bean.origins).toEqual([{ code: 'CR' }]);
        });

        it('never overwrites a field the <details> accordion scan already found', () => {
            const both = `${sproutHtml}${originWrapperHtml}`;
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, both);
            expect(bean.process).toBe('Anaerobic Natural');
        });

        it('leaves a field empty when neither scanner finds it (no elevation label present)', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, originWrapperHtml);
            expect(bean.altitude_m).toBeUndefined();
        });

        // #495, ground truth: shop.squaremilecoffee.com/products/red-brick —
        // tasting notes render as a single all-caps, slash-separated line
        // rather than the short comma-separated h4 subtitle #423 covers.
        it('fills flavors from an all-caps slash-separated .additional-info line, title-cased', () => {
            const html = `${originWrapperHtml}${additionalInfoHtml}`;
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, html);
            expect(bean.flavors).toEqual(['Plum', 'Chocolate', 'Hazelnut', 'Raisin']);
        });

        it('merges .additional-info flavors alongside a JSON-derived flavor instead of overwriting it', () => {
            const html = `${originWrapperHtml}${additionalInfoHtml}`;
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick', flavors: ['Jasmin'] }, html);
            expect(bean.flavors).toEqual(['Jasmin', 'Plum', 'Chocolate', 'Hazelnut', 'Raisin']);
        });

        it('ignores .additional-info when it has no slash (not a flavor list)', () => {
            const html = `${originWrapperHtml}<h5 class="additional-info">Free Shipping UK Wide</h5>`;
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, html);
            expect(bean.flavors).toBeUndefined();
        });
    });

    // #498, ground truth: shop.squaremilecoffee.com/products/red-brick — a
    // blend of two origins, each its own .origin-content block. blendHtml
    // (the squaremileHtml fixture, unsliced) is both real .origin-content
    // blocks, unlike originWrapperHtml above (the first block only).
    describe('origin-wrapper blends (#498, multiple .origin-content blocks)', () => {
        const blendHtml = squaremileHtml;

        it('joins each field across both blend components instead of keeping only the first', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, blendHtml);
            expect(bean.process).toBe('White Honey / Washed');
            expect(bean.variety).toBe('Catuaí, Caturra / Catuaí, Bourbon, Caturra');
            expect(bean.producer).toBe('Puente Tarrazú Micromill / Chacayá Producer Group');
            expect(bean.region).toBe('Costa Rica / Guatemala');
        });

        it('resolves both blend origins into distinct ISO codes', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick', origins: [] }, blendHtml);
            expect(bean.origins).toEqual(expect.arrayContaining([{ code: 'CR' }, { code: 'GT' }]));
            expect(bean.origins).toHaveLength(2);
        });

        it('still resolves a single-origin (non-blend) page to one field value, unchanged from before', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, originWrapperHtml);
            expect(bean.process).toBe('White Honey');
            expect(bean.region).toBe('Costa Rica');
        });
    });

    // #499, ground truth: shop.squaremilecoffee.com/products/red-brick —
    // brew recipe rendered as a plain bullet list, no <details> at all.
    describe('bullet-list recipe details (#499, no <details> Brew Guide accordion)', () => {
        it('extracts brewTempC from the Celsius half of a dual-unit temperature line', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, bulletRecipeHtml);
            expect(bean.brewTempC).toBe(94.25);
        });

        it('extracts brewTimeS as the range midpoint and brewRatio reformatted with a colon', () => {
            const bean = enrichGenericBeanFromHtml({ name: 'Red Brick' }, bulletRecipeHtml);
            expect(bean.brewTimeS).toBe(30);
            expect(bean.brewRatio).toBe('1:2');
        });

        it('never overwrites brew fields the <details> Brew Guide scan already found', () => {
            const both = `${sproutHtml}${bulletRecipeHtml}`;
            const bean = enrichGenericBeanFromHtml(jsonOnlyBean, both);
            expect(bean.brewTempC).toBe(92.5); // sprout's own midpoint, not 94.25
        });
    });

    it('returns the bean unchanged when the HTML has none of the recognized patterns', () => {
        const plainHtml = '<html><body><h1>Some Product</h1><p>Just a description, nothing structured.</p></body></html>';
        const bean = enrichGenericBeanFromHtml(jsonOnlyBean, plainHtml);
        expect(bean.process).toBeUndefined();
        expect(bean.variety).toBeUndefined();
        expect(bean.notes).toBe('');
        expect(bean.flavors).toEqual(['Jasmin']);
    });

    it('returns the bean unchanged for empty/missing HTML', () => {
        expect(enrichGenericBeanFromHtml(jsonOnlyBean, '')).toBe(jsonOnlyBean);
        expect(enrichGenericBeanFromHtml(jsonOnlyBean, null)).toBe(jsonOnlyBean);
        expect(enrichGenericBeanFromHtml(null, sproutHtml)).toBeNull();
    });
});

describe('parseOpenGraph', () => {
    it('returns null when there is no og:title', () => {
        expect(parseOpenGraph('<html><head></head><body></body></html>')).toBeNull();
    });

    it('uses og:site_name as the roaster fallback', () => {
        const html = `<html><head>
            <meta property="og:title" content="Ethiopia Yirgacheffe">
            <meta property="og:site_name" content="Elbgold Kaffeerösterei">
        </head><body></body></html>`;
        const bean = parseOpenGraph(html);
        expect(bean.roaster).toBe('Elbgold Kaffeerösterei');
    });

    it('leaves roaster null when og:site_name is absent', () => {
        const html = `<html><head><meta property="og:title" content="Ethiopia Yirgacheffe"></head><body></body></html>`;
        expect(parseOpenGraph(html).roaster).toBeNull();
    });

    it('reads price_eur from og:price:amount', () => {
        const html = `<html><head>
            <meta property="og:title" content="Ethiopia Yirgacheffe">
            <meta property="og:price:amount" content="16.90">
        </head><body></body></html>`;
        expect(parseOpenGraph(html).price_eur).toBe(16.9);
    });

    it('falls back to product:price:amount when og:price:amount is absent', () => {
        const html = `<html><head>
            <meta property="og:title" content="Ethiopia Yirgacheffe">
            <meta property="product:price:amount" content="12.50">
        </head><body></body></html>`;
        expect(parseOpenGraph(html).price_eur).toBe(12.5);
    });

    it('leaves price_eur null when no price meta tag is present or it does not parse', () => {
        const html = `<html><head>
            <meta property="og:title" content="Ethiopia Yirgacheffe">
            <meta property="og:price:amount" content="not-a-number">
        </head><body></body></html>`;
        expect(parseOpenGraph(html).price_eur).toBeNull();
    });

    it('scans the page body for origin/flavor when the meta description is thin', () => {
        // Meta description alone names no country and no flavor keyword.
        const html = `<html><head>
            <meta property="og:title" content="Hauskaffee">
            <meta property="og:description" content="Unser bester Kaffee.">
        </head><body>
            <main>
                <h2>Sensorik</h2>
                <p>Dieser Kaffee aus Äthiopien überzeugt mit Noten von Schokolade und Karamell.</p>
            </main>
        </body></html>`;
        const bean = parseOpenGraph(html);
        expect(bean.origins.map(o => o.code)).toContain('ET');
        expect(bean.flavors.length).toBeGreaterThan(0);
    });

    it('does not discard origin/flavor already found from meta text alone', () => {
        const html = `<html><head>
            <meta property="og:title" content="Kenya AA">
            <meta property="og:description" content="Bright acidity, notes of blackcurrant from Kenia, sehr lecker mit vielen weiteren Details in diesem langen Text der die Schwelle ueberschreitet.">
        </head><body>
            <main><p>Unrelated navigation and footer content, no country or flavor terms here.</p></main>
        </body></html>`;
        const bean = parseOpenGraph(html);
        expect(bean.origins.map(o => o.code)).toContain('KE');
    });

    it('does not scan the body when the meta text is already long and informative', () => {
        const html = `<html><head>
            <meta property="og:title" content="Kenya AA">
            <meta property="og:description" content="Bright acidity, notes of blackcurrant from Kenia, sehr lecker mit vielen weiteren Details in diesem langen Text der die Schwelle ueberschreitet.">
        </head><body>
            <main><p>Aus Äthiopien mit Noten von Schokolade.</p></main>
        </body></html>`;
        const bean = parseOpenGraph(html);
        // meta already gave a hit (Kenya); body's Ethiopia should not replace it
        expect(bean.origin).toBe('KE');
    });
});

describe('findDuplicateBean', () => {
    const beans = [
        { id: 1, name: 'Ethiopia Yirgacheffe', roaster: 'Elbgold', sourceUrl: 'https://elbgold.com/products/ethiopia' },
        { id: 2, name: 'House Blend', roaster: 'Some Roastery' },
    ];

    it('matches on exact sourceUrl', () => {
        const dup = findDuplicateBean({ name: 'Different Name', roaster: 'Different', sourceUrl: 'https://elbgold.com/products/ethiopia' }, beans);
        expect(dup?.id).toBe(1);
    });

    it('matches on case-insensitive name+roaster when no sourceUrl match', () => {
        const dup = findDuplicateBean({ name: 'house blend', roaster: 'SOME ROASTERY', sourceUrl: 'https://other.example/x' }, beans);
        expect(dup?.id).toBe(2);
    });

    it('returns null when nothing matches', () => {
        const dup = findDuplicateBean({ name: 'New Bean', roaster: 'New Roaster', sourceUrl: 'https://other.example/y' }, beans);
        expect(dup).toBeNull();
    });

    it('returns null for an empty/missing beans array', () => {
        expect(findDuplicateBean({ name: 'X', roaster: 'Y' }, undefined)).toBeNull();
    });
});
