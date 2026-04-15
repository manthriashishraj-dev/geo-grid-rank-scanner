/**
 * resolveTarget.js
 *
 * If the user supplies a businessName but no placeId, this module does a one-time
 * Google Maps search for that name and extracts the Place ID from the first result.
 *
 * The resolved placeId is then used for all N×N grid point rank checks, ensuring
 * consistent identification even if the business name changes slightly across search results.
 */

import { sleep } from 'crawlee';
import { extractPlaceIdFromCard, normaliseName } from './extractPlaceId.js';

/**
 * Resolve a Place ID from a business name using a live Google Maps search.
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page       Active Playwright page (already has proxy + anti-bot setup)
 * @param {string}  params.businessName                 Full business name to search for
 * @param {string}  [params.language]                   hl param for Google Maps (default 'en')
 * @returns {Promise<{placeId: string|null, resolvedName: string|null}>}
 */
export async function resolveTargetPlaceId({ page, businessName, language = 'en' }) {
    const query = encodeURIComponent(businessName);
    const url = `https://www.google.com/maps/search/${query}/?hl=${language}`;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Wait for at least one result card
    try {
        await page.waitForSelector('[role="feed"] > div, a[href*="/maps/place/"]', { timeout: 15000 });
    } catch {
        return { placeId: null, resolvedName: null };
    }

    // Get all result card elements
    const cards = await page.$$('[role="feed"] > div[jsaction]');

    for (const card of cards.slice(0, 5)) {
        const placeId = await extractPlaceIdFromCard(card);
        const nameEl = await card.$('[role="heading"], h3, .fontHeadlineSmall');
        const resolvedName = nameEl ? await nameEl.textContent() : null;

        if (placeId) {
            return { placeId, resolvedName: resolvedName?.trim() || businessName };
        }
    }

    // Fallback: try to grab ChIJ/hex from the page URL after clicking first result
    try {
        const firstLink = await page.$('a[href*="/maps/place/"]');
        if (firstLink) {
            const href = await firstLink.getAttribute('href');
            // Import inline to avoid circular dep
            const { extractPlaceIdFromUrl } = await import('./extractPlaceId.js');
            const placeId = extractPlaceIdFromUrl(href);
            if (placeId) return { placeId, resolvedName: businessName };
        }
    } catch { /* swallow */ }

    return { placeId: null, resolvedName: null };
}

/**
 * Verify that a found business name is a reasonable match for the target.
 * Used to catch false positives when resolving by name.
 *
 * @param {string} target    User-supplied business name
 * @param {string} found     Name found in Google Maps results
 * @returns {boolean}
 */
export function isNameMatch(target, found) {
    const t = normaliseName(target);
    const f = normaliseName(found);
    // Accept if either contains the first 6 chars of the other
    const prefix = t.slice(0, 6);
    return f.includes(prefix) || t.includes(f.slice(0, 6));
}
