/**
 * Best-effort: push a stream URL into IMVU Next room media / URL fields (layout-dependent).
 * @param {import('puppeteer').Page} page
 * @param {string} publicUrl
 * @returns {Promise<boolean>}
 */
export async function applyRoomMediaStreamUrl(page, publicUrl) {
    const url = String(publicUrl || '').trim();
    /* IMVU / room players need HTTPS; never push LAN http://localhost or private IPs. */
    if (!page || page.isClosed() || !url || !/^https:\/\//i.test(url)) return false;
    try {
        const ok = await page.evaluate((u) => {
            try {
                const tryApply = (el) => {
                    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement))
                        return false;
                    el.focus();
                    const proto =
                        el instanceof HTMLTextAreaElement
                            ? HTMLTextAreaElement.prototype
                            : HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc?.set) desc.set.call(el, u);
                    else el.value = u;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                };

                const selectors = [
                    'input[type="url"]',
                    'input[placeholder*="http" i]',
                    'input[name*="stream" i]',
                    'input[aria-label*="url" i]',
                    'textarea[placeholder*="http" i]',
                ];
                let hit = false;
                for (const sel of selectors) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (tryApply(el)) hit = true;
                    }
                }
                return hit;
            } catch {
                return false;
            }
        }, url);
        return Boolean(ok);
    } catch {
        return false;
    }
}
