import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { parseKaffeebraun, parseHoploProduct, hoploJsonUrl } = require('../lib/import-parsers');

const hoploFixture = JSON.parse(readFileSync(new URL('./fixtures/hoplo-shyira.json', import.meta.url), 'utf8'));

describe('parseHoploProduct', () => {
    it('extracts structured fields from the Shopify product JSON', () => {
        const bean = parseHoploProduct(hoploFixture);
        expect(bean).toMatchObject({
            name:    'Shyira Washed - Ruanda',
            roaster: 'Hoppenworth & Ploch',
            origin:  'RW',            // from the "Name - Land" title pattern
            variety: 'Red Bourbon',
            process: 'Washed',
            source:  'hoppenworth-ploch.de',
        });
        expect(bean.notes).toContain('Aprikose');
        expect(bean.notes).toContain('Herkunft: Nyabihu District'); // region stays in notes
        expect(bean.decaf).toBeUndefined();
    });

    it('detects the DECAF title prefix', () => {
        const bean = parseHoploProduct({ title: 'DECAF Sertao - Brasilien', vendor: 'Hoppenworth & Ploch', description: '' });
        expect(bean.decaf).toBe(true);
        expect(bean.origin).toBe('BR');
    });

    it('returns null without a title', () => {
        expect(parseHoploProduct({})).toBeNull();
        expect(parseHoploProduct(undefined)).toBeNull();
    });
});

describe('hoploJsonUrl', () => {
    it('rewrites product URLs (also with collection prefixes) to the JSON endpoint', () => {
        expect(hoploJsonUrl(new URL('https://hoppenworth-ploch.de/products/shyira-washed-ruanda')))
            .toBe('https://hoppenworth-ploch.de/products/shyira-washed-ruanda.js');
        expect(hoploJsonUrl(new URL('https://hoppenworth-ploch.de/collections/kaffee/products/cajamarca-peru?variant=1')))
            .toBe('https://hoppenworth-ploch.de/products/cajamarca-peru.js');
    });

    it('returns null for non-product URLs', () => {
        expect(hoploJsonUrl(new URL('https://hoppenworth-ploch.de/collections/kaffee'))).toBeNull();
    });
});

describe('parseKaffeebraun', () => {
    const page = `<html><body>
        <div class="product-detail-name"> El Cubanito </div>
        <table>
            <tr class="properties-row"><th class="properties-label">Aroma:</th><td class="properties-value"><span>Nuss</span><span>Tabak</span></td></tr>
            <tr class="properties-row"><th class="properties-label">Herkunft:</th><td class="properties-value"><span>Äthiopien</span></td></tr>
            <tr class="properties-row"><th class="properties-label">Varietät:</th><td class="properties-value"><span>Heirloom</span></td></tr>
            <tr class="properties-row"><th class="properties-label">Aufbereitungsart:</th><td class="properties-value"><span>Natural</span></td></tr>
        </table>
        <div class="degree roest"><span class="description">kräftig</span><span class="value-score">4</span></div>
    </body></html>`;

    it('maps a single-country Herkunft to the origin code and keeps it out of notes', () => {
        const bean = parseKaffeebraun(page);
        expect(bean).toMatchObject({ name: 'El Cubanito', origin: 'ET', variety: 'Heirloom', process: 'Natural' });
        expect(bean.notes).not.toContain('Herkunft');
        expect(bean.notes).toContain('Röstgrad: kräftig (4/5)');
    });

    it('keeps blends in the notes', () => {
        const blend = parseKaffeebraun(page.replace('Äthiopien', 'Brasilien, Indien'));
        expect(blend.origin).toBeNull();
        expect(blend.notes).toContain('Herkunft: Brasilien, Indien');
    });

    it('returns null when the page has no product', () => {
        expect(parseKaffeebraun('<html><body>nope</body></html>')).toBeNull();
    });
});
