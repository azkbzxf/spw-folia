/* The stage's big sample frame. Folia draws its live renderer here; the injected settings window
 * shows a real captured frame of the selected style instead (docs/folia-spec/assets.md explains
 * why: the live renderer needs the whole playback data pipeline, which the injected page has not).
 *
 * The sample still has to move, and its pause/play button has to work (m03640). Rather than animate
 * any one style's real renderer, the frame itself drifts slowly — a gentle Ken Burns zoom/pan — and
 * the pause button freezes/resumes that drift. It stays a still, so nothing depends on audio or on
 * playback state, but the box visibly lives while the song plays.
 *
 * Switching styles crossfades: the outgoing frame stays behind while the incoming one animates in
 * via the `spw-preview-in` CSS keyframes. NOTE: a previous implementation drove both layers from a
 * `fading` boolean inside an effect keyed on [src, current]; because setCurrent() retriggered the
 * effect, its cleanup cancelled the crossfade timers and the preview could stay on the old style
 * (reported m03519). This version keys the effect on `src` only and never blocks the incoming frame. */
import React, { useEffect, useRef, useState } from 'react';
import { getStyleEntry } from './styles';
import type { StyleMode } from './settings';

interface StylePreviewProps {
    mode: StyleMode;
    /** The stage's pause button: freezes/resumes the drift of the sample frame. */
    paused?: boolean;
    /**
     * issue #23: 一个**外部**给的图片地址，优先于按 `mode` 查表。
     *
     * 为什么必须有这条：`getStyleEntry(mode)` 对认不得的 mode 会**静默回落**成 `STYLE_ENTRIES[0]`
     * （= sonnet，`styles.tsx:305-306`），而模组样式（`mod:<id>:<viz>`）永远不在那张表里 —— 于是
     * 选了模组样式、实时预览又挂了的时候，这个兜底会画出「商籁」的图，看起来像样式选错了。
     * 模组格必须把自己的 preview 图从这里传进来，**不能**靠 `mode` 反查。
     */
    thumbUrl?: string | null;
    /** 上面那张图的名字（`alt`）；不给则按 `mode` 查表。 */
    thumbLabel?: string | null;
}

const CROSSFADE_MS = 220;

const StylePreview: React.FC<StylePreviewProps> = ({ mode, paused = false, thumbUrl = null, thumbLabel = null }) => {
    /* 外部地址优先；没有才按 mode 查表（内置样式的老路径完全不变）。 */
    const entry = getStyleEntry(mode);
    const src = thumbUrl && thumbUrl.length > 0 ? thumbUrl : entry.thumb;
    const label = thumbUrl && thumbUrl.length > 0 ? (thumbLabel ?? entry.labelFallback) : entry.labelFallback;
    const [previous, setPrevious] = useState<string | null>(null);
    const lastSrc = useRef<string>(src);

    useEffect(() => {
        if (lastSrc.current === src) return undefined;
        setPrevious(lastSrc.current);
        lastSrc.current = src;
        const timer = setTimeout(() => setPrevious(null), CROSSFADE_MS);
        return () => clearTimeout(timer);
    }, [src]);

    return (
        <div
            className="spw-preview-drift absolute inset-0"
            style={{ animationPlayState: paused ? 'paused' : 'running' }}
        >
            {previous && previous !== src && (
                <img
                    key={previous}
                    src={previous}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-cover"
                />
            )}
            <img
                key={src}
                src={src}
                alt={label}
                draggable={false}
                className="spw-preview-in absolute inset-0 h-full w-full object-cover"
            />
        </div>
    );
};

export default StylePreview;
