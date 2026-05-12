/**
 * main.js — Geo-Grid Rank Scanner
 *
 * Apify actor entry point. Orchestrates:
 *  1. Input validation — requires at least one hard unique ID
 *  2. Normalise target IDs (googleMapsUrl | placeId | cid | hexId)
 *  3. Auto-extract center coordinates from Google Maps URL (if not provided manually)
 *  4. Grid point generation
 *  5. Parallel rank scraping at each grid point via crawler factory
 *  6. Second-pass retry for any errored points (lower concurrency)
 *  7. Summary computation (visibility score, quadrant averages)
 *  8. Dataset output
 *
 * No name-based resolution. All matching uses Google-native unique IDs only:
 *   ChIJ Place ID, hex-pair, or CID (numeric).
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';
import { generateGridPoints, getZoomForSpacing } from './generateGrid.js';
import { checkRankAtPoint }     from './scrapeRank.js';
import { normaliseTargetIds }   from './extractPlaceId.js';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();

const {
    keyword,
    googleMapsUrl,
    placeId,
    cid,
    hexId,
    businessName:      inputBusinessName = null,  // optional override for display name
    centerLat,
    centerLng,
    gridSize           = 7,
    gridSpacingMeters  = 500,
    maxRankToShow      = 20,
    language           = 'en',
    // proxyCountry: ISO-3166-1 alpha-2 country code for residential proxy routing.
    // "IN" is the default — Indian residential IPs are required for accurate Indian results.
    // Change to "US", "GB", "AU" etc. only if scanning a different country's market.
    proxyCountry       = 'IN',
    proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

// ─── Validate ─────────────────────────────────────────────────────────────────

if (!keyword) throw new Error('"keyword" is required (e.g. "Dental clinic")');
if (!googleMapsUrl && !placeId && !cid && !hexId) {
    throw new Error(
        'Provide at least one unique identifier for the target business:\n' +
        '  • googleMapsUrl — paste the full Google Maps URL (easiest)\n' +
        '  • placeId       — ChIJ... Place ID\n' +
        '  • cid           — numeric Customer ID\n' +
        '  • hexId         — hex-pair (0x...:0x...)'
    );
}

// ─── Auto-extract center coordinates from Google Maps URL ─────────────────────
// If centerLat/centerLng weren't provided manually, extract them from the URL.
// Full Maps URL contains /@lat,lng,zoom — short URLs (maps.app.goo.gl) are
// followed via a HEAD redirect to get the final URL first.

let resolvedLat = centerLat || null;
let resolvedLng = centerLng || null;

if ((!resolvedLat || !resolvedLng) && googleMapsUrl) {
    const directMatch = googleMapsUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*),/);
    if (directMatch) {
        resolvedLat = resolvedLat || parseFloat(directMatch[1]);
        resolvedLng = resolvedLng || parseFloat(directMatch[2]);
        log.info(`Auto-extracted center from URL: ${resolvedLat}, ${resolvedLng}`);
    } else {
        try {
            const resp = await fetch(googleMapsUrl, { method: 'HEAD', redirect: 'follow' });
            const finalUrl = resp.url;
            const redirectMatch = finalUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*),/);
            if (redirectMatch) {
                resolvedLat = resolvedLat || parseFloat(redirectMatch[1]);
                resolvedLng = resolvedLng || parseFloat(redirectMatch[2]);
                log.info(`Auto-extracted center from redirect URL: ${resolvedLat}, ${resolvedLng}`);
            }
        } catch (e) {
            log.warning(`Could not follow URL redirect for coordinate extraction: ${e.message}`);
        }
    }
}

if (!resolvedLat || !resolvedLng) {
    throw new Error(
        '"centerLat" and "centerLng" are required.\n' +
        'Either enter them manually, or paste a full Google Maps URL that contains\n' +
        'coordinates in its path (e.g. /@17.38,78.48,14z).'
    );
}

// ─── Normalise target IDs ─────────────────────────────────────────────────────

const targetIds = normaliseTargetIds({ googleMapsUrl, placeId, cid, hexId });

// Resolve display name (cosmetic only — no matching logic depends on this)
let displayName = inputBusinessName || null;
if (!displayName && googleMapsUrl) {
    const m = googleMapsUrl.match(/maps\/place\/([^/@]+)/);
    if (m) displayName = decodeURIComponent(m[1].replace(/\+/g, ' '));
}

log.info('=== Geo-Grid Rank Scanner ===');
log.info(`Keyword:    "${keyword}"`);
log.info(`Center:     ${resolvedLat}, ${resolvedLng}`);

// Warn if coordinates were auto-extracted from URL — they may be map-view centre,
// not the exact business pin. User should verify or enter coordinates manually.
if (!centerLat && !centerLng && googleMapsUrl) {
    log.warning(
        '⚠️  centerLat/centerLng were auto-extracted from the Google Maps URL.\n' +
        '   The /@lat,lng in a Maps URL is the MAP VIEW centre, not always the business pin.\n' +
        '   If you zoomed out before copying the URL the grid could be offset by 200–500m.\n' +
        '   For maximum accuracy: right-click the business pin → "What\'s here?" → copy those coords.'
    );
}
log.info(`Grid:       ${gridSize}×${gridSize} = ${gridSize * gridSize} points @ ${gridSpacingMeters}m`);
log.info(`Target IDs: placeId=${targetIds.placeId || '-'} | cid=${targetIds.cid || '-'} | hexId=${targetIds.hexId || '-'}`);

// ─── Proxy ────────────────────────────────────────────────────────────────────

const resolvedProxyConfig = proxyCountry
    ? { ...proxyConfiguration, countryCode: proxyCountry }
    : proxyConfiguration;

log.info(`Proxy country: ${proxyCountry} — residential IPs routed through this country`);

const proxy = await Actor.createProxyConfiguration(resolvedProxyConfig);

// ─── Generate grid points ─────────────────────────────────────────────────────

const gridPoints = generateGridPoints({
    centerLat:    resolvedLat,
    centerLng:    resolvedLng,
    spacingMeters: gridSpacingMeters,
    gridSize,
});

log.info(`Generated ${gridPoints.length} grid points.`);

// gridResults[pointIndex] populated by crawler handlers
const gridResults = new Array(gridPoints.length).fill(null);

// ─── Shared crawler config ────────────────────────────────────────────────────
// Shared between primary and second-pass crawlers to avoid duplication.

const RETRYABLE_ERRORS = ['no_feed', 'nav_timeout', 'feed_lost', 'consent_bypass_failed', 'captcha'];

const SHARED_LAUNCH_CONTEXT = {
    launchOptions: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--lang=en-US',
            // Block all image requests at the Chromium engine level.
            // Map tiles, business photos, and street view assets are the largest
            // bandwidth consumers (~35-45% of a Maps page). We never need them for
            // DOM-based rank scraping. This is NOT page.route() — Chromium simply
            // never generates these network requests, so Google sees nothing abnormal.
            '--blink-settings=imagesEnabled=false',
            // Disable background networking (Safe Browsing, auto-update pings,
            // metrics beacons). These are invisible background requests we never need.
            '--disable-background-networking',
        ],
    },
};

const SHARED_PRE_NAV_HOOKS = [
    async ({ page }) => {
        // Smaller viewport = fewer map tile requests. Combined with imagesEnabled=false
        // this is belt-and-suspenders — tiles won't load anyway, but smaller DOM layout
        // also reduces CSS/reflow overhead per page.
        await page.setViewportSize({ width: 960, height: 600 });

        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        // Pre-set SOCS cookie to bypass Google's GDPR/EU consent page.
        // Residential proxies often route through EU/UK IPs which trigger consent.google.com.
        try {
            await page.context().addCookies([{
                name:   'SOCS',
                value:  'CAISHAgBEhJnd3NfMjAyMzA4MDItMF9SQzEaAmVuIAEaBgiAsLWmBg',
                domain: '.google.com',
                path:   '/',
            }]);
        } catch { /* context may not be ready */ }

    },
];

