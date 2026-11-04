/* v0.4.17 (issue #18 item 4) · full-screen click zones for the player picture.
 * v0.4.18 (issue #19 item 1) · the zones are a GHOST layer again: they must not eat pointer events.
 *
 * The issue asks for the picture itself to answer to clicks: the middle third toggles play/pause,
 * the left third is 上一首 and the right third 下一首. This component is that invisible hot layer.
 *
 * ## Why it is a ghost layer (issue #19)
 *
 * 0.4.17 made this a `pointer-events: auto` strip across the whole window. It therefore became the
 * hit target for EVERY press over the picture, and the canvas underneath stopped receiving
 * `pointerdown` altogether. 「町景」 hangs a three.js `OrbitControls` on its canvas
 * (`work/…/machi/engine/camera.ts` → `MachiCamera.attach()`), and OrbitControls starts its whole
 * gesture machine from the canvas's `pointerdown`; with the strip on top, drag-to-rotate / wheel
 * zoom / right-drag pan were dead. The same strip also ate monet's lyric-rail wheel and its
 * hanging-rope drag.
 *
 * The fix is that the layer paints nothing and hit-tests nothing (`pointer-events: none`, see
 * `app.css` `.spw-click-zones`), while the *decision* moved up to `window` in the **capture**
 * phase. Capture phase runs from `window` down to the target, so it sees the press before the
 * canvas does and the canvas still gets its own copy afterwards — both sides win.
 *
 * That also survives OrbitControls' `setPointerCapture(event.pointerId)` on the canvas: pointer
 * capture only *retargets* later pointer events at the capturing element, it does not shorten
 * their propagation path, so `window` capture still receives every `pointermove` / `pointerup` of
 * the gesture (OrbitControls itself listens for those on `ownerDocument`, i.e. strictly later in
 * the same path).
 *
 * ## The rules that keep it from stealing clicks that belong to real controls
 *
 *  1. **A press that starts on a control is not a picture click.** `pointerdown` looks at its
 *     target: anything inside [OWNED_CLICK_SELECTOR] (buttons, links, form fields, ARIA control
 *     roles, this island's own chrome/panels/overlay/playback HUD, Folia's camera bar) owns its
 *     click, and the gesture is abandoned. No z-index race is involved any more — there is no
 *     layer to race with.
 *  2. **It is inert when clicks must reach the desktop or another window layer.** With 鼠标穿透 on
 *     the host forwards clicks to whatever is under the window, so the zones stand down then as
 *     well — exactly like `PlaybackBar`, which unmounts in that mode. The settings overlay, the
 *     bottom-right menu, the diagnostics panel and the font picker do the same through the single
 *     `enabled` prop (App.tsx `clickZonesEnabled`).
 *  3. **A drag is not a click.** The press point is remembered on `pointerdown`; `pointermove` and
 *     `pointerup` are measured against it. More than [DRAG_SLOP_PX] of travel, a cancelled gesture,
 *     or an Alt press (the host's Alt+drag window move) sends nothing. So the exact gesture the
 *     issue wants back — press, drag, release — is silent here *and* goes to OrbitControls.
 *
 * It has no cursor style on purpose: the picture is a full-screen surface, a hand cursor everywhere
 * would be noise over the artwork (the issue says so explicitly).
 *
 * ## DOM contract (shared with the acceptance gate — do not rename)
 *
 *   container  `[data-spw-click-zone]` with `data-enabled="true|false"`, `display: flex`
 *   children   `[data-zone="prev"]` / `[data-zone="toggle"]` / `[data-zone="next"]`, in that
 *              order, one third of the width each
 *
 * The children stay in the DOM and stay laid out even though they are never a hit-test target; the
 * gate reads them to check the contract, and the document names them. They are also still the
 * synthetic-input surface: a `pointerdown` dispatched on a child is honoured as *that* zone (its
 * own `data-zone` wins over the coordinates) and `el.click()` still acts once, so both the old
 * probe (`dispatchEvent(pointerdown)` + `window` `pointerup`) and a plain `.click()` keep working.
 *
 * Capturing on `window` means the listener also sees presses dispatched on the children: a
 * programmatically dispatched event runs the capture phase on every ancestor regardless of its
 * `bubbles` flag, so no React `onPointerDown` is needed (and deliberately absent — two handlers
 * would record the same press twice).
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { sendPlaybackControl } from '~/bridge';

/** Movement (CSS px) above which a pointer sequence counts as a drag, not a click. */
const DRAG_SLOP_PX = 10;
/** A real gesture already acted on pointerup; the browser's trailing `click` must not act again. */
const CLICK_AFTER_GESTURE_MS = 800;

/** One third of the picture each; ordered left → right. */
const ZONES = ['prev', 'toggle', 'next'] as const;
type ClickZone = (typeof ZONES)[number];

/**
 * Anything that answers a click on its own. A gesture that starts inside one of these is not a
 * picture click: the control's own handler already sent (or will send) whatever it sends, and a
 * second `control` message from here would double-act. Listed by tag, by ARIA role (Folia's
 * player-page panels are `role="region"` cards rather than buttons) and by this island's own
 * class/attribute names (`data-spw-chrome` covers the gear, the bottom-right menu and both
 * panels; `.spw-playback` the transport HUD; `.spw-queue-panel` the queue card).
 */
