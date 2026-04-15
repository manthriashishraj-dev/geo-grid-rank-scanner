/**
 * scrapeRank.js
 *
 * Navigates to a Google Maps search anchored at a specific lat/lng and finds
 * the rank position of the target business using hard unique IDs only.
 *
 * Matching priority (no name fallback):
 *  1. data-cid attribute on any card element  (most reliable)
 *  2. CID derived from hex-pair in card href  (!1s0x...:0x... data blob)
 *  3. Same hex-pair exact match
 *  4. Same ChIJ PlaceId match
 *
 * Non-result cards (filter carousels, "Results" headers, spacer divs) are
 * detected by having zero hrefs and no dataCid, and are skipped so they don't
 * inflate the rank count.
 *
 * Consent page handling: residential proxies may route through EU/UK IPs and
 * trigger consent.google.com. A SOCS cookie is pre-injected in main.js; this
 * module also handles the click-through as a fallback.
 */

import { sleep } from 'crawlee';
import { idsMatch } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS   = 1400;
const CARD_WAIT_MS      = 6000;
const MAX_SCROLL_ROUNDS = 10;

// ─── URL ID extractor (Node.js side) ─────────────────────────────────────────

function extractIdsFromUrl(url) {
    if (!url) return { placeId: null, hexId: null, cid: null };

    let placeId = null;
    let hexId   = null;
    let cid     = null;

    // 1. Hex-pair: !1s0x...:0x...
    const hexMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) {
        hexId = hexMatch[1].toLowerCase();
        const cidHex = hexId.split(':')[1];
        if (cidHex) {
            try { cid = BigInt(cidHex).toString(); } catch { /* malformed */ }
        }
    }

    // 2. ChIJ Place ID
    const chijPath = url.match(/maps\/place\/[^/]*\/(ChIJ[A-Za-z0-9_-]{10,})/);
    if (chijPath) {
        placeId = chijPath[1];
    } else {
        const chijRaw = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
        if (chijRaw) placeId = chijRaw[1];
    }

    // 3. ?cid= numeric
    const cidParam = url.match(/[?&]cid=(\d+)/);
    if (cidParam) cid = cidParam[1];

    return { placeId, hexId, cid };
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {object}  params
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

    // ── Handle Google consent page (GDPR — EU/UK residential proxies) ─────────
    // The SOCS cookie in preNavigationHooks usually bypasses this, but as a
    // fallback we click "Accept all" if we land on consent.google.com.
    if (page.url().includes('consent.google.com')) {
        try {
            await sleep(1000);
            const accepted = await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                const acceptBtn = btns.find(b => {
                    const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                    return txt && /^(accept all|i agree|agree|tout accepter|alle akzeptieren|aceptar todo|accetta tutto)/.test(txt);
                });
                const firstBtn = acceptBtn || btns.find(b => b.offsetParent !== null);
                if (firstBtn) { firstBtn.click(); return true; }
                return false;
            });
            if (accepted) {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                if (page.url().includes('consent.google.com')) {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                }
            }
        } catch { /* consent bypass failed */ }
    }

    // ── Wait for result feed ──────────────────────────────────────────────────
    try {
        await page.waitForSelector('[role="feed"]', { timeout: CARD_WAIT_MS });
    } catch {
        const hasDataCid = await page.$('[data-cid]');
        if (!hasDataCid) {
            return { rank: null, ranked: false, error: 'no_feed' };
        }
    }

    await sleep(800);

    // ── Rank-check loop ───────────────────────────────────────────────────────
    let seenCount = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {

        const extracted = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            const feedExists = !!feed;

            let cards = feedExists
                ? Array.from(feed.querySelectorAll(':scope > div'))
                : [];

            // Fallback: article-role cards (alternate Maps layout)
            if (cards.length === 0) {
                cards = Array.from(document.querySelectorAll('[role="article"]'));
            }

            return {
                feedExists,
                cards: cards.map((card) => {
                    // data-cid — check card + all descendants
                    let dataCid = card.getAttribute('data-cid');
                    if (!dataCid) {
                        dataCid = card.querySelector('[data-cid]')?.getAttribute('data-cid') ?? null;
                    }
                    if (dataCid && !/^\d+$/.test(dataCid)) dataCid = null;

                    const hrefs = Array.from(card.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(Boolean);

                    const jslog = card.getAttribute('jslog') ?? null;

                    return { dataCid, hrefs, jslog };
                }),
            };
        });

        if (!extracted.feedExists && seenCount === 0) {
            return { rank: null, ranked: false, error: 'feed_lost' };
        }

        const { cards } = extracted;

        // Track effective rank separately — non-result cards (filter bars, headers,
        // spacer divs between results) are skipped by checking for hrefs or dataCid.
        let effectiveRank = seenCount === 0
            ? 0
            : cards.slice(0, seenCount).filter(c => c.hrefs.length > 0 || c.dataCid).length;

        for (let i = seenCount; i < cards.length; i++) {
            const card = cards[i];

            // Skip non-result cards: filter carousels, "Results" headers, spacers, etc.
            const isResultCard = card.hrefs.length > 0 || !!card.dataCid;
            if (!isResultCard) continue;

            effectiveRank++;
            const position = effectiveRank;

            if (position > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            // 1 ▸ data-cid direct match
            if (card.dataCid) {
                if (targetIds.cid && card.dataCid === targetIds.cid) {
                    return { rank: position, ranked: true };
                }
                if (targetIds.hexId) {
                    try {
                        if (card.dataCid === BigInt(targetIds.hexId.split(':')[1]).toString()) {
                            return { rank: position, ranked: true };
                        }
                    } catch { /* malformed */ }
                }
            }

            // 2 ▸ Scan all hrefs for any matching ID format
            for (const href of card.hrefs) {
                const cardIds = extractIdsFromUrl(href);
                if (!cardIds.placeId && !cardIds.hexId && !cardIds.cid) continue;
                if (idsMatch(targetIds, cardIds)) {
                    return { rank: position, ranked: true };
                }
            }

            // 3 ▸ jslog: Google sometimes embeds CID here as a 15-20-digit number
            if (card.jslog && targetIds.cid) {
                const m = card.jslog.match(/\b(\d{15,20})\b/);
                if (m && m[1] === targetIds.cid) {
                    return { rank: position, ranked: true };
                }
            }
        }

        seenCount = cards.length;

        if (effectiveRank >= maxRankToShow) {
            return { rank: null, ranked: false };
        }

        // Scroll feed to load more results
        await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) feed.scrollBy(0, 800);
        });
        await sleep(SCROLL_PAUSE_MS);

        const newCount = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) return feed.querySelectorAll(':scope > div').length;
            return document.querySelectorAll('[role="article"]').length;
        });

        if (newCount <= seenCount) break;
    }

    return { rank: null, ranked: false };
}
