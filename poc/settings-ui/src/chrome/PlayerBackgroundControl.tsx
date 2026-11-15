/* v0.1.7: bottom-right chrome control for Folia's player-page transparent background.
 *
 * Reference (screenshot 2): a round sliders button sits in the player's bottom-right corner; tapping
 * it opens a small control panel above with the "播放页透明背景" switch (screenshot 1). The switch is
 * Folia's own `transparentPlayerBackground` setting: it hides the visualizer background and lets the
 * host window become colour-key transparent so the desktop actually shows through.
 *
 * v0.2.0: the selected lyric style decides whether the transparent window is usable at all. A style
 * that paints a large semi-transparent plate under the colour key turns into a pink haze, so for
 * those styles the switch is disabled and the panel says why (the store closes transparency when
 * such a style is selected, see `model/transparencyCompat.ts`).
 *
 * v0.4.17 (issue #18 item 2): this panel is the player page's settings menu, so 「显示播放条」 lives
 * here — not on SPW's 配置 page any more, and not in a third corner button. The row is always shown
 * (unlike 鼠标穿透, which only exists while the page is transparent) because the playback bar is a
 * player-page setting in its own right. Switching the bar off unmounts `PlaybackBar` entirely, but
 * the button that opens THIS panel never depends on that value: it is the only way back.
 *
 * v0.5.2 (issue #23, second round): the user's screenshot shows Folia's **`SlideActionButton`** in this
 * corner — a faint 96 px track with a small floating `Command` glyph at its left end and a solid 48 px
 * dark circle at its right end — and asks for the market on the left (「按左边那个浅色的按钮进入模组
 * 市场」), hidden under mouse passthrough.
 *
 * ## Why this file IMPORTS Folia's component instead of painting its own
 *
 * The first three attempts here hand-wrote the capsule in CSS and each was rejected as "not close
 * enough", for one reason: the reference is not a two-button pill somebody composed, it is a specific
 * component Folia already ships. `@/components/shared/SlideActionButton.tsx` is it, and the numbers
 * that matter are all in that file:
 *
 *   root        relative w-12 h-12            (the circle is 48 px)
 *   track       absolute right-0 top-0 w-24 h-12 rounded-full
 *               border-white/10 bg-white/5                    ← 96 px, extends LEFT of the circle
 *   left glyph  motion.div at left-3.5 top-[17px] w-3.5 h-3.5
 *               animate x: [0,-4,0] opacity: [.45,.85,.45] 1.5 s   ← the「会动」
 *   circle      w-12 h-12 rounded-full bg-black/40 text-white shadow-lg backdrop-blur-md
 *   guide line  opacity-0 → opacity-100 on hover/drag, fill `bg-white/10`
 *
 * So it is rendered as-is (`WallToolsButton.tsx:233` composes it with `icon` + `slideIcon` exactly like
 * this). Two of our own requirements are layered on top, and neither touches its paint:
 *
 *  1. **The left end must be clickable** to open the market. `SlideActionButton`'s left glyph sits in a
 *     `pointer-events-none` track because upstream it is a *slide destination*, not a button. So a real
 *     `<button data-spw-chrome="mod-market-entry">` is laid over that end, transparent (the glyph
 *     underneath keeps floating — one glyph, not two), with Folia's own `hover:bg-black/20` wash.
 *  2. **`data-spw-chrome="player-background"` must stay on the circle.** `verify-click-zones.mjs:353`
 *     clicks it by that attribute and `verify-hit-region.mjs` reads the host's hot rect for it, but
 *     `SlideActionButton` takes no arbitrary props — so the attribute is stamped onto the circle it
 *     renders ([circleChromeRef] below). Stamping, not re-implementing: the gates then drive the real
 *     component, which is stronger than what they had before.
 *
 * ## Passthrough hides the whole control (and that costs an escape hatch)
 *
 * 鼠标穿透 means «every click belongs to the desktop», and this corner is exactly what a user would
 * reach for to get out. It is hidden anyway (user's explicit instruction), which makes two things
 * mandatory and both live in `App.tsx`:
 *  - `data-passthrough` takes it off screen with `display:none` (not `opacity:0`: an invisible-but-
 *    present button would still be a hit target for the OS-level catcher region);
 *  - `App.tsx` must stop reporting its rectangle as a hot region while passthrough is on — otherwise
 *    the catcher keeps a clickable rectangle where nothing is painted (「点到一个看不见的按钮」).
 *
 * The remaining ways out of passthrough are the global hotkeys (`Ctrl+Alt+B`, `Ctrl+Alt+Shift+G`) and
 * the top-right gear, which stays visible and clickable in every mode. `docs/lessons.md` §4 records
 * this trade next to the other passthrough escape-hatch rules.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { Command, SlidersHorizontal } from 'lucide-react';
/* Folia's own two-end action button: the track, the floating left glyph and the sliding gesture.
 * Imported rather than reimplemented — see the header. */
