const SCALER_HINT_RE =
    /\b(scaler|scalr|scale|height|tall|hip|thigh|body|mesh|size|rlxl|rll|slim\s*thick|avatar)\b/i;
const SCALER_PCT_RE = /(\d{2,3})\s*%/;

/**
 * @param {string} name
 * @returns {number | null}
 */
export function scalerPercentFromItemName(name) {
    const text = String(name || '').trim();
    if (!text) return null;
    const m = text.match(SCALER_PCT_RE);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n < 50 || n > 500) return null;
    if (SCALER_HINT_RE.test(text)) return n;
    // Short product titles that are mostly just "NNN%".
    if (/^\d{2,3}\s*%/.test(text) && text.length <= 24) return n;
    return null;
}

/**
 * @param {unknown} value
 * @param {Set<number>} out
 * @param {Set<object>} seen
 */
function collectScalerPercentsFromJson(value, out, seen = new Set()) {
    if (value == null) return;
    if (typeof value === 'number') return;
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) collectScalerPercentsFromJson(item, out, seen);
        return;
    }
    const o = /** @type {Record<string, unknown>} */ (value);
    for (const [key, raw] of Object.entries(o)) {
        if (typeof raw === 'number' && /scale|scaler|height/i.test(key)) {
            const pct = raw > 0 && raw <= 5 ? Math.round(raw * 100) : Math.round(raw);
            if (pct >= 50 && pct <= 500) out.add(pct);
        }
        collectScalerPercentsFromJson(raw, out, seen);
    }
}

/**
 * Walk API JSON for product/display names.
 * @param {unknown} value
 * @param {Set<string>} out
 * @param {Set<object>} seen
 */
function collectNameStrings(value, out, seen = new Set()) {
    if (value == null) return;
    if (typeof value === 'string') {
        const t = value.trim();
        if (t.length >= 3 && t.length <= 200) out.add(t);
        return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) collectNameStrings(item, out, seen);
        return;
    }
    const o = /** @type {Record<string, unknown>} */ (value);
    for (const key of ['name', 'product_name', 'display_name', 'title', 'label', 'description']) {
        if (typeof o[key] === 'string') out.add(String(o[key]).trim());
    }
    for (const child of Object.values(o)) collectNameStrings(child, out, seen);
}

/** @param {{ apiGetWearableNames?: (userId: string) => Promise<string[]> } | null} sessionClient */
export async function fetchWearableNameHints(sessionClient, userId) {
    const names = new Set();
    if (!sessionClient?.apiGetWearableNames) return [];
    try {
        const list = await sessionClient.apiGetWearableNames(userId);
        for (const n of list) names.add(n);
    } catch {
        /* optional */
    }
    return [...names];
}

/**
 * @param {string[]} names
 * @param {number} maxScaler
 * @param {number[]} [extraPercents]
 */
export function findOverScaler(names, maxScaler, extraPercents = []) {
    const limit = Number(maxScaler) || 120;
    let best = null;
    for (const name of names) {
        const pct = scalerPercentFromItemName(name);
        if (pct != null && pct > limit && (best == null || pct > best.pct)) {
            best = { name, pct };
        }
    }
    for (const pct of extraPercents) {
        if (pct > limit && (best == null || pct > best.pct)) {
            best = { name: 'avatar scale', pct };
        }
    }
    return best;
}

/**
 * @param {{ apiGetWearableScan?: (userId: string) => Promise<{ names: string[], scalePercents: number[] }> } | null} sessionClient
 * @param {string} userId
 */
export async function fetchScalerScan(sessionClient, userId) {
    if (typeof sessionClient?.apiGetWearableScan === 'function') {
        try {
            return await sessionClient.apiGetWearableScan(userId);
        } catch {
            /* fall through */
        }
    }
    const names = await fetchWearableNameHints(sessionClient, userId);
    return { names, scalePercents: [] };
}

export { collectNameStrings, collectScalerPercentsFromJson };
