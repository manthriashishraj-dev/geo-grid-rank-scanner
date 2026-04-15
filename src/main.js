/**
 * main.js — Geo-Grid Rank Scanner
 *
 * Apify actor entry point. Orchestrates:
 *  1. Input validation — requires at least one hard unique ID
 *  2. Normalise target IDs (googleMapsUrl | placeId | cid | hexId)
 *  3. Grid point generation
 *  4. Parallel rank scraping at each grid point (10 concurrent tabs)
 *  5. Summary computation (visibility score, quadrant averages)
 *  6. Dataset output
 *
 * No name-based resolution. All matching uses Google-native unique IDs only:
 *   ChIJ Place ID, hex-pair, or CID (numeric).
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';
import { generateGridPoints }   from './generateGrid.js';
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
    centerLat,
    centerLng,
    gridSize           = 7,
    gridSpacingMeters  = 500,
    maxRankToShow      = 20,
    language           = 'en',
    proxyConfiguration = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

// ─── Validate ─────────────────────────────────────────────────────────────────

if (!keyword)   throw new Error('"keyword" is required (e.g. "Dental clinic")');
if (!centerLat) throw new Error('"centerLat" is required');
if (!centerLng) throw new Error('"centerLng" is required');
if (!googleMapsUrl && !placeId && !cid && !hexId) {
    throw new Error(
        'Provide at least one unique identifier for the target business:\n' +
        '  • googleMapsUrl — paste the full Google Maps URL (easiest)\n' +
        '  • placeId       — ChIJ... Place ID\n' +
        '  • cid           — numeric Customer ID\n' +
        '  • hexId         — hex-pair (0x...:0x...)'
    );
}

// ─── Normalise target IDs ─────────────────────────────────────────────────────
// Derives all available ID formats from whatever the user provided.
// Cross-format bridge: CID = decimal of hex-pair second part, so
// providing any one format lets us match against any other format in results.

const targetIds = normaliseTargetIds({ googleMapsUrl, placeId, cid, hexId });

// Extract a display name from the Maps URL path for logging/output (cosmetic only)
let displayName = null;
if (googleMapsUrl) {
    const m = googleMapsUrl.match(/maps\/place\/([^/@]+)/);
    if (m) displayName = decodeURIComponent(m[1].replace(/\+/g, ' '));
}

log.info('=== Geo-Grid Rank Scanner ===');
log.info(`Keyword:   "${keyword}"`);
log.info(`Center:    ${centerLat}, ${centerLng}`);
log.info(`Grid:      ${gridSize}×${gridSize} = ${gridSize * gridSize} points @ ${gridSpacingMeters}m`);
log.info(`Target IDs: placeId=${targetIds.placeId || '-'} | cid=${targetIds.cid || '-'} | hexId=${targetIds.hexId || '-'}`);

// ─── Proxy ────────────────────────────────────────────────────────────────────

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// ─── Generate grid points ─────────────────────────────────────────────────────

const gridPoints = generateGridPoints({
    centerLat,
    centerLng,
    spacingMeters: gridSpacingMeters,
    gridSize,
});

log.info(`Generated ${gridPoints.length} grid points.`);

// gridResults[pointIndex] populated by crawler handlers
const gridResults = new Array(gridPoints.length).fill(null);

// ─── Build request queue ──────────────────────────────────────────────────────

const requests = gridPoints.map((pt) => ({
    url: `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${pt.lat},${pt.lng},14z?hl=${language}`,
    label: 'GRID_POINT',
    userData: { point: pt, keyword, language },
}));

// ─── Crawler ──────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: 10,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 45,   // prevent Crawlee default (60s) from overriding page.goto timeout

    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--lang=en-US',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],

    requestHandler: async ({ request, page, log: crawlerLog }) => {
        const { point } = request.userData;

        crawlerLog.info(
            `[${point.pointIndex + 1}/${gridPoints.length}] ` +
            `(${point.lat}, ${point.lng}) — ${point.quadrant}`
        );

        await sleep(Math.random() * 400); // small jitter

        const result = await checkRankAtPoint({
            page,
            keyword: request.userData.keyword,
            lat:     point.lat,
            lng:     point.lng,
            targetIds,
            maxRankToShow,
            language: request.userData.language,
        });

        gridResults[point.pointIndex] = {
            pointIndex: point.pointIndex,
            row:        point.row,
            col:        point.col,
            lat:        point.lat,
            lng:        point.lng,
            quadrant:   point.quadrant,
            rank:       result.rank,
            ranked:     result.ranked,
            ...(result.error ? { error: result.error } : {}),
        };

        crawlerLog.info(result.ranked
            ? `  → Rank #${result.rank}`
            : `  → Not in top ${maxRankToShow}`
        );
    },

    failedRequestHandler: async ({ request, log: crawlerLog }) => {
        crawlerLog.error(`Failed: ${request.url}`);
        const { point } = request.userData;
        gridResults[point.pointIndex] = {
            pointIndex: point.pointIndex,
            row: point.row, col: point.col,
            lat: point.lat, lng: point.lng,
            quadrant: point.quadrant,
            rank: null, ranked: false, error: 'request_failed',
        };
    },
});

await crawler.addRequests(requests);
await crawler.run();

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
        displayRank: pt.rank && pt.rank <= 7 ? String(pt.rank) : '8+',
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
    quadrantRanks[pt.quadrant].push(pt.rank ?? 20);
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
            : { row: r, col: c, rank: null, category: 'INVISIBLE', displayRank: '8+', isCenter: false };
    })
);

const summary = {
    visibilityScore,
    visibilityScoreLabel: `${Math.round(visibilityScore)}%`,
    totalPoints,
    visibleCount,
    weakCount,
    invisibleCount,
    avgRank:        avg(allRanks),
    minRank:        allRanks.length ? Math.min(...allRanks) : null,
    maxRank:        allRanks.length ? Math.max(...allRanks) : null,
    top3Count:      allRanks.filter((r) => r <= 3).length,
    quadrantAvg,
    weakestQuadrant,
};

// ─── Output ───────────────────────────────────────────────────────────────────

await Actor.pushData({
    keyword,
    businessName:   displayName,
    targetIds,           // all resolved ID formats for reference
    centerLat,
    centerLng,
    gridSize,
    gridSpacingMeters,
    maxRankToShow,
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