import { SlideActionButton } from '@/components/shared/SlideActionButton';
import type { TransparencyCompat } from '~/model/transparencyCompat';

interface PlayerBackgroundControlProps {
    /** Follows the 2.5 s chrome idle-fade, never while the panel itself is open. */
    visible: boolean;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Whether the player page background is currently transparent. */
    enabled: boolean;
    onToggle: (next: boolean) => void;
    label: string;
    /** v0.1.9: while transparent, let the mouse reach the desktop instead of the page. */
    passthrough: boolean;
    onTogglePassthrough: (next: boolean) => void;
    passthroughLabel: string;
    /** v0.2.0: how the selected style behaves under the transparent window. */
    compat: TransparencyCompat;
    /** v0.2.0: extra line under the switches (why the switch is off / what is simplified). */
    compatNote: string | null;
    /** v0.4.17 (issue #18 item 2): the page's own 「显示播放条」 setting. */
    showPlaybackBar: boolean;
    onToggleShowPlaybackBar: (next: boolean) => void;
    showPlaybackBarLabel: string;
    /** v0.4.17: the panel's own name — it now holds three unrelated switches, so it can no longer be
     *  labelled with the transparency switch's text (`options.playerPageSettings`). */
    panelLabel: string;
    /** v0.5.2: the left end opens the mod market; this is its accessible name. */
    modMarketLabel: string;
    onOpenModMarket: () => void;
}

