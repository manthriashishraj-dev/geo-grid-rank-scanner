/**
 * scrapeRank.js
 *
 * Navigates to a Google Maps search anchored at a specific lat/lng and finds
 * the rank position of the target business using hard unique IDs only.
 *
 * Matching priority (no name fallback):
 *  1. data-cid attribute on any card element (most reliable)
 *  2. CID derived from hex-pair in card href (!1s0x...:0x... data blob)
 *  3. Same hex-pair exact match
 *  4. Same ChIJ PlaceId match
 */

import { sleep } from 'crawlee';
import { idsMatch } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS   = 1400;
const CARD_WAIT_MS      = 6000;
const MAX_SCROLL_ROUNDS = 10;

// Save a full DOM diagnostic for the very first grid point so we can
// inspect exactly what Google serves. Guarded by a flag so it fires once.
let _diagSaved = false;

// ─── URL ID extractor (Node.js side) ─────────────────────────────────────────

function extractIdsFromUrl(url) {
    if (!url) return { placeId: null, hexId: null, cid: null };

    let placeId = null;
    let hexId   = null;
    let cid     = null;

    const hexMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) {
        hexId = hexMatch[1].toLowerCase();
        const cidHex = hexId.split(':')[1];
        if (cidHex) {
            try { cid = BigInt(cidHex).toString(); } catch { /* malformed */ }
        }
    }

    const chijPath = url.match(/maps\/place\/[^/]*\/(ChIJ[A-Za-z0-9_-]{10,})/);
    if (chijPath) {
        placeId = chijPath[1];
    } else {
        const chijRaw = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
        if (chijRaw) placeId = chijRaw[1];
    }

    const cidParam = url.match(/[?&]cid=(\d+)/);
    if (cidParam) cid = cidParam[1];

    return { placeId, hexId, cid };
}

// ─── Main export ──────────────────────────────────────────────────────────────

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

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        return { rank: null, ranked: false, error: `nav_timeout: ${err.message}` };
    }

    // Wait for result feed
    try {
        await page.waitForSelector('[role="feed"]', { timeout: CARD_WAIT_MS });
    } catch {
        const hasDataCid = await page.$('[data-cid]');
        if (!hasDataCid) {
            return { rank: null, ranked: false, error: 'no_feed' };
        }
    }

    await sleep(800);

    // ── Diagnostic: log DOM state for first point to actor logs ─────────────
    if (!_diagSaved) {
        _diagSaved = true; // Set eagerly to avoid duplicate log spam
        try {
            const diagData = await page.evaluate(() => {
                const feed = document.querySelector('[role="feed"]');
                const feedChildren = feed ? Array.from(feed.children) : [];
                const allCidEls = Array.from(document.querySelectorAll('[data-cid]'));
                return {
                    url: window.location.href,
                    feedExists: !!feed,
                    feedChildCount: feedChildren.length,
                    // First 3 direct feed children — what do they look like?
                    firstCards: feedChildren.slice(0, 3).map((card) => {
                        const anchors = Array.from(card.querySelectorAll('a[href]'));
                        return {
                            tag: card.tagName,
                            attrs: Array.from(card.attributes).map(a => `${a.name}="${a.value.slice(0,60)}"`),
                            dataCid: card.getAttribute('data-cid') || card.querySelector('[data-cid]')?.getAttribute('data-cid') || null,
                            hrefs: anchors.map(a => a.href).slice(0, 4),
                            snippet: card.outerHTML.slice(0, 500),
                        };
                    }),
                    allCids: allCidEls.map(el => el.getAttribute('data-cid')).slice(0, 10),
                };
            });
            // Log to actor output — visible in Apify console
            console.log('DIAG_START');
            console.log(JSON.stringify(diagData, null, 2));
            console.log('DIAG_END');
        } catch (e) {
            console.log('DIAG_ERROR:', e.message);
        }
    }

    let seenCount = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {

        const extracted = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            const feedExists = !!feed;

            let cards = feedExists
                ? Array.from(feed.querySelectorAll(':scope > div'))
                : [];

            if (cards.length === 0) {
                cards = Array.from(document.querySelectorAll('[role="article"]'));
            }

            return {
                feedExists,
                cards: cards.map((card) => {
                    let dataCid = null;
                    if (card.hasAttribute('data-cid')) {
                        dataCid = card.getAttribute('data-cid');
                    }
                    if (!dataCid) {
                        const cidEl = card.querySelector('[data-cid]');
                        if (cidEl) dataCid = cidEl.getAttribute('data-cid');
                    }
                    if (dataCid && !/^\d+$/.test(dataCid)) dataCid = null;

                    const hrefs = Array.from(card.querySelectorAll('a[href]'))
                        .map((a) => a.href)
                        .filter(Boolean);

                    const jslog = card.getAttribute('jslog') || null;

                    return { dataCid, hrefs, jslog };
                }),
            };
        });

        if (!extracted.feedExists && seenCount === 0) {
            return { rank: null, ranked: false, error: 'feed_lost' };
        }

        const { cards } = extracted;

        for (let i = seenCount; i < cards.length; i++) {
            const position = i + 1;

            if (position > maxRankToShow) {
                return { rank: null, ranked: false };
            }

            const card = cards[i];

            // 1 ▸ data-cid direct match
            if (card.dataCid) {
                if (targetIds.cid && card.dataCid === targetIds.cid) {
                    return { rank: position, ranked: true };
                }
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
                if (!cardIds.placeId && !cardIds.hexId && !cardIds.cid) continue;
                if (idsMatch(targetIds, cardIds)) {
                    return { rank: position, ranked: true };
                }
            }

            // 3 ▸ jslog numeric CID
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
