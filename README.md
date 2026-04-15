# Geo-Grid Rank Scanner

Apify actor that checks a Google My Business listing's local search rank across an N×N geographic grid — **no SerpAPI key needed**. Uses direct Playwright scraping with residential proxies.

Built for GMB Master Pro · GenAi Tribe Agency.

---

## What It Does

1. Generates an N×N grid of lat/lng points centered on the business location
2. At each point, navigates to Google Maps and searches for the target keyword
3. Finds the target business in results by Place ID (with name fallback)
4. Records rank, tier (VISIBLE/WEAK/INVISIBLE), and quadrant
5. Outputs a flat result list, a 2-D grid matrix, and a full summary

---

## Inputs

| Field | Type | Required | Description |
|---|---|---|---|
| `keyword` | string | ✅ | Search keyword — e.g. `"Dental clinic"` |
| `placeId` | string | one of two | Google Place ID (`ChIJ...` or hex-pair) |
| `businessName` | string | one of two | Business name — actor auto-resolves to Place ID |
| `centerLat` | number | ✅ | Center latitude of the grid |
| `centerLng` | number | ✅ | Center longitude of the grid |
| `gridSize` | 3/5/7/9 | ✅ | Creates N×N grid. Default: `7` (49 points) |
| `gridSpacingMeters` | 300/500/1000/2000 | ✅ | Point spacing in metres. Default: `500` |
| `maxRankToShow` | number | ✅ | Rank beyond this = invisible. Default: `20` |
| `language` | string | ✅ | Google Maps `hl` param. Default: `"en"` |
| `proxyConfiguration` | object | ✅ | Residential proxies required |

### Example Input

```json
{
  "keyword": "Dental clinic",
  "businessName": "Abhijit MultiSpeciality Dental Hospital",
  "centerLat": 17.9689,
  "centerLng": 79.5941,
  "gridSize": 7,
  "gridSpacingMeters": 500,
  "maxRankToShow": 20,
  "language": "en",
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

---

## Output

Single dataset item with:

### Summary

```json
{
  "visibilityScore": 12.2,
  "visibilityScoreLabel": "12%",
  "totalPoints": 49,
  "visibleCount": 2,
  "weakCount": 4,
  "invisibleCount": 43,
  "avgRank": 5.8,
  "top3Count": 2,
  "quadrantAvg": { "NW": 14.2, "NE": 12.8, "SW": 15.1, "SE": 11.4 },
  "weakestQuadrant": "SW"
}
```

### Rank Tiers

| Category | Rank | Colour |
|---|---|---|
| VISIBLE | 1–3 | 🟢 Green |
| WEAK | 4–7 | 🟡 Yellow |
| INVISIBLE | 8+ | 🔴 Red |

### Grid Matrix (ready for heatmap rendering)

```json
[
  [{"row":0,"col":0,"rank":null,"category":"INVISIBLE","displayRank":"8+","isCenter":false}, ...],
  [...],
  [{"row":3,"col":3,"rank":null,"category":"INVISIBLE","displayRank":"YOU","isCenter":true}, ...]
]
```

### Grid Results (flat list)

One object per grid point:
```json
{
  "pointIndex": 24,
  "row": 3,
  "col": 3,
  "lat": 17.9689,
  "lng": 79.5941,
  "quadrant": "NW",
  "rank": null,
  "ranked": false,
  "category": "INVISIBLE",
  "displayRank": "8+",
  "isCenter": true
}
```

---

## Cost Estimate

| Grid Size | Points | Approx. Apify Cost |
|---|---|---|
| 3×3 | 9 | ~$0.01–0.03 |
| 5×5 | 25 | ~$0.03–0.08 |
| 7×7 | 49 | ~$0.05–0.15 |
| 9×9 | 81 | ~$0.10–0.25 |

Residential proxy costs are included in Apify proxy billing.

---

## Architecture

```
main.js            — Orchestration, summary, dataset output
generateGrid.js    — Grid point math (lat/lng offsets)
resolveTarget.js   — Auto-resolve businessName → Place ID
scrapeRank.js      — Google Maps scraping at each lat/lng
extractPlaceId.js  — Place ID regex extraction (3-tier fallback)
```

---

## Deployment

```bash
# Install dependencies
npm install

# Push to Apify
apify push
```

---

## Notes

- Residential proxies are **mandatory** — Google blocks datacenter IPs on Maps searches
- `gridSize=7, gridSpacingMeters=500` is the recommended standard configuration (matches GMB Master Pro default)
- If only `businessName` is provided (no `placeId`), the actor makes one extra search call to resolve the ID before the grid scan starts
- Results are saved as a single dataset item (full scan) — not one item per point
