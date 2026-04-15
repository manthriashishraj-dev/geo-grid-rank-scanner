/**
 * main.js — Geo-Grid Rank Scanner
 *
 * Apify actor entry point. Orchestrates:
 *  1. Input validation
 *  2. Target business Place ID resolution (if name provided instead of ID)
 *  3. Grid point generation
 *  4. Parallel rank scraping at each grid point (concurrency 3)
 *  5. Summary computation (quadrant averages, weakest quadrant)
 *  6. Dataset output
 */

import { Actor, log } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';
import { generateGridPoints } from './generateGrid.js';
import { resolveTargetPlaceId } from './resolveTarget.js';
import { checkRankAtPoint } from './scrapeRank.js';

await Actor.init();

// ─── Input ────────────────────────────────────────────────────────────────────

const input = await Actor.getInput();

const {
    keyword,
    placeId: inputPlaceId,
    businessName,
    centerLat,
    centerLng,
    gridSize            = 7,
    gridSpacingMeters   = 500,
    maxRankToShow       = 20,
    language            = 'en',
    proxyConfiguration  = { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
} = input;

// Validate required inputs
if (!keyword)   throw new Error('Input "keyword" is required (e.g. "Dental clinic")');
if (!centerLat) throw new Error('Input "centerLat" is required');
if (!centerLng) throw new Error('Input "centerLng" is required');
if (!inputPlaceId && !businessName) {
    throw new Error('Provide either "placeId" or "businessName" so the actor knows which business to track.');
}

log.info('=== Geo-Grid Rank Scanner ===');
log.info(`Keyword: "${keyword}"`);
log.info(`Center: ${centerLat}, ${centerLng}`);
log.info(`Grid: ${gridSize}×${gridSize} = ${gridSize * gridSize} points @ ${gridSpacingMeters}m spacing`);
log.info(`Target: ${inputPlaceId || businessName}`);

// ─── Proxy setup ──────────────────────────────────────────────────────────────

const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// ─── Generate grid points ─────────────────────────────────────────────────────

const gridPoints = generateGridPoints({
    centerLat,
    centerLng,
    spacingMeters: gridSpacingMeters,
    gridSize,
});

log.info(`Generated ${gridPoints.length} grid points.`);

// ─── State shared across crawler requests ─────────────────────────────────────

let resolvedPlaceId = inputPlaceId || null;
let resolvedName    = businessName || null;
let placeIdResolved = !!inputPlaceId; // true if we already have it from input

// gridResults[pointIndex] will be populated by crawler handlers
const gridResults = new Array(gridPoints.length).fill(null);

// ─── Build request queue ──────────────────────────────────────────────────────

// First request: resolve place_id if not supplied
// Then: one request per grid point

const requests = [];

if (!placeIdResolved) {
    requests.push({
        url: `https://www.google.com/maps/search/${encodeURIComponent(businessName)}/?hl=${language}`,
        label: 'RESOLVE_TARGET',
        userData: { businessName, language },
    });
}

for (const pt of gridPoints) {
    requests.push({
        url: `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/@${pt.lat},${pt.lng},14z?hl=${language}`,
        label: 'GRID_POINT',
        userData: { point: pt, keyword, language },
    });
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

const crawler = new PlaywrightCrawler({
    proxyConfiguration: proxy,
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 60,

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

    // Anti-bot: mask automation fingerprint
    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],

    requestHandler: async ({ request, page, log: crawlerLog }) => {
        const { label, userData } = request;

        if (label === 'RESOLVE_TARGET') {
            crawlerLog.info(`Resolving Place ID for "${userData.businessName}"…`);
            const result = await resolveTargetPlaceId({
                page,
                businessName: userData.businessName,
                language: userData.language,
            });

            if (result.placeId) {
                resolvedPlaceId = result.placeId;
                resolvedName    = result.resolvedName || userData.businessName;
                placeIdResolved = true;
                crawlerLog.info(`Resolved Place ID: ${resolvedPlaceId} → "${resolvedName}"`);
            } else {
                crawlerLog.warning(
                    `Could not resolve Place ID for "${userData.businessName}". ` +
                    'Will use name-based fallback matching for all grid points.'
                );
            }

            return; // No dataset push for resolution step
        }

        if (label === 'GRID_POINT') {
            const { point } = userData;

            // If place_id resolution failed, we still proceed with name matching
            if (!resolvedPlaceId && !resolvedName) {
                crawlerLog.warning(`No target identifier — skipping point ${point.pointIndex}`);
                gridResults[point.pointIndex] = { ...point, rank: null, ranked: false, error: 'no_target_id' };
                return;
            }

            crawlerLog.info(
                `[${point.pointIndex + 1}/${gridPoints.length}] ` +
                `Checking rank at (${point.lat}, ${point.lng}) — ${point.quadrant}`
            );

            await sleep(Math.random() * 500); // small jitter to avoid burst

            const result = await checkRankAtPoint({
                page,
                keyword: userData.keyword,
                lat: point.lat,
                lng: point.lng,
                targetPlaceId: resolvedPlaceId || '',
                targetName: resolvedName || '',
                maxRankToShow,
                language: userData.language,
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

            if (result.ranked) {
                crawlerLog.info(`  → Rank #${result.rank} in ${point.quadrant}`);
            } else {
                crawlerLog.info(`  → Not ranked in top ${maxRankToShow}`);
            }
        }
    },

    failedRequestHandler: async ({ request, log: crawlerLog }) => {
        crawlerLog.error(`Request failed: ${request.url}`);
        if (request.userData.point) {
            const { point } = request.userData;
            gridResults[point.pointIndex] = {
                ...point,
                rank: null,
                ranked: false,
                error: 'request_failed',
            };
        }
    },
});

// For RESOLVE_TARGET to run before GRID_POINT requests, we add them in order.
// Crawlee processes requests in FIFO order by default.
await crawler.addRequests(requests);
await crawler.run();

// ─── Summary computation ──────────────────────────────────────────────────────

// Rank tier thresholds (matches the PDF report colour bands)
const TIER_VISIBLE   = { min: 1,  max: 3  };   // green
const TIER_WEAK      = { min: 4,  max: 7  };   // yellow
// rank 8+ or null → INVISIBLE (red)

function getRankCategory(rank) {
    if (!rank || rank > 7) return 'INVISIBLE';
    if (rank <= 3)          return 'VISIBLE';
    return 'WEAK';
}

// Center point index (the business location itself)
const centerIndex = Math.floor(gridSize / 2) * gridSize + Math.floor(gridSize / 2);

// Annotate each result with category + isCenter flag
const annotatedResults = gridResults.map((pt, i) => {
    if (!pt) return null;
    return {
        ...pt,
        category: getRankCategory(pt.rank),
        isCenter: i === centerIndex,
        displayRank: pt.rank && pt.rank <= 7 ? String(pt.rank) : '8+',
    };
}).filter(Boolean);

// Counts
const visibleCount   = annotatedResults.filter((p) => p.category === 'VISIBLE').length;
const weakCount      = annotatedResults.filter((p) => p.category === 'WEAK').length;
const invisibleCount = annotatedResults.filter((p) => p.category === 'INVISIBLE' && !p.isCenter).length;
const totalPoints    = annotatedResults.length;

// Visibility score = (visible + weak) / total × 100  (matches PDF formula)
const visibilityScore = +(((visibleCount + weakCount) / totalPoints) * 100).toFixed(1);

// Average rank helpers
function avg(arr) {
    if (!arr.length) return null;
    return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
}

// Quadrant averages (NW/NE/SW/SE — same as GMB Master Pro app storage)
// Use rank 20 for invisible points so average reflects true weakness
const quadrantRanks = { NW: [], NE: [], SW: [], SE: [] };
for (const pt of annotatedResults) {
    if (pt.isCenter) continue;
    const effectiveRank = pt.rank ?? 20;
    quadrantRanks[pt.quadrant].push(effectiveRank);
}

const quadrantAvg = {
    NW: avg(quadrantRanks.NW),
    NE: avg(quadrantRanks.NE),
    SW: avg(quadrantRanks.SW),
    SE: avg(quadrantRanks.SE),
};

const validQuadrants = Object.entries(quadrantAvg).filter(([, v]) => v !== null);
const weakestQuadrant = validQuadrants.length
    ? validQuadrants.sort((a, b) => b[1] - a[1])[0][0]
    : null;

// All ranked positions (excluding center)
const allRanks = annotatedResults
    .filter((p) => !p.isCenter && p.rank != null)
    .map((p) => p.rank);

// 2-D grid matrix for easy heatmap rendering (row-major order)
// Each cell: { row, col, rank, category, displayRank, isCenter }
const gridMatrix = [];
for (let r = 0; r < gridSize; r++) {
    const row = [];
    for (let c = 0; c < gridSize; c++) {
        const pt = annotatedResults.find((p) => p.row === r && p.col === c);
        row.push(pt
            ? { row: r, col: c, rank: pt.rank, category: pt.category, displayRank: pt.displayRank, isCenter: pt.isCenter }
            : { row: r, col: c, rank: null, category: 'INVISIBLE', displayRank: '8+', isCenter: false }
        );
    }
    gridMatrix.push(row);
}

const summary = {
    // Visibility score (headline metric, matches PDF)
    visibilityScore,         // e.g. 12.2  (%)
    visibilityScoreLabel:    `${Math.round(visibilityScore)}%`,

    // Point counts by tier
    totalPoints,
    visibleCount,            // rank 1–3 (green)
    weakCount,               // rank 4–7 (yellow)
    invisibleCount,          // rank 8+  (red, excludes center)

    // Rank stats
    avgRank:          avg(allRanks),
    minRank:          allRanks.length ? Math.min(...allRanks) : null,
    maxRank:          allRanks.length ? Math.max(...allRanks) : null,
    top3Count:        allRanks.filter((r) => r <= 3).length,

    // Quadrant breakdown
    quadrantAvg,
    weakestQuadrant,
};

// ─── Dataset output ───────────────────────────────────────────────────────────

const output = {
    keyword,
    businessName:       resolvedName || businessName || null,
    placeId:            resolvedPlaceId || null,
    centerLat,
    centerLng,
    gridSize,
    gridSpacingMeters,
    maxRankToShow,
    scanDate:           new Date().toISOString().split('T')[0],
    scanTimestamp:      new Date().toISOString(),

    // Flat list of all grid point results
    gridResults:        annotatedResults,

    // 2-D matrix [row][col] — ready for heatmap rendering / PDF generation
    gridMatrix,

    summary,
};

await Actor.pushData(output);

log.info('=== Scan Complete ===');
log.info(`Visibility score: ${summary.visibilityScoreLabel} | Visible: ${visibleCount} | Weak: ${weakCount} | Invisible: ${invisibleCount}`);
log.info(`Avg rank: ${summary.avgRank} | Top-3 count: ${summary.top3Count} | Weakest quadrant: ${summary.weakestQuadrant}`);

await Actor.exit();
