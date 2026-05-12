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
 *
 * Performance optimisations (v1.0.31):
 *  - MAX_SCROLL_ROUNDS reduced 10 → 4  (covers top-20 results; loop exits early on plateau)
 *  - 3 evaluate() calls per scroll round → 1  (extract + scroll merged; count inferred from array length)
 *  - Fixed 1500ms sleep replaced with page.waitForFunction (exits as soon as new cards appear, max 1s)
 *  - Fixed post-nav sleep 600→200ms, post-feed sleep 800→300ms
 */

import { sleep } from 'crawlee';
import { idsMatch, extractAllIdsFromUrl } from './extractPlaceId.js';
import { buildGridPointUrl } from './generateGrid.js';

const CARD_WAIT_MS      = 10000;
const MAX_SCROLL_ROUNDS = 4;      // 4 scrolls covers ~28 results (well past maxRankToShow=20)
const NAV_TIMEOUT_MS    = 45000;
const SCROLL_WAIT_MAX   = 1000;   // waitForFunction timeout per scroll round

// ─── Geo helpers ──────────────────────────────────────────────────────────────

/**
 * Extract a business's actual pin lat/lng from its Google Maps URL.
 * ONLY uses the data-param `!3d{lat}!4d{lng}` pattern — that is the real pin.
 *
 * We intentionally do NOT fall back to the viewport `@lat,lng`: that pattern is
 * the map-view centre (which equals OUR grid point for these search URLs) and
 * would give a misleading distance of ~0m for every competitor missing pin
 * data. Returning null is much more useful than wrong data.
 */
function extractCoordsFromMapsUrl(url) {
    if (!url) return null;
    const pin = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (!pin) return null;
    return { lat: parseFloat(pin[1]), lng: parseFloat(pin[2]) };
}

/** Haversine distance in metres between two lat/lng points. */
function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth radius in metres
    const toRad = (d) => (d * Math.PI) / 180;
    const phi1 = toRad(lat1);
    const phi2 = toRad(lat2);
    const dPhi = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLng / 2) ** 2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// ─── URL ID extractor (Node.js side) ─────────────────────────────────────────
