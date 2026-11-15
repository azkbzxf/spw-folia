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
 * the button that opens THIS panel never depends on that value: it is the only way back. */
import React, { useCallback, useEffect, useRef } from 'react';
import { SlidersHorizontal } from 'lucide-react';
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
}) => {
    const rootRef = useRef<HTMLDivElement | null>(null);

    const close = useCallback(() => onOpenChange(false), [onOpenChange]);

    // A style that cannot run under the colour key (monet, lumiere on a light theme) disables the
    // switch instead of letting a pink haze cover the desktop.
    const blocked = compat === 'unsupported';

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
        <div className="spw-player-bg" ref={rootRef} data-flat={enabled ? 'true' : 'false'} data-compat={compat}>
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
            <button
                type="button"
                className="spw-chrome-btn spw-chrome-btn--player"
                data-spw-chrome="player-background"
                data-visible={visible ? 'true' : 'false'}
                aria-label={panelLabel}
                aria-expanded={open ? 'true' : 'false'}
                title={panelLabel}
                onClick={() => onOpenChange(!open)}
            >
                <SlidersHorizontal size={20} strokeWidth={1.75} />
            </button>
        </div>
    );
};

export default PlayerBackgroundControl;
