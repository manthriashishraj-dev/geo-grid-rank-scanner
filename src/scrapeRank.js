/**
 * scrapeRank.js
 *
 * Navigates to a Google Maps search anchored at a specific lat/lng and finds
 * the rank position of the target business using hard unique IDs only.
 *
 * Matching priority (no name fallback):
 *  1. Same CID          — most reliable cross-format bridge
 *  2. Same hex-pair     — exact match
 *  3. Same ChIJ PlaceId — exact match
 *
 * Returns null if not found in top maxRankToShow positions.
 */

import { sleep } from 'crawlee';
import { extractAllIdsFromCard, idsMatch } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS   = 1200;
const CARD_WAIT_MS      = 3000;
const MAX_SCROLL_ROUNDS = 8;

/**
 * Check the rank of a business at a single grid point.
 *
 * @param {object}  params
 * @param {import('playwright').Page} params.page
 * @param {string}  params.keyword
 * @param {number}  params.lat
 * @param {number}  params.lng
 * @param {import('./extractPlaceId.js').GmbIds} params.targetIds  — normalised target IDs
 * @param {number}  [params.maxRankToShow]
 * @param {string}  [params.language]
 * @returns {Promise<{rank: number|null, ranked: boolean, error?: string}>}
 */
export async function checkRankAtPoint({
    page,
    keyword,
    lat,
    lng,
    targetIds,
    maxRankToShow = 20,
    language = 'en',
}) {
    const url = buildGridPointUrl(keyword, lat, lng, language);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        return { rank: null, ranked: false, error: `nav_timeout: ${err.message}` };
    }

    // Wait for result feed
    try {
        await page.waitForSelector('[role="feed"]', { timeout: CARD_WAIT_MS });
    } catch {
        return { rank: null, ranked: false, error: 'no_feed' };
    }

    let position = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {
        const cards = await page.$$('[role="feed"] > div[jsaction]');

        for (let i = position; i < cards.length; i++) {
            position = i + 1; // 1-indexed rank

            if (position > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            const cardIds = await extractAllIdsFromCard(cards[i]);

            if (idsMatch(targetIds, cardIds)) {
                return { rank: position, ranked: true };
            }
        }

        if (position >= maxRankToShow) {
            return { rank: null, ranked: false };
        }

        // Scroll feed to load more results
        const feed = await page.$('[role="feed"]');
        if (!feed) break;

        const prevCount = cards.length;
        await feed.evaluate((el) => el.scrollBy(0, 600));
        await sleep(SCROLL_PAUSE_MS);

        const newCount = (await page.$$('[role="feed"] > div[jsaction]')).length;
        if (newCount === prevCount) break; // end of results
    }

    return { rank: null, ranked: false };
}
