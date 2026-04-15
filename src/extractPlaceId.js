/**
 * extractPlaceId.js
 *
 * Extracts a normalised Google Place ID from a Google Maps URL or data string.
 * Ported from gmb-scraper-125-fields/src/scrapeSearch.js — same patterns, proven in prod.
 *
 * Priority:
 *  1. Hex-pair  → "0x3a3345fb8f20d4b7:0xf5a5d85edfcb2c8e"  (most common in /maps/search/ URLs)
 *  2. ChIJ base64 → "ChIJN1t_tDeuEmsRUsoyG83frY4"           (Place ID in profile URLs)
 *  3. CID numeric  → "1234567890"                            (legacy format)
 */

/** @param {string} url */
export function extractPlaceIdFromUrl(url) {
    if (!url) return null;

    // 1. Hex-pair in data param  !1s(0x...:0x...)
    const hexMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) return hexMatch[1].toLowerCase();

    // 2. ChIJ base64 in /place/ path or data
    const chijMatch = url.match(/place\/[^/]*\/(ChIJ[A-Za-z0-9_-]{20,})/);
    if (chijMatch) return chijMatch[1];

    // Also catch it in query string or data blob
    const chijAlt = url.match(/(ChIJ[A-Za-z0-9_-]{20,})/);
    if (chijAlt) return chijAlt[1];

    // 3. CID numeric
    const cidMatch = url.match(/[?&]cid=(\d+)/);
    if (cidMatch) return cidMatch[1];

    return null;
}

/**
 * Extracts place_id from a DOM element handle representing a search result card.
 * Works with Playwright page objects.
 *
 * @param {import('playwright').ElementHandle} card
 * @returns {Promise<string|null>}
 */
export async function extractPlaceIdFromCard(card) {
    try {
        // Try the anchor href on the card
        const href = await card.evaluate((el) => {
            const a = el.querySelector('a[href*="/maps/"]') || el.closest('a[href*="/maps/"]');
            return a ? a.href : null;
        });
        if (href) {
            const id = extractPlaceIdFromUrl(href);
            if (id) return id;
        }

        // Fallback: aria-label on the card itself sometimes encodes the place
        const dataId = await card.evaluate((el) => el.getAttribute('data-cid') || el.getAttribute('data-place-id') || null);
        if (dataId) return dataId;
    } catch {
        // Card may have been detached from DOM during scroll — swallow silently
    }
    return null;
}

/**
 * Normalise a business name for fuzzy fallback matching.
 * Lowercases, strips punctuation, collapses whitespace.
 * @param {string} name
 * @returns {string}
 */
export function normaliseName(name = '') {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
