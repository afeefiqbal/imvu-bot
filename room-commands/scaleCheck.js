const SCALER_NAME_RE = /scaler|scale\s*height|height\s*scaler|avatar\s*height/i;
const SCALER_PCT_RE = /(\d{2,3})\s*%/;

/**
 * @param {string} name
 * @returns {number | null}
 */
export function scalerPercentFromItemName(name) {
    const text = String(name || '');
    if (!SCALER_NAME_RE.test(text)) return null;
    const m = text.match(SCALER_PCT_RE);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
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
    for (const key of ['name', 'product_name', 'display_name', 'title', 'label']) {
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
 */
export function findOverScaler(names, maxScaler) {
    const limit = Number(maxScaler) || 120;
    for (const name of names) {
        const pct = scalerPercentFromItemName(name);
        if (pct != null && pct > limit) return { name, pct };
    }
    return null;
}

export { collectNameStrings };
