import axios from 'axios';

export const createConversationLogger = ({ apiBaseUrl, roomId }) => async (payload) => {
    try {
        await axios.post(`${apiBaseUrl}/api/conversations/append`, {
            room_id: String(roomId),
            ...payload,
        });
    } catch {}
};

export const createSendMessage = ({ page, logConversationTurn }) => async (text, convMeta = null) => {
    const sendInFrame = (frame) =>
        frame.evaluate((msg) => {
            const setNativeValue = (el, value) => {
                if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
                    const proto =
                        el instanceof HTMLTextAreaElement
                            ? HTMLTextAreaElement.prototype
                            : HTMLInputElement.prototype;
                    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (desc?.set) {
                        desc.set.call(el, value);
                        return;
                    }
                }
                if (el.isContentEditable) el.textContent = value;
                else el.value = value;
            };
            const trySubmit = (el) => {
                el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: msg }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                const form = el.closest && el.closest('form');
                if (form && typeof form.requestSubmit === 'function') {
                    try {
                        form.requestSubmit();
                    } catch {}
                }
                const btn =
                    (form && form.querySelector('button[type="submit"], [type="submit"], button.primary')) ||
                    document.querySelector('button[type="submit"]');
                if (btn) btn.click();
                el.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true,
                    })
                );
            };
            const candidates = [
                ...document.querySelectorAll('textarea:not([readonly])'),
                ...document.querySelectorAll('input[type="text"]:not([readonly])'),
                ...document.querySelectorAll('[contenteditable="true"]'),
                document.querySelector('input[type="text"]'),
            ].filter(Boolean);
            const visible = (el) => {
                const r = el.getBoundingClientRect?.();
                return r && r.width > 0 && r.height > 0;
            };
            for (const el of candidates) {
                if (!el || el.disabled) continue;
                if (!visible(el) && candidates.some((c) => c !== el && visible(c))) continue;
                try {
                    el.focus();
                    setNativeValue(el, msg);
                    trySubmit(el);
                    return true;
                } catch {}
            }
            return false;
        }, text);

    try {
        const frames = page.frames();
        let ok = false;
        for (const frame of frames) {
            try {
                if (ok) break;
                ok = await sendInFrame(frame);
            } catch {}
        }
        if (ok) {
            const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
            console.log(`[CHAT][BOT] sent: ${preview}`);
            if (convMeta?.participantUsername) {
                void logConversationTurn({
                    username: convMeta.participantUsername,
                    imvu_avatar_id: convMeta.participantAvatarId ?? null,
                    role: 'assistant',
                    content: text,
                });
            }
        } else {
            console.log('[CHAT][BOT] send failed: no chat input in any frame (check IMVU UI / shadow DOM)');
        }
    } catch (e) {
        console.log('[CHAT][BOT] send error:', e?.message || e);
    }
};