// Re-exports the canonical extractor from extractPlaceId.js so we have ONE
// source of truth — earlier we had a near-duplicate copy here that was already
// starting to drift (no BigInt try-wrapping, etc.).
const extractIdsFromUrl = extractAllIdsFromUrl;

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
    // Try clicking an accept button.
    // IMPORTANT: register waitForNavigation BEFORE the click evaluate() to avoid
    // a race condition where navigation fires before the listener is set up.
    try {
        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
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
        if (accepted) await navPromise;
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
 * @returns {Promise<{rank: number|null, ranked: boolean, error?: string, competitors: Array}>}
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
    // Crawlee has ALREADY navigated to the request URL by the time we get here,
    // and preNavigationHooks has set the geolocation BEFORE that navigation.
    // We do NOT navigate again — that would be a wasted page load doubling cost.
    //
    // Safety net: if for any reason the page didn't land on a google.com URL
    // (proxy redirect chain, blocked, etc.), re-navigate once with the canonical
    // search URL so we never silently scrape a wrong page.
    const expectedUrl = buildGridPointUrl(keyword, lat, lng, language);
    const currentUrl  = page.url() || '';
    if (!/^https?:\/\/(www\.|maps\.)?google\.[a-z.]+\/maps\/search/.test(currentUrl)) {
        try {
            await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        } catch { /* timeout ok — partial loads often still scrape */ }
    }

    await sleep(200); // brief settle for initial DOM paint

    // ── Page state check ──────────────────────────────────────────────────────
    let state = await detectPageState(page);

    // Handle consent / redirect
    if (state === 'consent') {
        await bypassConsent(page, url);
        await sleep(800); // reduced from 1500ms
        state = await detectPageState(page);
        if (state === 'consent') {
            return { rank: null, ranked: false, error: 'consent_bypass_failed', competitors: [] };
        }
    }

    // Captcha → retryable (different proxy IP on retry)
    if (state === 'captcha') {
        return { rank: null, ranked: false, error: 'captcha', competitors: [] };
    }

    // Legitimate "no results in this area" → clean not-ranked, not an error
    if (state === 'no_results') {
        return { rank: null, ranked: false, competitors: [] };
    }

    // ── Wait for feed ─────────────────────────────────────────────────────────
    const feedReady = await waitForFeed(page);

    if (!feedReady) {
        const finalState = await detectPageState(page);
        if (finalState === 'no_results') return { rank: null, ranked: false, competitors: [] };
        if (finalState === 'consent')    return { rank: null, ranked: false, error: 'consent_bypass_failed', competitors: [] };
        if (finalState === 'captcha')    return { rank: null, ranked: false, error: 'captcha', competitors: [] };
        return { rank: null, ranked: false, error: 'no_feed', competitors: [] };
    }

    await sleep(300); // reduced from 800ms — feed selector confirmed present

    // ── Rank-check loop ───────────────────────────────────────────────────────
    //
    // Each iteration does ONE page.evaluate() that:
    //   1. Extracts all current cards (dataCid, hrefs, jslog, name)
    //   2. Triggers a scroll to load the next batch
    //   3. Returns the current card count (so we can detect plateau without a 2nd call)
    //
    // After the evaluate, page.waitForFunction() waits until new cards appear
    // (or gives up after SCROLL_WAIT_MAX ms) — no blind fixed sleep.
    //
    let prevTotalCards = 0;
    let competitors = [];

    for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {

        // ── Single evaluate: extract + scroll ─────────────────────────────────
        const extracted = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (!feed) return { feedExists: false, cards: [], totalCards: 0 };

            let rawCards = Array.from(feed.querySelectorAll(':scope > div'));
            if (rawCards.length === 0) {
                rawCards = Array.from(document.querySelectorAll('[role="article"]'));
            }

            const cards = rawCards.map((card) => {
                // ── CID ──────────────────────────────────────────────────────────
                let dataCid = card.getAttribute('data-cid');
                if (!dataCid) {
                    dataCid = card.querySelector('[data-cid]')?.getAttribute('data-cid') ?? null;
                }
                if (dataCid && !/^\d+$/.test(dataCid)) dataCid = null;

                // ── hrefs (fully-resolved only) ───────────────────────────────────
                const hrefs = Array.from(card.querySelectorAll('a[href]'))
                    .map(a => a.href)
                    .filter(h => h && /^https?:\/\//.test(h) && !/[/#]$/.test(h));

                const jslog = card.getAttribute('jslog') ?? null;

                // ── Business name ─────────────────────────────────────────────────
                let name = null;
                const nameEl = card.querySelector('.fontHeadlineSmall')
                    || card.querySelector('h1')
                    || card.querySelector('h2')
                    || card.querySelector('h3');
                if (nameEl) {
                    name = (nameEl.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 80);
                }
                if (!name) {
                    const ariaEl = card.querySelector('[aria-label]') || card;
                    const lbl = ariaEl.getAttribute('aria-label') || '';
                    if (lbl && lbl.length > 2 && lbl.length < 100) name = lbl.trim();
                }

                // ── All spans for field extraction ────────────────────────────────
                const allSpans = Array.from(card.querySelectorAll('span'));

                // ── Rating (1.0–5.0) ──────────────────────────────────────────────
                let rating = null;
                const ratingAriaEl = card.querySelector('[aria-label*="stars"], [aria-label*="star"]');
                if (ratingAriaEl) {
                    const m = (ratingAriaEl.getAttribute('aria-label') || '').match(/(\d+\.?\d*)/);
                    if (m) rating = parseFloat(m[1]);
                }
                if (!rating) {
                    const rText = allSpans.map(s => (s.textContent || '').trim())
                        .find(t => /^[1-5][.,]\d$/.test(t));
                    if (rText) rating = parseFloat(rText.replace(',', '.'));
                }

                // ── Review count ──────────────────────────────────────────────────
                let reviewCount = null;
                const reviewAriaEl = card.querySelector('[aria-label*="review"]');
                if (reviewAriaEl) {
                    const m = (reviewAriaEl.getAttribute('aria-label') || '').match(/(\d[\d,]*)/);
                    if (m) reviewCount = parseInt(m[1].replace(/,/g, ''), 10);
                }
                if (!reviewCount) {
                    const rct = allSpans.map(s => (s.textContent || '').trim())
                        .find(t => /^\([\d,\.]+\)$/.test(t));
                    if (rct) reviewCount = parseInt(rct.replace(/[(),\.]/g, ''), 10);
                }

                // ── Category (business type) ──────────────────────────────────────
                // Short text that is NOT name, NOT numeric, NOT price, NOT status
                let category = null;
                const catCandidates = allSpans
                    .map(s => (s.textContent || '').trim())
                    .filter(t => t && t.length > 2 && t.length < 60
                              && t !== name
                              && !/^\d/.test(t)
                              && !/[₹$€£¥]/.test(t)
                              && !/^\(/.test(t)
                              && !/^(open|close|closes|opens|km|mi|sponsored|ad$)/i.test(t)
                              && !/^\d+[.,]\d$/.test(t));
                if (catCandidates.length) category = catCandidates[0];

                // ── Address snippet ───────────────────────────────────────────────
                let address = null;
                for (const s of allSpans) {
                    const t = (s.textContent || '').trim();
                    if (t && t.includes(',') && t.length > 5 && t.length < 120
                        && !/^[\d.]+$/.test(t) && !t.startsWith('(') && !t.includes('http')) {
                        address = t;
                        break;
                    }
                }

                // ── Price level (₹ / $$ etc.) ─────────────────────────────────────
                let priceLevel = null;
                for (const s of allSpans) {
                    const t = (s.textContent || '').trim().replace(/[·\s]/g, '');
                    if (t && /^[₹$€£¥]{1,4}$/.test(t)) { priceLevel = t; break; }
                }

                // ── Open/Closed status ────────────────────────────────────────────
                let openStatus = null;
                for (const s of allSpans) {
                    const t = (s.textContent || '').trim();
                    if (/(open now|closed|closes|opens at|open 24)/i.test(t) && t.length < 50) {
                        openStatus = t; break;
                    }
                }

                // ── Sponsored / Ad flag ───────────────────────────────────────────
                const isSponsored = !!(
                    card.querySelector('[data-is-ad="true"]') ||
                    card.querySelector('[aria-label*="Sponsored"]') ||
                    allSpans.some(s => /^(Sponsored|Ad)$/i.test((s.textContent || '').trim()))
                );

                // ── Website URL (non-Google link) ─────────────────────────────────
                const websiteUrl = hrefs.find(h => !h.includes('google.') && !h.includes('goo.gl')) || null;

                return { dataCid, hrefs, jslog, name, rating, reviewCount, category, address, priceLevel, openStatus, isSponsored, websiteUrl };
            });

            // ── Scroll to trigger next batch of lazy-loaded results ────────────
            // (runs in the same evaluate — saves a round-trip)
            let scrolled = false;

            const feedStyle = window.getComputedStyle(feed);
            if (/auto|scroll/.test(feedStyle.overflow + feedStyle.overflowY)
                    && feed.scrollHeight > feed.clientHeight) {
                feed.scrollBy(0, 2400);
                scrolled = true;
            }

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

            // Always scrollIntoView last child — ensures the first lazy load triggers
            const lastChild = feed.lastElementChild;
            if (lastChild) lastChild.scrollIntoView({ block: 'end' });

            return { feedExists: true, cards, totalCards: rawCards.length };
        });

        if (!extracted.feedExists && round === 0) {
            const s = await detectPageState(page);
            if (s === 'no_results') return { rank: null, ranked: false, competitors: [] };
            return { rank: null, ranked: false, error: 'feed_lost', competitors: [] };
        }

        const { cards, totalCards } = extracted;

        // ── Match check (Node.js side) ────────────────────────────────────────
        let effectiveRank = 0;

        for (const card of cards) {
            // A real business card has at least one resolved href OR a data-cid.
            // Separators and spacers have neither — they're correctly skipped.
            // We keep this simple: don't require card.name because the CSS class
            // Google uses for business names changes periodically; a broken selector
            // would make card.name null for ALL cards → everything looks not-ranked.
            const isResultCard = card.hrefs.length > 0 || !!card.dataCid;
            if (!isResultCard) continue;

            effectiveRank++;

            // Collect ALL competitors above the target business.
            // We add every named card here; when we find the target at rank N,
            // we return only the slice where rank < N (all businesses above it).
            if (card.name) {
                const mapsUrl = card.hrefs.find(h => h.includes('/maps/place/'))
                             || card.hrefs.find(h => h.includes('google.com/maps'))
                             || card.hrefs[0]
                             || null;
                // Extract placeId + hexId from the Maps URL at zero extra cost
                const urlIds = mapsUrl ? extractIdsFromUrl(mapsUrl) : {};
                // Extract the competitor's own coordinates from their mapsUrl
                // and compute distance from this grid point — pure math, no network.
                const compCoords = extractCoordsFromMapsUrl(mapsUrl);
                const distanceMeters = compCoords
                    ? haversineMeters(lat, lng, compCoords.lat, compCoords.lng)
                    : null;
                competitors.push({
                    rank:           effectiveRank,
                    name:           card.name,
                    cid:            card.dataCid || urlIds.cid || null,
                    placeId:        urlIds.placeId || null,
                    hexId:          urlIds.hexId   || null,
                    mapsUrl,
                    websiteUrl:     card.websiteUrl  || null,
                    rating:         card.rating      ?? null,
                    reviewCount:    card.reviewCount ?? null,
                    category:       card.category    || null,
                    address:        card.address     || null,
                    priceLevel:     card.priceLevel  || null,
                    openStatus:     card.openStatus  || null,
                    isSponsored:    card.isSponsored ?? false,
                    lat:            compCoords?.lat ?? null,
                    lng:            compCoords?.lng ?? null,
                    distanceMeters,
                });
            }

            if (effectiveRank > maxRankToShow) {
                return { rank: null, ranked: false, competitors };
            }

            // 1 ▸ data-cid direct match
            if (card.dataCid) {
                if (targetIds.cid && card.dataCid === targetIds.cid) {
                    return { rank: effectiveRank, ranked: true, competitors: competitors.filter(c => c.rank < effectiveRank) };
                }
                if (targetIds.hexId) {
                    try {
                        if (card.dataCid === BigInt(targetIds.hexId.split(':')[1]).toString()) {
                            return { rank: effectiveRank, ranked: true, competitors: competitors.filter(c => c.rank < effectiveRank) };
                        }
                    } catch { /* malformed */ }
                }
            }

            // 2 ▸ Scan all hrefs for any matching ID format
            for (const href of card.hrefs) {
                const cardIds = extractIdsFromUrl(href);
                if (!cardIds.placeId && !cardIds.hexId && !cardIds.cid) continue;
                if (idsMatch(targetIds, cardIds)) {
                    return { rank: effectiveRank, ranked: true, competitors: competitors.filter(c => c.rank < effectiveRank) };
                }
            }

            // 3 ▸ jslog: Google sometimes embeds CID here as a 15-20-digit number
            if (card.jslog && targetIds.cid) {
                const m = card.jslog.match(/\b(\d{15,20})\b/);
                if (m && m[1] === targetIds.cid) {
                    return { rank: effectiveRank, ranked: true, competitors: competitors.filter(c => c.rank < effectiveRank) };
                }
            }
        }

        // Seen enough results without a match — stop
        if (effectiveRank >= maxRankToShow) {
            return { rank: null, ranked: false, competitors };
        }

        // ── Smart wait: exit as soon as new cards appear (max SCROLL_WAIT_MAX ms) ──
        // Selector mirrors the three layouts detectPageState recognises so a page
        // using the [data-cid]-only layout doesn't time out every round.
        await page.waitForFunction(
            (expectedCount) => {
                const feed = document.querySelector('[role="feed"]');
                const n = feed
                    ? feed.querySelectorAll(':scope > div').length
                    : (document.querySelectorAll('[role="article"]').length
                       || document.querySelectorAll('[data-cid]').length);
                return n > expectedCount;
            },
            totalCards,
            { timeout: SCROLL_WAIT_MAX }
        ).catch(() => {}); // timeout = no new cards = plateau; loop handles it

        // ── Plateau detection: stop if feed didn't grow ───────────────────────
        if (totalCards <= prevTotalCards && round > 0) break;
        prevTotalCards = totalCards;
    }

    return { rank: null, ranked: false, competitors };
}