/**
 * Build a request handler for a crawler pass.
 * @param {{ jitterMs: number, passLabel: string }} opts
 */
function makeRequestHandler({ jitterMs, passLabel }) {
    return async ({ request, page, log: crawlerLog }) => {
        const { point } = request.userData;

        crawlerLog.info(
            `${passLabel}[${point.pointIndex + 1}/${gridPoints.length}] ` +
            `(${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}) — ${point.quadrant}`
        );

        if (jitterMs > 0) await sleep(Math.random() * jitterMs);

        const result = await checkRankAtPoint({
            page,
            keyword:       request.userData.keyword,
            lat:           point.lat,
            lng:           point.lng,
            targetIds,
            maxRankToShow,
            language:      request.userData.language,
            spacingMeters: gridSpacingMeters,
        });

        if (result.error && RETRYABLE_ERRORS.some(e => result.error.startsWith(e))) {
            throw new Error(`retryable: ${result.error}`);
        }

        gridResults[point.pointIndex] = {
            pointIndex: point.pointIndex,
            row:        point.row,
            col:        point.col,
            lat:        point.lat,
            lng:        point.lng,
            quadrant:   point.quadrant,
            rank:       result.rank,
            ranked:     result.ranked,
            competitors: result.competitors || [],
            ...(result.error ? { error: result.error } : {}),
        };

        crawlerLog.info(result.ranked
            ? `  → Rank #${result.rank}`
            : `  → Not in top ${maxRankToShow}`
        );
    };
}

