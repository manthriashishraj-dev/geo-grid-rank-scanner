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
 * Reliability design:
 *  - Nav timeout: on timeout we still attempt to scrape partial content
 *  - Consent handling: detects consent.google.com AND embedded consent dialogs
 *  - "No results" detection: Google saying "no results here" is a clean
 *    not-ranked result, not a retryable error
 *  - Inner retry: if feed is missing, waits and retries once before giving up
 *  - Multiple feed selectors: handles different Google Maps layout variants
 */

import { sleep } from 'crawlee';
import { idsMatch } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const SCROLL_PAUSE_MS    = 1500;
const CARD_WAIT_MS       = 10000;
const MAX_SCROLL_ROUNDS  = 10;
const NAV_TIMEOUT_MS     = 45000;

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

// ─── Page state detection ─────────────────────────────────────────────────────
// Returns one of: 'feed' | 'consent' | 'no_results' | 'captcha' | 'unknown'

async function detectPageState(page) {
    try {
        return await page.evaluate(() => {
            const url = window.location.href;

            // Wrong domain entirely
            if (!url.includes('google.')) return 'unknown';

            // Consent page (various forms)
            if (url.includes('consent.google.com')) return 'consent';
            if (url.includes('accounts.google.com')) return 'consent';

            // Embedded consent / "Before you continue" dialog
            const bodyText = (document.body?.innerText || '').toLowerCase();
            if (bodyText.includes('before you continue') ||
                bodyText.includes('we use cookies') ||
                bodyText.includes('tout accepter') ||
                bodyText.includes('alle akzeptieren')) {
                return 'consent';
            }

            // Captcha / unusual traffic
            if (bodyText.includes('unusual traffic') ||
                bodyText.includes('captcha') ||
                document.querySelector('form[action*="captcha"]')) {
                return 'captcha';
            }

            // Google Maps "No results found" — legitimate, not an error
            if (bodyText.includes('no results') ||
                bodyText.includes('couldn\'t find') ||
                bodyText.includes('no places found') ||
                bodyText.includes('ఫలితాలు లేవు') ||    // Telugu
                bodyText.includes('कोई परिणाम नहीं') || // Hindi
                document.querySelector('[data-section-id="oh"]') ||
                document.querySelector('.section-no-result-title')) {
                return 'no_results';
            }

            // Feed present
            if (document.querySelector('[role="feed"]')) return 'feed';
            if (document.querySelector('[data-cid]'))    return 'feed'; // alternate layout
            if (document.querySelector('[role="article"]')) return 'feed';

            return 'unknown';
        });
    } catch {
        return 'unknown';
    }
}

// ─── Consent bypass ───────────────────────────────────────────────────────────

async function bypassConsent(page, originalUrl) {
    // Try clicking an accept button
    try {
        const accepted = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
            const acceptBtn = btns.find(b => {
                const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
                return txt && /^(accept all|i agree|agree|accept|tout accepter|alle akzeptieren|aceptar todo|accetta tutto|accepteer alles|tümünü kabul|zaakceptuj|souhlasím|godkänn)/.test(txt);
            });
            const firstVisible = acceptBtn || btns.find(b => b.offsetParent !== null && b.innerText?.trim());
            if (firstVisible) { firstVisible.click(); return true; }
            return false;
        });
        if (accepted) {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        }
    } catch { /* ignore */ }

    // If still on consent page, navigate directly to the target URL
    if (page.url().includes('consent.google') || page.url().includes('accounts.google')) {
        try {
            await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch { /* timeout ok — partial load still usable */ }
    }
}

// ─── Wait for feed (with inner retry) ────────────────────────────────────────

async function waitForFeed(page) {
    // First attempt
    try {
        await page.waitForSelector('[role="feed"], [data-cid], [role="article"]', { timeout: CARD_WAIT_MS });
        return true;
    } catch { /* not found yet */ }

    // Brief pause and second attempt
    await sleep(3000);
    try {
        const present = await page.evaluate(() =>
            !!(document.querySelector('[role="feed"]') ||
               document.querySelector('[data-cid]') ||
               document.querySelector('[role="article"]'))
        );
        return present;
    } catch {
        return false;
    }
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
    // On timeout we don't bail immediately — partial page loads often still
    // have result cards we can scan.
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    } catch {
        // Timeout or navigation error — fall through and try to scan whatever loaded
    }

    await sleep(600);

    // ── Page state check ──────────────────────────────────────────────────────
    let state = await detectPageState(page);

    // Handle consent / redirect
    if (state === 'consent') {
        await bypassConsent(page, url);
        await sleep(1500);
        state = await detectPageState(page);
        // If still consent after bypass attempt → retryable error
        if (state === 'consent') {
            return { rank: null, ranked: false, error: 'consent_bypass_failed' };
        }
    }

    // Captcha → retryable (different proxy IP on retry)
    if (state === 'captcha') {
        return { rank: null, ranked: false, error: 'captcha' };
    }

    // Legitimate "no results in this area" → clean not-ranked, not an error
    if (state === 'no_results') {
        return { rank: null, ranked: false };
    }

    // ── Wait for feed ─────────────────────────────────────────────────────────
    const feedReady = await waitForFeed(page);

    if (!feedReady) {
        // One more page state check — maybe it resolved to no_results while we waited
        const finalState = await detectPageState(page);
        if (finalState === 'no_results') return { rank: null, ranked: false };
        if (finalState === 'consent')    return { rank: null, ranked: false, error: 'consent_bypass_failed' };
        if (finalState === 'captcha')    return { rank: null, ranked: false, error: 'captcha' };
        return { rank: null, ranked: false, error: 'no_feed' };
    }

    await sleep(800);

    // ── Rank-check loop ───────────────────────────────────────────────────────
    //
    // Strategy: on EVERY scroll round, re-scan ALL cards from scratch.
    // This correctly handles Google Maps' lazy-loading pattern where cards
    // are rendered in the DOM with empty hrefs initially, and get their hrefs
    // populated only when scrolled into view.
    //
    let prevTotalCards = 0;

    for (let scroll = 0; scroll < MAX_SCROLL_ROUNDS; scroll++) {

        const extracted = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (!feed) return { feedExists: false, cards: [] };

            let rawCards = Array.from(feed.querySelectorAll(':scope > div'));
            if (rawCards.length === 0) {
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
            // Feed disappeared — re-check state
            const s = await detectPageState(page);
            if (s === 'no_results') return { rank: null, ranked: false };
            return { rank: null, ranked: false, error: 'feed_lost' };
        }

        const { cards } = extracted;

        // Full scan of ALL cards this round (re-scan from 0 every time).
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
