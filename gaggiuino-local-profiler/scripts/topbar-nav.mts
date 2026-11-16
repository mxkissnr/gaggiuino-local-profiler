// Opens a desktop top bar tab in the Playwright scripts (#2079). Tabs that do
// not fit the row move into the "More" overflow menu, so clicking the tab by id
// only works while it is still visible; this helper falls back to the menu.

import type { Page } from 'playwright';

const ID_SELECTOR = /^#[A-Za-z][\w-]*$/;

/**
 * Clicks the top bar tab `selector`, directly when it is visible and through
 * the "More" menu (`#topbarNavMore`, one `[data-nav-target]` entry per hidden
 * tab) otherwise. Throws when the tab is reachable by neither route.
 */
export async function openTopbarTab(page: Page, selector: string): Promise<void> {
    if (!ID_SELECTOR.test(selector)) {
        throw new Error(`top bar tab selector must be a plain id like "#btnOrders", got ${selector}`);
    }

    const tab = page.locator(selector);
    if (await tab.isVisible()) {
        await tab.click();
        return;
    }

    const moreToggle = page.locator('#topbarNavMore > summary');
    if (!(await moreToggle.isVisible())) {
        throw new Error(`top bar tab ${selector} is neither visible nor in the More menu`);
    }

    const alreadyOpen = await page.locator('#topbarNavMore').evaluate(el => el.hasAttribute('open'));
    if (!alreadyOpen) await moreToggle.click();
    await page.locator(`#topbarNavMore [data-nav-target="${selector.slice(1)}"]`).click();
}