/**
 * Build a failed-request handler.
 * keepExisting=true: only preserve SUCCESSFUL first-pass results — if the first pass
 * itself errored, the second pass failure should still update the error info.
 */
function makeFailedHandler({ passLabel, keepExisting }) {
    return async ({ request, log: crawlerLog }) => {
        crawlerLog.error(`${passLabel}Failed: ${request.url}`);
        const { point } = request.userData;
        const existing = gridResults[point.pointIndex];
        if (keepExisting && existing && !existing.error) return; // preserve successful first-pass result
        gridResults[point.pointIndex] = {
            pointIndex: point.pointIndex,
            row: point.row, col: point.col,
            lat: point.lat, lng: point.lng,
            quadrant: point.quadrant,
            rank: null, ranked: false, error: 'request_failed', competitors: [],
        };
    };
}

/**
 * Factory: create, load, and run a PlaywrightCrawler then return.
 */
async function runCrawler({ requests, concurrency, retries, requestTimeoutSecs, navTimeoutSecs, jitterMs, passLabel }) {
    const crawler = new PlaywrightCrawler({
        proxyConfiguration:        proxy,
        maxConcurrency:            concurrency,
        maxRequestRetries:         retries,
        requestHandlerTimeoutSecs: requestTimeoutSecs,
        navigationTimeoutSecs:     navTimeoutSecs,
        launchContext:             SHARED_LAUNCH_CONTEXT,
        preNavigationHooks:        SHARED_PRE_NAV_HOOKS,
        requestHandler:            makeRequestHandler({ jitterMs, passLabel }),
        failedRequestHandler:      makeFailedHandler({ passLabel, keepExisting: passLabel !== '' }),

    });
    await crawler.addRequests(requests);
    await crawler.run();
}

// ─── Primary pass ─────────────────────────────────────────────────────────────

const primaryRequests = gridPoints.map((pt) => ({
    url:      `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${pt.lat},${pt.lng},${getZoomForSpacing(gridSpacingMeters)}z?hl=${language}`,
    label:    'GRID_POINT',
    userData: { point: pt, keyword, language },
}));

await runCrawler({
    requests:           primaryRequests,
    concurrency:        5,
    retries:            2,
    requestTimeoutSecs: 150,
    navTimeoutSecs:     60,
    jitterMs:           400,
    passLabel:          '',
});

// ─── Second pass: retry errored points at lower concurrency ───────────────────

const erroredPoints = gridPoints.filter((pt) => {
    const res = gridResults[pt.pointIndex];
    return !res || res.error;
});

