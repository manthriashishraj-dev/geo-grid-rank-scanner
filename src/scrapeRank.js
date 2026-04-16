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
    //
    // Strategy: on EVERY scroll round, re-scan ALL cards from scratch.
    // This correctly handles Google Maps' lazy-loading pattern where cards
    // are rendered in the DOM with empty hrefs initially, and get their hrefs
    // populated only when scrolled into view. A seenCount-based incremental
    // approach would miscount because "empty" cards become "result" cards
    // between rounds, inflating the effectiveRank base.
    //
    let prevTotalCards = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {

        const extracted = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (!feed) return { feedExists: false, cards: [] };

            let rawCards = Array.from(feed.querySelectorAll(':scope > div'));
            if (rawCards.length === 0) {
                // Fallback: article-role cards (alternate Maps layout)
                rawCards = Array.from(document.querySelectorAll('[role="article"]'));
            }

            return {
                feedExists: true,
                cards: rawCards.map((card) => {
                    // data-cid — check card + all descendants
                    let dataCid = card.getAttribute('data-cid');
                    if (!dataCid) {
                        dataCid = card.querySelector('[data-cid]')?.getAttribute('data-cid') ?? null;
                    }
                    if (dataCid && !/^\d+$/.test(dataCid)) dataCid = null;

                    // Only count fully-resolved HTTP hrefs.
                    // Google lazy-loads result cards with empty href="" initially;
                    // element.href resolves to the page URL with fragment, e.g.
                    // "https://maps.google.com/maps/search/...#" — filter those out.
                    const hrefs = Array.from(card.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(h => h && /^https?:\/\//.test(h) && !/[/#]$/.test(h));

                    const jslog = card.getAttribute('jslog') ?? null;

                    return { dataCid, hrefs, jslog };
                }),
            };
        });

        if (!extracted.feedExists && scroll === 0) {
            return { rank: null, ranked: false, error: 'feed_lost' };
        }

        const { cards } = extracted;

        // Full scan of ALL cards this round (re-scan from 0 every time).
        // effectiveRank counts only result cards (non-empty hrefs or dataCid).
        let effectiveRank = 0;

        for (const card of cards) {
            const isResultCard = card.hrefs.length > 0 || !!card.dataCid;
            if (!isResultCard) continue;

            effectiveRank++;

            if (effectiveRank > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            // 1 ▸ data-cid direct match
            if (card.dataCid) {
                if (targetIds.cid && card.dataCid === targetIds.cid) {
                    return { rank: effectiveRank, ranked: true };
                }
                if (targetIds.hexId) {
                    try {
                        if (card.dataCid === BigInt(targetIds.hexId.split(':')[1]).toString()) {
                            return { rank: effectiveRank, ranked: true };
                        }
                    } catch { /* malformed */ }
                }
            }

            // 2 ▸ Scan all hrefs for any matching ID format
            for (const href of card.hrefs) {
                const cardIds = extractIdsFromUrl(href);
                if (!cardIds.placeId && !cardIds.hexId && !cardIds.cid) continue;
                if (idsMatch(targetIds, cardIds)) {
                    return { rank: effectiveRank, ranked: true };
                }
            }

            // 3 ▸ jslog: Google sometimes embeds CID here as a 15-20-digit number
            if (card.jslog && targetIds.cid) {
                const m = card.jslog.match(/\b(\d{15,20})\b/);
                if (m && m[1] === targetIds.cid) {
                    return { rank: effectiveRank, ranked: true };
                }
            }
        }

        // Not found yet — check if we've seen enough results
        if (effectiveRank >= maxRankToShow) {
            return { rank: null, ranked: false };
        }

        const currentTotalCards = cards.length;

        // Scroll to load more results.
        //
        // Google Maps makes [role="feed"] itself the scrollable container (overflow:auto
        // on the feed element). BUT: before the first lazy-load, scrollHeight === clientHeight
        // so feed.scrollBy() is a no-op. scrollIntoView on the last child triggers the
        // initial lazy load; after that feed.scrollBy works normally.
        //
        // Walk order: feed itself → feed's ancestors (handles layout variations).
        await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (!feed) return;

            let scrolled = false;

            // 1. Try the feed element itself first (most common in Maps)
            const feedStyle = window.getComputedStyle(feed);
            if (/auto|scroll/.test(feedStyle.overflow + feedStyle.overflowY)
                    && feed.scrollHeight > feed.clientHeight) {
                feed.scrollBy(0, 2400);
                scrolled = true;
            }

            // 2. If feed not scrollable, walk up to find the scrollable ancestor
            if (!scrolled) {
                let el = feed.parentElement;
                while (el && el !== document.body) {
                    const { overflow, overflowY } = window.getComputedStyle(el);
                    if (/auto|scroll/.test(overflow + overflowY) && el.scrollHeight > el.clientHeight) {
                        el.scrollBy(0, 2400);
                        scrolled = true;
                        break;
                    }
                    el = el.parentElement;
                }
            }

            // 3. Always scrollIntoView the last child — triggers the FIRST lazy load
            //    when feed isn't yet scrollable, and also triggers loading of the next
            //    batch of results after every scroll.
            const lastChild = feed.lastElementChild;
            if (lastChild) lastChild.scrollIntoView({ block: 'end' });
        });
        await sleep(SCROLL_PAUSE_MS);

        const newTotalCards = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) return feed.querySelectorAll(':scope > div').length;
            return document.querySelectorAll('[role="article"]').length;
        });

        // Stop scrolling if the feed has stopped growing
        if (newTotalCards <= prevTotalCards && scroll > 0) break;
        prevTotalCards = newTotalCards;
    }

    return { rank: null, ranked: false };
}