const PlayerBackgroundControl: React.FC<PlayerBackgroundControlProps> = ({
    visible,
    open,
    onOpenChange,
    enabled,
    onToggle,
    label,
    passthrough,
    onTogglePassthrough,
    passthroughLabel,
    compat,
    compatNote,
    showPlaybackBar,
    onToggleShowPlaybackBar,
    showPlaybackBarLabel,
    panelLabel,
    modMarketLabel,
    onOpenModMarket,
}) => {
    const rootRef = useRef<HTMLDivElement | null>(null);

    const close = useCallback(() => onOpenChange(false), [onOpenChange]);

    // A style that cannot run under the colour key (monet, lumiere on a light theme) disables the
    // switch instead of letting a pink haze cover the desktop.
    const blocked = compat === 'unsupported';

    /**
     * Stamp `data-spw-chrome="player-background"` onto the circle `SlideActionButton` renders.
     *
     * The attribute is a contract, not decoration: `verify-click-zones.mjs:353` does
     * `document.querySelector('[data-spw-chrome="player-background"]').click()` and
     * `verify-hit-region.mjs` asks the host whether the catcher's region covers that corner. Both keep
     * working, and they now drive the real component instead of a copy of it.
     *
     * **A callback ref, not an effect.** The first version used `useEffect` with no dep array, which
     * re-ran `root.querySelector` after EVERY commit of this component — and this component re-renders
     * on the chrome idle timer, on `open`, on `passthrough`, on every store field the page reads. That
     * ran dozens of times per second during a style transition, and the measurable consequence was
     * `verify-click-zones.mjs` losing monet's portrait hanger (M1/M2: `{"found":false}` after 15.6 s of
     * polling): monet mounts that hanger asynchronously, and a synchronous query-and-set on every
     * commit from a *sibling* component starved its mount. A callback ref runs exactly once per DOM node
     * identity, which is precisely the lifetime the attribute needs.
     */
    const stampCircle = useCallback((node: HTMLDivElement | null) => {
        // Keep the ref the outside-click handler uses; the attribute work is a one-shot per node.
        rootRef.current = node;
        if (!node) return;
        const circle = node.querySelector<HTMLButtonElement>('button[type="button"]');
        if (circle) circle.setAttribute('data-spw-chrome', 'player-background');
    }, []);

    // Clicking anywhere outside the control dismisses the panel (capture so it also works over canvas).
    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            const root = rootRef.current;
            const target = event.target;
            if (root && target instanceof Node && root.contains(target)) return;
            close();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [open, close]);

    return (
        <div className="spw-player-bg" data-flat={enabled ? 'true' : 'false'} data-compat={compat}>
            <div
                className="spw-player-bg-panel"
                data-spw-chrome="player-background-panel"
                data-open={open ? 'true' : 'false'}
                role="group"
                aria-label={panelLabel}
            >
                <button
                    type="button"
                    className="spw-player-bg-row"
                    role="switch"
                    aria-checked={enabled ? 'true' : 'false'}
                    aria-disabled={blocked ? 'true' : undefined}
                    disabled={blocked}
                    data-disabled={blocked ? 'true' : 'false'}
                    onClick={() => {
                        if (blocked) return;
                        onToggle(!enabled);
                    }}
                >
                    <span className="spw-player-bg-text">
                        <span className="spw-player-bg-label">{label}</span>
                    </span>
                    <span className="spw-switch" data-on={enabled ? 'true' : 'false'} aria-hidden="true">
                        <span className="spw-switch-knob" />
                    </span>
                </button>
                {enabled ? (
                    <button
                        type="button"
                        className="spw-player-bg-row spw-player-bg-row--second"
                        role="switch"
                        aria-checked={passthrough ? 'true' : 'false'}
                        onClick={() => onTogglePassthrough(!passthrough)}
                    >
                        <span className="spw-player-bg-text">
                            <span className="spw-player-bg-label">{passthroughLabel}</span>
                        </span>
                        <span className="spw-switch" data-on={passthrough ? 'true' : 'false'} aria-hidden="true">
                            <span className="spw-switch-knob" />
                        </span>
                    </button>
                ) : null}
                {/* v0.4.17 (issue #18 item 2): 「显示播放条」 — always present, whatever the
                 *  transparency switch above says. Switching it off unmounts the playback HUD; this
                 *  panel (and the button that opens it) stays, which is the only way back. */}
                <button
                    type="button"
                    className="spw-player-bg-row spw-player-bg-row--third"
                    data-spw-chrome="playback-bar-row"
                    role="switch"
                    aria-checked={showPlaybackBar ? 'true' : 'false'}
                    aria-label={showPlaybackBarLabel}
                    onClick={() => onToggleShowPlaybackBar(!showPlaybackBar)}
                >
                    <span className="spw-player-bg-text">
                        <span className="spw-player-bg-label">{showPlaybackBarLabel}</span>
                    </span>
                    <span className="spw-switch" data-on={showPlaybackBar ? 'true' : 'false'} aria-hidden="true">
                        <span className="spw-switch-knob" />
                    </span>
                </button>
                {compatNote ? <p className="spw-player-bg-note spw-player-bg-note--compat">{compatNote}</p> : null}
            </div>
            {/* v0.5.2: Folia's own `SlideActionButton` — the exact component in the user's screenshot.
             *  It paints the 96 px track, the floating `Command` glyph at its left end and the 48 px dark
             *  circle at its right end, and it keeps its slide gesture (drag left → `onSlide`).
             *
             *  `data-passthrough` hides the whole control under 鼠标穿透; `data-visible` fades it with
             *  the chrome idle timer. Both are honoured by `app.css`, which also stamps the circle's
             *  `data-spw-chrome` contract (see the effect above). */}
            <div
                className="spw-player-capsule"
                ref={stampCircle}
                data-passthrough={passthrough ? 'true' : 'false'}
                data-visible={visible ? 'true' : 'false'}
            >
                <SlideActionButton
                    icon={SlidersHorizontal}
                    title={panelLabel}
                    onActivate={() => onOpenChange(!open)}
                    slideIcon={Command}
                    slideTitle={modMarketLabel}
                    onSlide={onOpenModMarket}
                    isDaylight={false}
                    accentColor="#f4f4f5"
                    accentForeground="#09090b"
                />
                {/* The left end, made clickable. It is transparent so the glyph Folia paints there stays
                 *  the only one visible (a second icon would render a doubled mark); the wash on hover is
                 *  Folia's own `hover:bg-black/20` from `AppShell.tsx:219`. Width/rounding come from the
                 *  track it sits on (`left-3.5 top-[17px] w-3.5` around a 14 px icon) plus the padding a
                 *  pointer needs, so the target is ~44 px wide without changing what is drawn. */}
                <button
                    type="button"
                    className="spw-player-capsule-mod"
                    data-spw-chrome="mod-market-entry"
                    aria-label={modMarketLabel}
                    title={modMarketLabel}
                    onClick={onOpenModMarket}
                />
            </div>
        </div>
    );
};

export default PlayerBackgroundControl;
