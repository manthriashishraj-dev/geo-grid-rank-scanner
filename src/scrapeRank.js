/**
 * scrapeRank.js
 *
 * Navigates to a Google Maps search anchored at a specific lat/lng and finds the
 * rank position of the target business.
 *
 * Strategy:
 *  1. Load Google Maps search at the grid-point coordinates (@lat,lng,14z)
 *  2. Scroll through results up to maxRankToShow cards
 *  3. For each card, extract Place ID and compare to target
 *  4. Fallback: normalised name substring match if place_id extraction fails
 *
 * Returns null if not found in top maxRankToShow positions.
 */

import { sleep } from 'crawlee';
import { extractPlaceIdFromCard, extractPlaceIdFromUrl, normaliseName } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS = 1200;   // match existing scraper rate-limiting
const CARD_WAIT_MS    = 3000;   // wait for initial results to load
const MAX_SCROLL_ATTEMPTS = 8;  // safety cap on scroll loop

/**
 * Check the rank of a business at a single grid point.
 *
 * @param {object}  params
 * @param {import('playwright').Page} params.page
 * @param {string}  params.keyword           Search keyword, e.g. "Dental clinic"
 * @param {number}  params.lat               Grid-point latitude
 * @param {number}  params.lng               Grid-point longitude
 * @param {string}  params.targetPlaceId     Normalised place_id of the target business
 * @param {string}  [params.targetName]      Business name for fallback fuzzy match
 * @param {number}  [params.maxRankToShow]   Stop scanning beyond this rank (default 20)
 * @param {string}  [params.language]        Google Maps hl param (default 'en')
 * @returns {Promise<{rank: number|null, ranked: boolean}>}
 *   rank: 1-indexed position, or null if not ranked within maxRankToShow
 *   ranked: true if found
 */
export async function checkRankAtPoint({
    page,
    keyword,
    lat,
    lng,
    targetPlaceId,
    targetName = '',
    maxRankToShow = 20,
    language = 'en',
}) {
    const url = buildGridPointUrl(keyword, lat, lng, language);

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        // Navigation timeout — return unranked so we don't abort the whole run
        return { rank: null, ranked: false, error: `nav_timeout: ${err.message}` };
    }

    // Wait for result feed
    try {
        await page.waitForSelector('[role="feed"]', { timeout: CARD_WAIT_MS });
    } catch {
        // Results panel didn't appear — possible CAPTCHA or empty results
        return { rank: null, ranked: false, error: 'no_feed' };
    }

    const normTarget = normaliseName(targetName);
    let position = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ATTEMPTS; scroll++) {
        // Grab all visible result cards
        const cards = await page.$$('[role="feed"] > div[jsaction]');

        for (let i = position; i < cards.length; i++) {
            position = i + 1; // 1-indexed

            if (position > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            const card = cards[i];

            // --- Primary match: Place ID ---
            const cardPlaceId = await extractPlaceIdFromCard(card);
            if (cardPlaceId && cardPlaceId === targetPlaceId) {
                return { rank: position, ranked: true };
            }

            // --- Secondary match: URL-based place_id from card link ---
            const cardHref = await card.evaluate((el) => {
                const a = el.querySelector('a[href*="/maps/"]') || el.closest('a[href*="/maps/"]');
                return a?.href || null;
            });
            if (cardHref) {
                const urlId = extractPlaceIdFromUrl(cardHref);
                if (urlId && urlId === targetPlaceId) {
                    return { rank: position, ranked: true };
                }
            }

            // --- Tertiary match: normalised name substring ---
            if (normTarget.length >= 4) {
                const nameEl = await card.$('[role="heading"], .fontHeadlineSmall');
                if (nameEl) {
                    const cardName = normaliseName(await nameEl.textContent() || '');
                    if (cardName.includes(normTarget.slice(0, Math.min(normTarget.length, 12)))) {
                        return { rank: position, ranked: true };
                    }
                }
            }
        }

        // If we've already seen maxRankToShow cards, stop scrolling
        if (position >= maxRankToShow) {
            return { rank: null, ranked: false };
        }

        // Scroll the feed to load more results
        const feed = await page.$('[role="feed"]');
        if (!feed) break;

        const prevCount = (await page.$$('[role="feed"] > div[jsaction]')).length;
        await feed.evaluate((el) => el.scrollBy(0, 600));
        await sleep(SCROLL_PAUSE_MS);

        const newCount = (await page.$$('[role="feed"] > div[jsaction]')).length;
        if (newCount === prevCount) break; // no new cards loaded — end of results
    }

    return { rank: null, ranked: false };
}
