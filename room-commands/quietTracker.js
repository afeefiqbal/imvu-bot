/** @typedef {{ avatarId: string, label: string, quietMinutes: number }} QuietEntry */

/**
 * @param {Map<string, string>} lastUserMap avatarId -> label
 * @param {Map<string, number>} lastSpokeAt avatarId -> timestamp ms
 * @param {number} thresholdMinutes
 * @returns {QuietEntry[]}
 */
export function listQuietUsers(lastUserMap, lastSpokeAt, thresholdMinutes) {
    const thresholdMs = Math.max(1, thresholdMinutes) * 60 * 1000;
    const now = Date.now();
    const out = [];

    for (const [avatarId, label] of lastUserMap) {
        const last = lastSpokeAt.get(String(avatarId));
        if (last == null) continue;
        const quietMs = now - last;
        if (quietMs < thresholdMs) continue;
        out.push({
            avatarId: String(avatarId),
            label: String(label || avatarId),
            quietMinutes: Math.floor(quietMs / 60000),
        });
    }

    out.sort((a, b) => b.quietMinutes - a.quietMinutes);
    return out;
}
