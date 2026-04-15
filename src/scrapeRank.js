/**
 * scrapeRank.js
 *
 * Navigates to a Google Maps search anchored at a specific lat/lng and finds
 * the rank position of the target business using hard unique IDs only.
 *
 * Matching priority (no name fallback):
 *  1. data-cid attribute on any card element (most reliable — Google stamps it directly)
 *  2. CID derived from hex-pair in card href (!1s0x...:0x... data blob)
 *  3. Same hex-pair exact match
 *  4. Same ChIJ PlaceId match
 *
 * All DOM extraction runs inside a single page.evaluate() per scroll round —
 * no per-card ElementHandle calls, no stale-handle risk.
 */

import { sleep } from 'crawlee';
import { idsMatch } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS   = 1400;
const CARD_WAIT_MS      = 6000;
const MAX_SCROLL_ROUNDS = 10;

// ─── URL ID extractor (Node.js side) ─────────────────────────────────────────

/**
 * Pull all GMB IDs out of a URL string.
 * Mirrors extractAllIdsFromUrl in extractPlaceId.js but kept local so
 * scrapeRank.js is self-contained and can be tested independently.
 *
 * @param {string} url
 * @returns {{ placeId: string|null, hexId: string|null, cid: string|null }}
 */
function extractIdsFromUrl(url) {
    if (!url) return { placeId: null, hexId: null, cid: null };

    let placeId = null;
    let hexId   = null;
    let cid     = null;

    // 1. Hex-pair embedded in the Maps data blob: ...!1s0x...:0x...
    const hexMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) {
        hexId = hexMatch[1].toLowerCase();
        const cidHex = hexId.split(':')[1];
        if (cidHex) {
            try { cid = BigInt(cidHex).toString(); } catch { /* malformed */ }
        }
    }

    // 2. ChIJ Place ID — in path segment or raw in data blob
    const chijPath = url.match(/maps\/place\/[^/]*\/(ChIJ[A-Za-z0-9_-]{10,})/);
    if (chijPath) {
        placeId = chijPath[1];
    } else {
        const chijRaw = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
        if (chijRaw) placeId = chijRaw[1];
    }

    // 3. Numeric CID in ?cid= or &cid= query param
    const cidParam = url.match(/[?&]cid=(\d+)/);
    if (cidParam) cid = cidParam[1];

    return { placeId, hexId, cid };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Check the rank of a business at a single grid point.
 *
 * @param {object} params
 * @param {import('playwright').Page} params.page
 * @param {string}  params.keyword
 * @param {number}  params.lat
 * @param {number}  params.lng
 * @param {import('./extractPlaceId.js').GmbIds} params.targetIds
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
    language      = 'en',
}) {
    const url = buildGridPointUrl(keyword, lat, lng, language);

    // ── Navigate ──────────────────────────────────────────────────────────────
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        return { rank: null, ranked: false, error: `nav_timeout: ${err.message}` };
    }

    // ── Wait for result feed ──────────────────────────────────────────────────
    try {
        await page.waitForSelector('[role="feed"]', { timeout: CARD_WAIT_MS });
    } catch {
        // Try alternate selector — Maps sometimes uses a different structure
        const hasResults = await page.$('[jsaction*="mouseover"][data-cid]');
        if (!hasResults) {
            return { rank: null, ranked: false, error: 'no_feed' };
        }
    }

    // Give JS a moment to finish rendering cards
    await sleep(600);

    let seenCount = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {

        // ── Single browser-side evaluation — grab all card data at once ───────
        const extracted = await page.evaluate(() => {
            // ── Locate the result feed ──
            const feed = document.querySelector('[role="feed"]');
            const feedExists = !!feed;

            // Direct div children of the feed — one per result slot
            let cards = feedExists
                ? Array.from(feed.querySelectorAll(':scope > div'))
                : [];

            // Fallback: if feed has no direct div children, check for
            // article-role cards anywhere on the page (alternate Maps layout)
            if (cards.length === 0) {
                cards = Array.from(document.querySelectorAll('[role="article"]'));
            }

            return {
                feedExists,
                cards: cards.map((card) => {
                    // ── data-cid: check the card itself + ALL descendants ──
                    let dataCid = null;
                    if (card.hasAttribute('data-cid')) {
                        dataCid = card.getAttribute('data-cid');
                    }
                    if (!dataCid) {
                        const cidEl = card.querySelector('[data-cid]');
                        if (cidEl) dataCid = cidEl.getAttribute('data-cid');
                    }
                    // Must be purely numeric to be a valid CID
                    if (dataCid && !/^\d+$/.test(dataCid)) dataCid = null;

                    // ── Collect ALL hrefs from anchor tags in this card ──
                    // page.evaluate resolves relative URLs to absolute automatically
                    const hrefs = Array.from(card.querySelectorAll('a[href]'))
                        .map((a) => a.href)
                        .filter(Boolean);

                    // ── jslog may encode a numeric CID: "123456789;..." ──
                    const jslog = card.getAttribute('jslog') || null;

                    return { dataCid, hrefs, jslog };
                }),
            };
        });

        if (!extracted.feedExists && seenCount === 0) {
            return { rank: null, ranked: false, error: 'feed_lost' };
        }

        const { cards } = extracted;

        // ── Check each new card against target IDs ────────────────────────────
        for (let i = seenCount; i < cards.length; i++) {
            const position = i + 1; // 1-indexed rank

            if (position > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            const card = cards[i];

            // 1 ▸ data-cid direct match (fastest path)
            if (card.dataCid) {
                if (targetIds.cid && card.dataCid === targetIds.cid) {
                    return { rank: position, ranked: true };
                }
                // Cross-format: derive CID from target hexId, compare to card dataCid
                if (targetIds.hexId) {
                    try {
                        const cidFromTargetHex = BigInt(targetIds.hexId.split(':')[1]).toString();
                        if (card.dataCid === cidFromTargetHex) {
                            return { rank: position, ranked: true };
                        }
                    } catch { /* malformed */ }
                }
            }

            // 2 ▸ Scan all hrefs for any matching ID format
            for (const href of card.hrefs) {
                const cardIds = extractIdsFromUrl(href);
                // Skip if nothing was parsed (empty-ID objects always false-match)
                if (!cardIds.placeId && !cardIds.hexId && !cardIds.cid) continue;
                if (idsMatch(targetIds, cardIds)) {
                    return { rank: position, ranked: true };
                }
            }

            // 3 ▸ jslog: Google sometimes puts a 15-20-digit CID in jslog
            if (card.jslog && targetIds.cid) {
                const numMatch = card.jslog.match(/\b(\d{15,20})\b/);
                if (numMatch && numMatch[1] === targetIds.cid) {
                    return { rank: position, ranked: true };
                }
            }
        }

        seenCount = cards.length;

        if (seenCount >= maxRankToShow) {
            return { rank: null, ranked: false };
        }

        // ── Scroll feed to load more results ──────────────────────────────────
        await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) feed.scrollBy(0, 800);
        });
        await sleep(SCROLL_PAUSE_MS);

        // Check if new cards appeared
        const newCount = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) return feed.querySelectorAll(':scope > div').length;
            return document.querySelectorAll('[role="article"]').length;
        });

        if (newCount <= seenCount) break; // end of results
    }

    return { rank: null, ranked: false };
}
