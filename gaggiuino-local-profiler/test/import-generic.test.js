import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parseOpenGraph, findDuplicateBean } = require('../lib/import-generic');

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
