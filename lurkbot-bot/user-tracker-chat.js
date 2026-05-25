import axios from 'axios';
import { bulkPost } from './api-queue.js';

export const createConversationLogger = ({ apiBaseUrl, roomId }) => async (payload) => {
    try {
        bulkPost('/api/conversations/append', {
            room_id: String(roomId),
            ...payload,
        });
    } catch (e) {
        console.log('[CHAT-LOGGER] Log failed:', e.message);
    }
};

export const createSendMessage = ({ page, protocolClient, logConversationTurn }) => async (text, convMeta = null) => {
    if (protocolClient) {
        try {
            await protocolClient.sendMessage(text, convMeta || {});
            const preview = text.length > 100 ? `${text.slice(0, 100)}…` : text;
            console.log(`[CHAT][BOT] sent via websocket: ${preview}`);
            if (convMeta?.participantUsername) {
                void logConversationTurn({
                    username: convMeta.participantUsername,
                    imvu_avatar_id: convMeta.participantAvatarId ?? null,
                    role: 'assistant',
                    content: text,
                });
            }
        } catch (e) {
            console.log('[CHAT][BOT] websocket send error:', e?.message || e);
        }
        return;
    }

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
                document.querySelector('textarea.input-text'),
                document.querySelector('.input-text'),
                document.querySelector('[class*="chat-input"] textarea'),
                document.querySelector('[contenteditable="true"]'),
                ...document.querySelectorAll('textarea:not([readonly])')
            ].filter(Boolean);
            const visible = (el) => {
                const r = el.getBoundingClientRect?.();
                return r && r.width > 0 && r.height > 0;
            };
            for (const el of candidates) {
                if (!el || el.disabled) continue;
                if (!visible(el) && candidates.some((c) => c !== el && visible(c))) continue;
                try {
                    el.click();
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
