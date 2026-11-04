/* v0.4.17 (issue #18 item 4) · full-screen click zones for the player picture.
 *
 * The issue asks for the picture itself to answer to clicks: the middle third toggles play/pause,
 * the left third is 上一首 and the right third 下一首. This component is that invisible hot layer.
 *
 * Three rules keep it from stealing clicks that belong to real controls:
 *
 *  1. **It sits under every control.** `.spw-click-zones` paints at z-index 2147482990 — below the
 *     playback HUD (2147483000) and below the chrome buttons/panels (2147483001+), all inside the same
 *     stacking context (the injected island's fixed container). The transport bar, the bottom-right
 *     menus and the top-right gear therefore win every click they cover and this layer never sees
 *     them. The settings overlay disables the whole layer while it is open (`data-enabled="false"` →
 *     `pointer-events: none`), so the overlay keeps every click it owns.
 *  2. **It is inert when clicks must reach the desktop.** With 鼠标穿透 on the host forwards clicks to
 *     whatever is under the window, so the zone layer is disabled then as well — exactly like
 *     `PlaybackBar`, which unmounts in that mode.
 *  3. **A drag is not a click.** The press point is remembered on pointerdown; move/up/cancel are
 *     listened for on `window`, so a gesture that leaves its zone (or the window) is still measured.
 *     More than [DRAG_SLOP_PX] of travel, a cancelled gesture, or an Alt press (the host's Alt+drag
 *     window move) sends nothing.
 *
 * It has no cursor style on purpose: the picture is a full-screen surface, a hand cursor everywhere
 * would be noise over the artwork (the issue says so explicitly).
 *
 * DOM contract shared with the acceptance gate — do not rename:
 *   container  `[data-spw-click-zone]` with `data-enabled="true|false"`
 *   children   `[data-zone="prev"]` / `[data-zone="toggle"]` / `[data-zone="next"]`
 *
 * Input arrives through pointer events with a `click` fallback, so both a real mouse press and a
 * synthetic `.click()` (what the acceptance scripts dispatch) act exactly once per gesture.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { sendPlaybackControl } from '~/bridge';

/** Movement (CSS px) above which a pointer sequence counts as a drag, not a click. */
const DRAG_SLOP_PX = 10;
/** A real gesture already acted on pointerup; the browser's trailing `click` must not act again. */
const CLICK_AFTER_GESTURE_MS = 800;

type ClickZone = 'prev' | 'toggle' | 'next';

const ZONES: ClickZone[] = ['prev', 'toggle', 'next'];

interface PlaybackClickZonesProps {
    /** False while the settings overlay is open or the host is in mouse passthrough. */
    enabled: boolean;
}

interface Gesture {
    pointerId: number;
    zone: ClickZone | null;
    x: number;
    y: number;
    dragged: boolean;
}

const ACTIONS: Record<ClickZone, () => void> = {
    prev: () => sendPlaybackControl('previous'),
    toggle: () => sendPlaybackControl('toggle'),
    next: () => sendPlaybackControl('next'),
};

const isZone = (value: string | undefined): value is ClickZone => value === 'prev' || value === 'toggle' || value === 'next';

const PlaybackClickZones: React.FC<PlaybackClickZonesProps> = ({ enabled }) => {
    const gesture = useRef<Gesture | null>(null);
    /** When the last pointer gesture finished and whether it was a drag: the trailing `click` reads
     *  this instead of guessing. `null` = no gesture seen (a purely synthetic click). */
    const lastGestureEnd = useRef<{ at: number; dragged: boolean } | null>(null);

    const act = useCallback((zone: ClickZone | null) => {
        if (zone) ACTIONS[zone]();
    }, []);

    const finish = useCallback((dragged: boolean) => {
        gesture.current = null;
        lastGestureEnd.current = { at: Date.now(), dragged };
    }, []);

    /* Move/up/cancel live on `window`: a press that slides out of its zone (or off the window) must
     * still be recognised as a drag, otherwise releasing elsewhere would fire. */
    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            const current = gesture.current;
            if (!current || current.pointerId !== event.pointerId || current.dragged) return;
            if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > DRAG_SLOP_PX) {
                current.dragged = true;
            }
        };
        const onPointerUp = (event: PointerEvent) => {
            const current = gesture.current;
            if (!current || current.pointerId !== event.pointerId) return;
            const { dragged, zone } = current;
            finish(dragged);
            if (!dragged && enabled) act(zone);
        };
        const onPointerCancel = (event: PointerEvent) => {
            const current = gesture.current;
            if (!current || current.pointerId !== event.pointerId) return;
            finish(true);
        };
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerUp, { passive: true });
        window.addEventListener('pointercancel', onPointerCancel, { passive: true });
        return () => {
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerCancel);
        };
    }, [act, enabled, finish]);

    // The layer going inert mid-gesture (overlay opened, passthrough turned on) drops the gesture
    // instead of firing it later against a page the user is no longer looking at.
    useEffect(() => {
        if (!enabled) gesture.current = null;
    }, [enabled]);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // Alt+left is the host's window-move gesture (Shim.js intercepts the same combination).
        if (event.button !== 0 || event.altKey) return;
        gesture.current = {
            pointerId: event.pointerId,
            zone: isZone(event.currentTarget.dataset.zone) ? event.currentTarget.dataset.zone : null,
            x: event.clientX,
            y: event.clientY,
            dragged: false,
        };
    }, []);

    /** Synthetic activation (`.click()`, keyboard): a real gesture already acted on pointerup. */
    const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (!enabled || event.altKey) return;
        const recent = lastGestureEnd.current;
        // Either this gesture already ran on pointerup, or it was a drag. Neither may act here.
        if (recent && Date.now() - recent.at < CLICK_AFTER_GESTURE_MS) return;
        const value = event.currentTarget.dataset.zone;
        act(isZone(value) ? value : null);
    }, [act, enabled]);

    return (
        <div className="spw-click-zones" data-spw-click-zone data-enabled={enabled ? 'true' : 'false'}>
            {ZONES.map(zone => (
                <div
                    key={zone}
                    className="spw-click-zone"
                    data-zone={zone}
                    aria-hidden="true"
                    onPointerDown={handlePointerDown}
                    onClick={handleClick}
                />
            ))}
        </div>
    );
};

export default PlaybackClickZones;