if (erroredPoints.length > 0) {
    log.info(`Second pass: retrying ${erroredPoints.length} errored point(s) at lower concurrency…`);

    const retryRequests = erroredPoints.map((pt) => ({
        url:      `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${pt.lat},${pt.lng},${getZoomForSpacing(gridSpacingMeters)}z?hl=${language}`,
        label:    'GRID_POINT',
        userData: { point: pt, keyword, language },
    }));

    await runCrawler({
        requests:           retryRequests,
        concurrency:        2,
        retries:            1,
        requestTimeoutSecs: 180,
        navTimeoutSecs:     75,
        jitterMs:           1300,
        passLabel:          '[2nd-pass] ',
    });

    const resolved = erroredPoints.filter(
        (pt) => gridResults[pt.pointIndex] && !gridResults[pt.pointIndex].error
    );
    log.info(`Second pass complete. Resolved ${resolved.length}/${erroredPoints.length} errored points.`);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function getRankCategory(rank) {
    if (!rank || rank > 7) return 'INVISIBLE';
    if (rank <= 3)          return 'VISIBLE';
    return 'WEAK';
}

const centerIndex = Math.floor(gridSize / 2) * gridSize + Math.floor(gridSize / 2);

const annotatedResults = gridResults.map((pt, i) => {
    if (!pt) return null;
    return {
        ...pt,
        category:    getRankCategory(pt.rank),
        isCenter:    i === centerIndex,
        displayRank: pt.rank ? String(pt.rank) : `>${maxRankToShow}`,
    };
}).filter(Boolean);

const visibleCount   = annotatedResults.filter((p) => p.category === 'VISIBLE').length;
const weakCount      = annotatedResults.filter((p) => p.category === 'WEAK').length;
const invisibleCount = annotatedResults.filter((p) => p.category === 'INVISIBLE' && !p.isCenter).length;
const totalPoints    = annotatedResults.length;
const visibilityScore = +(((visibleCount + weakCount) / totalPoints) * 100).toFixed(1);

function avg(arr) {
    if (!arr.length) return null;
    return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
}

const quadrantRanks = { NW: [], NE: [], SW: [], SE: [] };
for (const pt of annotatedResults) {
    if (pt.isCenter) continue;
    // Unranked points get maxRankToShow+1 as penalty so they pull the quadrant
    // average UP (worse), not silently excluded or capped at a wrong constant.
    quadrantRanks[pt.quadrant].push(pt.rank ?? (maxRankToShow + 1));
}

const quadrantAvg = {
    NW: avg(quadrantRanks.NW),
    NE: avg(quadrantRanks.NE),
    SW: avg(quadrantRanks.SW),
    SE: avg(quadrantRanks.SE),
};

const weakestQuadrant = Object.entries(quadrantAvg)
    .filter(([, v]) => v !== null)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

const allRanks = annotatedResults
    .filter((p) => !p.isCenter && p.rank != null)
    .map((p) => p.rank);

// 2-D grid matrix for heatmap rendering
const gridMatrix = Array.from({ length: gridSize }, (_, r) =>
    Array.from({ length: gridSize }, (_, c) => {
        const pt = annotatedResults.find((p) => p.row === r && p.col === c);
        return pt
            ? { row: r, col: c, rank: pt.rank, category: pt.category, displayRank: pt.displayRank, isCenter: pt.isCenter }
            : { row: r, col: c, rank: null, category: 'INVISIBLE', displayRank: `>${maxRankToShow}`, isCenter: r === Math.floor(gridSize / 2) && c === Math.floor(gridSize / 2) };
    })
);

const summary = {
    visibilityScore,
    visibilityScoreLabel: `${Math.round(visibilityScore)}%`,
    totalPoints,
    visibleCount,
    weakCount,
    invisibleCount,
    avgRank:     avg(allRanks),
    minRank:     allRanks.length ? Math.min(...allRanks) : null,
    maxRank:     allRanks.length ? Math.max(...allRanks) : null,
    top3Count:   allRanks.filter((r) => r <= 3).length,
    quadrantAvg,
    weakestQuadrant,
};

// ─── Output ───────────────────────────────────────────────────────────────────

await Actor.pushData({
    keyword,
    businessName:   displayName,
    targetIds,
    centerLat:      resolvedLat,
    centerLng:      resolvedLng,
    gridSize,
    gridSpacingMeters,
    maxRankToShow,
    proxyCountry:   proxyCountry || 'auto',
    scanDate:       new Date().toISOString().split('T')[0],
    scanTimestamp:  new Date().toISOString(),
    gridResults:    annotatedResults,
    gridMatrix,
    summary,
});

log.info('=== Scan Complete ===');
log.info(`Visibility: ${summary.visibilityScoreLabel} | Visible: ${visibleCount} | Weak: ${weakCount} | Invisible: ${invisibleCount}`);
log.info(`Avg rank: ${summary.avgRank} | Weakest quadrant: ${weakestQuadrant}`);

await Actor.exit();
