/**
 * extractPlaceId.js
 *
 * Extracts ALL Google-native unique identifiers from a Google Maps URL or DOM card.
 * No name-based matching — only hard IDs.
 *
 * Google uses three ID formats for GMB listings:
 *
 *  1. ChIJ Place ID  — "ChIJN1t_tDeuEmsRUsoyG83frY4"
 *     Base64url-encoded, appears in /maps/place/ URLs and API responses.
 *
 *  2. Hex-pair       — "0x3a3345fb8f20d4b7:0xf5a5d85edfcb2c8e"
 *     Two hex values separated by colon. First = location hash, second = CID in hex.
 *     Most common format in /maps/search/ result card hrefs (the !1s data param).
 *
 *  3. CID            — "17559876543210" (numeric)
 *     The decimal form of the second hex value in a hex-pair.
 *     Also exposed as data-cid on result cards and in ?cid= query params.
 *
 * Cross-format bridge:
 *   hex-pair "0xAAAA:0xBBBB"  ↔  CID = parseInt("BBBB", 16)
 *   So any two formats that share the CID value refer to the same business.
 */

/**
 * @typedef {Object} GmbIds
 * @property {string|null} placeId   ChIJ... base64 Place ID
 * @property {string|null} hexId     0x...:0x... hex-pair
 * @property {string|null} cid       Numeric CID as string (for safe BigInt handling)
 */

/**
 * Extract all known GMB unique IDs from a URL string.
 * @param {string} url
 * @returns {GmbIds}
 */
export function extractAllIdsFromUrl(url) {
    if (!url) return { placeId: null, hexId: null, cid: null };

    let placeId = null;
    let hexId   = null;
    let cid     = null;

    // 1. Hex-pair in data blob  !1s(0x...:0x...)  — most common in search result hrefs
    const hexMatch = url.match(/!1s(0x[a-f0-9]+:0x[a-f0-9]+)/i);
    if (hexMatch) {
        hexId = hexMatch[1].toLowerCase();
        // Derive CID from the second part of the hex-pair
        const cidHex = hexId.split(':')[1]; // "0xf5a5d..."
        if (cidHex) {
            try { cid = BigInt(cidHex).toString(); } catch { /* malformed — skip */ }
        }
    }

    // 2. ChIJ Place ID — in /place/{name}/{PlaceId}  or raw in data blob
    const chijInPath = url.match(/maps\/place\/[^/]*\/(ChIJ[A-Za-z0-9_-]{10,})/);
    if (chijInPath) {
        placeId = chijInPath[1];
    } else {
        const chijRaw = url.match(/(ChIJ[A-Za-z0-9_-]{10,})/);
        if (chijRaw) placeId = chijRaw[1];
    }

    // 3. CID numeric in ?cid= or &cid= query param (overrides derived value if present)
    const cidParam = url.match(/[?&]cid=(\d+)/);
    if (cidParam) cid = cidParam[1];

    return { placeId, hexId, cid };
}

/**
 * Check if a set of target IDs matches a set of card IDs.
 * Returns true if any ID format overlaps between the two objects.
 *
 * Cross-format bridge: if target has CID, check it against the hex-pair's
 * second part from the card (and vice-versa).
 *
 * @param {GmbIds} target
 * @param {GmbIds} card
 * @returns {boolean}
 */
export function idsMatch(target, card) {
    // Same ChIJ Place ID
    if (target.placeId && card.placeId && target.placeId === card.placeId) return true;

    // Same hex-pair
    if (target.hexId && card.hexId && target.hexId === card.hexId) return true;

    // Same CID (numeric)
    if (target.cid && card.cid && target.cid === card.cid) return true;

    // Cross-format: target CID vs card hex-pair second part
    if (target.cid && card.hexId) {
        try {
            const cidFromHex = BigInt(card.hexId.split(':')[1]).toString();
            if (cidFromHex === target.cid) return true;
        } catch { /* malformed */ }
    }

    // Cross-format: card CID vs target hex-pair second part
    if (card.cid && target.hexId) {
        try {
            const cidFromHex = BigInt(target.hexId.split(':')[1]).toString();
            if (cidFromHex === card.cid) return true;
        } catch { /* malformed */ }
    }

    return false;
}

/**
 * Normalise any raw ID input from the user into a GmbIds object.
 * Accepts: ChIJ string, hex-pair string, numeric CID string, or full Maps URL.
 *
 * @param {object} raw
 * @param {string} [raw.googleMapsUrl]
 * @param {string} [raw.placeId]
 * @param {string} [raw.cid]
 * @param {string} [raw.hexId]
 * @returns {GmbIds}
 */
export function normaliseTargetIds({ googleMapsUrl, placeId, cid, hexId }) {
    // Start from URL if provided — extracts all formats at once
    const fromUrl = googleMapsUrl ? extractAllIdsFromUrl(googleMapsUrl) : {};

    // Normalize hexId to lowercase — card hrefs always produce lowercase hex,
    // so a user-supplied uppercase hexId would silently fail to match.
    const rawHexId = hexId || fromUrl.hexId || null;
    const result = {
        placeId: placeId || fromUrl.placeId || null,
        hexId:   rawHexId ? rawHexId.toLowerCase() : null,
        cid:     cid     || fromUrl.cid     || null,
    };

    // If only hexId given, derive CID from it
    if (result.hexId && !result.cid) {
        try {
            result.cid = BigInt(result.hexId.split(':')[1]).toString();
        } catch { /* malformed */ }
    }

    // If only placeId given (ChIJ), nothing more to derive — that's fine
    return result;
}