const OWNED_CLICK_SELECTOR = [
    'a',
    'button',
    'input',
    'label',
    'select',
    'summary',
    'textarea',
    'audio',
    'video',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="button"]',
    '[role="checkbox"]',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="menubar"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="radio"]',
    '[role="region"]',
    '[role="slider"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="tablist"]',
    '[role="textbox"]',
    '[role="toolbar"]',
    '[data-spw-chrome]',
    '[data-spw-settings-overlay]',
    '[data-spw-font-picker]',
    '.spw-chrome-btn',
    '.spw-playback',
    '.spw-player-bg',
    '.spw-queue-panel',
].join(',');

interface PlaybackClickZonesProps {
    /** False while the settings overlay is open or the host is in mouse passthrough. */
    enabled: boolean;
}

interface Gesture {
    pointerId: number;
    zone: ClickZone;
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

/**
 * Cursors that mean "this thing wants the pointer". Upstream styles expose affordances that carry
 * no tag, no role and no attribute of their own — 「monet」's portrait hanger (挂绳: a plain
 * `div.cursor-pointer` that starts a framer-motion drag) and its seekable rail lines are exactly
 * that. The issue names the hanger drag as broken by the old layer, so a press that starts on
 * something advertising one of these must not be turned into a picture click as well.
 */
const INTERACTIVE_CURSOR = /^(pointer|grab|grabbing|move|ew-resize|ns-resize|nesw-resize|nwse-resize|col-resize|row-resize|cell|alias|copy|zoom-in|zoom-out)$/;

/**
 * Does this press belong to something other than the picture?
 *
 * Cheap and best-effort: the selector first (covers every real control), then the cursor affordance
 * up the ancestor chain (covers upstream's role-less divs). Only read on `pointerdown`, once per
 * gesture, so the computed-style walk costs nothing measurable.
 */
const pressBelongsToControl = (target: Element | null): boolean => {
    if (!target) return false;
    if (target.closest(OWNED_CLICK_SELECTOR)) return true;
    const root = document.documentElement;
    for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
        const { cursor } = getComputedStyle(element);
        if (cursor && INTERACTIVE_CURSOR.test(cursor)) return true;
    }
    return false;
};

const PlaybackClickZones: React.FC<PlaybackClickZonesProps> = ({ enabled }) => {
    const containerRef = useRef<HTMLDivElement>(null);
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

    /** Which third of the layer a horizontal position falls in. Measured against the layer's own
     *  box so it cannot drift from what the three children cover. */
    const zoneAt = useCallback((clientX: number): ClickZone => {
        const rect = containerRef.current?.getBoundingClientRect();
        const left = rect ? rect.left : 0;
        const width = rect && rect.width > 0 ? rect.width : window.innerWidth || 1;
        const index = Math.floor(((clientX - left) / width) * ZONES.length);
        return ZONES[Math.min(ZONES.length - 1, Math.max(0, index))];
    }, []);

    /* One capture-phase listener set on `window`, so it runs on the way down — before the canvas
     * (and therefore before OrbitControls) sees the press — while the picture underneath still
     * receives its own copy. */
    useEffect(() => {
        const onPointerDown = (event: PointerEvent) => {
            gesture.current = null;
            if (!enabled) return;
            // Alt+left is the host's window-move gesture (Shim.js intercepts the same combination);
            // secondary buttons belong to OrbitControls' pan.
            if (event.button !== 0 || event.altKey) return;
            const target = event.target instanceof Element ? event.target : null;
            // Synthetic input dispatched straight at a zone child: its own zone wins, whatever
            // coordinates the caller made up.
            const zoneElement = target?.closest<HTMLElement>('.spw-click-zone[data-zone]') ?? null;
            const fromElement = zoneElement?.dataset.zone;
            if (isZone(fromElement)) {
                gesture.current = {
                    pointerId: event.pointerId,
                    zone: fromElement,
                    x: event.clientX,
                    y: event.clientY,
                    dragged: false,
                };
                return;
            }
            if (target && pressBelongsToControl(target)) return;
            gesture.current = {
                pointerId: event.pointerId,
                zone: zoneAt(event.clientX),
                x: event.clientX,
                y: event.clientY,
                dragged: false,
            };
        };
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
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
        window.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
        window.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true });
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('pointerup', onPointerUp, true);
            window.removeEventListener('pointercancel', onPointerCancel, true);
        };
    }, [act, enabled, finish, zoneAt]);

    // The layer going inert mid-gesture (overlay opened, passthrough turned on) drops the gesture
    // instead of firing it later against a page the user is no longer looking at.
    useEffect(() => {
        if (!enabled) gesture.current = null;
    }, [enabled]);

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
        <div ref={containerRef} className="spw-click-zones" data-spw-click-zone data-enabled={enabled ? 'true' : 'false'}>
            {ZONES.map(zone => (
                <div
                    key={zone}
                    className="spw-click-zone"
                    data-zone={zone}
                    aria-hidden="true"
                    onClick={handleClick}
                />
            ))}
        </div>
    );
};

export default PlaybackClickZones;
