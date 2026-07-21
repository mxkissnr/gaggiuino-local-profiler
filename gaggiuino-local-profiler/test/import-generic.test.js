import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parseGenericShopifyProduct, parseOpenGraph, findDuplicateBean, enrichGenericBeanFromHtml } = require('../lib/import-generic');

describe('parseGenericShopifyProduct', () => {
    // Minimal synthetic fixture mirroring a real case (#400, verified against
    // sproutcoffeeroasters.art): the shop misuses the Shopify vendor field for
    // a taste-profile tag instead of the roaster name, and the description
    // uses English specialty-coffee vocabulary that wasn't in the curated
    // flavor list. No real shop content beyond these few words is committed.
    const product = {
        title: 'Lasso Lassi',
        vendor: 'adventurous',
        description: '<p>Lychee pop, juicy Tropical sweetness, creamy lactic Lassi finish.</p>',
        price: 1500,
    };

    it('falls back to the shop domain when the vendor field is not a roaster name', () => {
        const bean = parseGenericShopifyProduct(product, 'sproutcoffeeroasters.art');
        expect(bean.roaster).toBe('sproutcoffeeroasters.art');
        expect(bean.flavors.length).toBeGreaterThan(0);
        expect(bean.flavors).toEqual(expect.arrayContaining(['Lychee', 'Tropical', 'Lactic']));
    });

    it('keeps a real-looking vendor name as the roaster', () => {
        const bean = parseGenericShopifyProduct({ ...product, vendor: 'Elbgold Kaffeerösterei' }, 'elbgold.com');
        expect(bean.roaster).toBe('Elbgold Kaffeerösterei');
    });

    it('returns null when there is no title', () => {
        expect(parseGenericShopifyProduct({ vendor: 'adventurous' }, 'example.com')).toBeNull();
    });

    // #423, verified against sproutcoffeeroasters.art: a "Profile" option
    // listing which roast styles are actually buyable is a more reliable
    // roastType signal than tags, which can be an aspirational superset
    // (tags naming Espresso/Filter/Omni even when only two variants exist).
    it('derives roastType from a profile/roast option before falling back to tags', () => {
        const withOption = {
            ...product,
            tags: ['Roast_Espresso', 'Roast_Filter', 'Roast_Omni'],
            options: [{ name: 'Profile', values: ['Espresso', 'Filter'] }],
        };
        expect(parseGenericShopifyProduct(withOption, 'sproutcoffeeroasters.art').roastType).toBe('omni');

        const espressoOnly = {
            ...product,
            tags: ['Roast_Espresso', 'Roast_Filter', 'Roast_Omni'],
            options: [{ name: 'Roast', values: ['Espresso'] }],
        };
        expect(parseGenericShopifyProduct(espressoOnly, 'sproutcoffeeroasters.art').roastType).toBe('espresso');
    });

    it('falls back to tags-based roastType when no profile/roast option exists', () => {
        const tagsOnly = { ...product, tags: ['Roast_Filter'] };
        expect(parseGenericShopifyProduct(tagsOnly, 'sproutcoffeeroasters.art').roastType).toBe('filter');
    });

    it('leaves roastType null when neither options nor tags name a roast style', () => {
        expect(parseGenericShopifyProduct(product, 'sproutcoffeeroasters.art').roastType).toBeNull();
    });
});

describe('enrichGenericBeanFromHtml', () => {
    // Trimmed reconstruction of sproutcoffeeroasters.art/products/flower-power
    // (#423, ground truth pulled 2026-07-21) — just the title/subtitle group
    // and the two accordions the enrichment reads, no nav/checkout/PayPal
    // markup. Real product copy, shortened structure.
    const sproutHtml = `
        <div class="group-block-content">
            <div class="text-block h2"><h1>Flower Power</h1></div>
            <div class="text-block h4"><p>White Peach, Strawberry, Jasmine</p></div>
            <product-price>€18,00</product-price>
        </div>
        <details class="details">
            <summary class="details__header">Details</summary>
            <div class="details-content">
                <p>Process - Anaerobic Natural</p><p>Variety - 74112, 74110</p><p>Producer - Producers in the Yirgacheffe region</p><p>Origin - Banko Chelchele, Gedeb Zone, Southern Ethiopia</p><p>Elevation - 1900-2300 MASL</p>
            </div>
        </details>
        <details class="details">
            <summary class="details__header">Brew Guide</summary>
            <div class="details-content">
                <p><span class="metafield-multi_line_text_field">Espresso<br>
                In: 19.7g<br>
                Out: 48g for a double, split to make 2 x ~24g single espressos.<br>
                Time: 27-29 seconds<br>
                Ratio: 1 - 2.4<br>
                Temp: 92-93 Celsius<br>
                <br>
                Milky Espresso<br>
                In: 20g<br>
                Out: 38g for a double, split to make 2x19g single shots.<br>
                Time: 28-30 seconds<br>
                Ratio: 1 - 1.9<br>
                Temp: 92-93 Celsius</span></p>
            </div>
        </details>
    `;

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
