/**
 * generateGrid.js
 *
 * Generates an N×N grid of lat/lng points centered on a given coordinate.
 * Uses the same formula as GMB Master Pro's src/lib/serpapi.js — results match 1:1.
 *
 * Earth approximation constants:
 *   1 degree latitude  ≈ 111,000 m  (constant everywhere)
 *   1 degree longitude ≈ 111,000 × cos(lat) m  (shrinks toward poles)
 */

/**
 * Assign a quadrant label (NW/NE/SW/SE) to a grid cell.
 * @param {number} row  0-indexed row
 * @param {number} col  0-indexed col
 * @param {number} gridSize  total size (e.g. 7)
 * @returns {'NW'|'NE'|'SW'|'SE'}
 */
function getQuadrant(row, col, gridSize) {
    const mid = Math.floor(gridSize / 2);
    if (row <= mid && col <= mid) return 'NW';
    if (row <= mid && col > mid)  return 'NE';
    if (row > mid  && col <= mid) return 'SW';
    return 'SE';
}

/**
 * Generate all grid points for a geo-grid scan.
 *
 * @param {object} params
 * @param {number} params.centerLat        Latitude of grid center
 * @param {number} params.centerLng        Longitude of grid center
 * @param {number} params.spacingMeters    Distance between adjacent points in metres (e.g. 500)
 * @param {number} params.gridSize         N for an N×N grid (3, 5, 7, or 9)
 * @returns {Array<{lat: number, lng: number, row: number, col: number, quadrant: string, pointIndex: number}>}
 */
export function generateGridPoints({ centerLat, centerLng, spacingMeters, gridSize }) {
    const LAT_PER_METER = 1 / 111000;
    const LNG_PER_METER = 1 / (111000 * Math.cos((centerLat * Math.PI) / 180));
    const half = Math.floor(gridSize / 2);
    const points = [];

    for (let rowOffset = -half; rowOffset <= half; rowOffset++) {
        for (let colOffset = -half; colOffset <= half; colOffset++) {
            const row = rowOffset + half;
            const col = colOffset + half;
            points.push({
                lat: +(centerLat + rowOffset * spacingMeters * LAT_PER_METER).toFixed(6),
                lng: +(centerLng + colOffset * spacingMeters * LNG_PER_METER).toFixed(6),
                row,
                col,
                quadrant: getQuadrant(row, col, gridSize),
                pointIndex: points.length,
            });
        }
    }

    return points;
}

/**
 * Return the optimal Google Maps zoom level for a given grid spacing.
 *
 * Zoom controls how tightly Google anchors results to the search location:
 *   z=16 → ~600m  view radius  (dense city, 300m spacing)
 *   z=15 → ~1.2km view radius  (standard,   500m spacing)  ← default
 *   z=14 → ~2.5km view radius  (suburb,    1000m spacing)
 *   z=13 → ~5km   view radius  (rural,     2000m spacing)
 *
 * Using a zoom that is too LOW (e.g. z=14 for 500m spacing) causes Google to
 * pull in businesses 2-3km away, making the rank data inaccurate for that cell.
 *
 * @param {number} spacingMeters
 * @returns {number}
 */
export function getZoomForSpacing(spacingMeters) {
    if (spacingMeters <= 300)  return 16;
    if (spacingMeters <= 700)  return 15;
    if (spacingMeters <= 1500) return 14;
    return 13;
}

/**
 * Build a Google Maps search URL that anchors the viewport to a specific lat/lng.
 *
 * @param {string} keyword       e.g. "Dental clinic"
 * @param {number} lat
 * @param {number} lng
 * @param {string} lang          e.g. "en"
 * @param {number} spacingMeters grid spacing — used to compute the correct zoom level
 * @returns {string}
 */
export function buildGridPointUrl(keyword, lat, lng, lang = 'en', spacingMeters = 500) {
    const q    = encodeURIComponent(keyword);
    const zoom = getZoomForSpacing(spacingMeters);
    return `https://www.google.com/maps/search/${q}/@${lat},${lng},${zoom}z?hl=${lang}`;
}
