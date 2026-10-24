/* The live sample of the selected style: a same-origin iframe that runs Folia's real renderer.
 *
 * The settings overlay is injected into Folia's own OBS surface page, so instead of bundling the
 * renderer into settings-ui.js we load `preview.html` (a copy of the OBS page plus a child-frame
 * shim) and drive it over postMessage: see docs/live-preview-iframe.md for the frozen contract.
 *
 * v0.4.1 真实预览: the child no longer runs a synthesized timeline and a placeholder song. The
 * parent forwards the host's real `state`/`audio` events (the same ones the player page consumes)
 * and the exact config the publisher just handed to the host, so the stage is a true mirror of the
 * player — real track, real lyrics, real background and the transparent-playback effect.
 *
 * The iframe is laid out at a fixed 1920x1080 CSS px — Folia's surface only reaches its fullscreen
 * layout when the viewport is >= 1080p — and then scaled to cover the stage box with Folia's own
 * 1.15 "sample zoom", exactly like VisPlayground does for its live sample. pointer-events stay off
 * so the pause button above the stage keeps working.
 *
 * Failure policy: the parent gets ready within READY_TIMEOUT_MS or it is reported as an error, and
 * Stage falls back to the (formerly only) static Ken Burns preview. The iframe is only created once
 * the stage has a non-zero size, so a closed settings overlay never keeps a second renderer running
 * at page load. */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ObsBrowserSourceConfig } from '@/types/obsBrowserSource';
import { bridgeOn } from '~/bridge';
import type { UploadedFontDescriptor } from '~/model/settings';
import { loadUploadedFontFile } from '~/model/uploadedFonts';

/** Size of the virtual screen inside the iframe; must stay 1920x1080 for the OBS layout. */
const PREVIEW_WIDTH = 1920;
const PREVIEW_HEIGHT = 1080;
/** Folia's DEFAULT_SAMPLE_ZOOM (VisPlayground.tsx): the sample is slightly enlarged and cropped. */
const SAMPLE_ZOOM = 1.15;
const READY_TIMEOUT_MS = 4000;
/** postMessage budget: the settings UI pushes config at most 10 Hz (protocol §4). */
const MESSAGE_MIN_INTERVAL_MS = 100;

/** The host `state` event (docs/protocol.md §3): the raw clock the player page interpolates from. */
interface BridgeStatePayload {
    posMs?: number;
    durationMs?: number;
    playing?: boolean;
    rate?: number;
    tsMs?: number;
    lyricOffsetMs?: number;
}

interface LivePreviewProps {
    paused: boolean;
    /** The exact config the publisher pushed to the player; the child renders it verbatim. */
    config: ObsBrowserSourceConfig;
    /** v0.4.0: uploaded fonts, re-registered in the iframe document (see `applyUploadedFonts`). */
    uploadedFonts: UploadedFontDescriptor[];
    onError?: (message?: string) => void;
}

interface PreviewMessage {
    __spwFoliaPreview?: number;
    kind?: string;
    payload?: unknown;
}

const IFRAME_URL = () => `${window.location.origin}/preview.html?obs=1&preview=1`;

const LivePreview: React.FC<LivePreviewProps> = ({ paused, config, uploadedFonts, onError }) => {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;

    const [shouldLoad, setShouldLoad] = useState(false);
    const [ready, setReady] = useState(false);
    const [scale, setScale] = useState(0);
    const [hidden, setHidden] = useState(false);

    const readyRef = useRef(false);
    const failedRef = useRef(false);
    const configRef = useRef(config);
    configRef.current = config;
    const pausedRef = useRef(paused);
    pausedRef.current = paused;
    const hiddenRef = useRef(hidden);
    hiddenRef.current = hidden;
    const lastSentAtRef = useRef(0);
    const configTimerRef = useRef<number | null>(null);
    const readyTimerRef = useRef<number | null>(null);
    const statsRef = useRef<{ canvases: number; frames: number } | null>(null);
    /** Families already pushed into the child document (the ready path and the later-effects path can race). */
    const injectedFontsRef = useRef<Set<string>>(new Set());

    const send = useCallback((kind: string, payload: unknown) => {
        const target = iframeRef.current?.contentWindow;
        if (!target) return;
        target.postMessage({ __spwFoliaPreview: 1, kind, payload }, window.location.origin);
    }, []);

    const fail = useCallback((message?: string) => {
        if (failedRef.current) return;
        failedRef.current = true;
        if (message) console.warn('[spw-live-preview]', message);
        onErrorRef.current?.(message);
    }, []);

    /** At most one `config` per MESSAGE_MIN_INTERVAL_MS, trailing edge (matches the publisher). */
    const scheduleConfig = useCallback(() => {
        if (!readyRef.current) return;
        if (configTimerRef.current != null) window.clearTimeout(configTimerRef.current);
        const wait = Math.max(0, MESSAGE_MIN_INTERVAL_MS - (performance.now() - lastSentAtRef.current));
        configTimerRef.current = window.setTimeout(() => {
            configTimerRef.current = null;
            if (!readyRef.current) return;
            lastSentAtRef.current = performance.now();
            send('config', configRef.current);
        }, wait);
    }, [send]);

    /**
     * v0.4.0 (fix: 预览框字体不跟随): uploaded fonts are registered with `document.fonts.add()` in
     * the settings/player document only. The preview iframe is a *separate* document, so a
     * `SpwFoliaFont_*` family is unknown there and Folia's renderer silently falls back. The iframe
     * is same-origin, so register the same faces into its document before the first config is
     * delivered (Folia's lyric font code calls `document.fonts.load(family)` when the config lands,
     * so a face added later would not trigger a re-layout on its own).
     * Returns true when at least one face was added (the renderer then needs a fresh config).
     */
    const applyUploadedFonts = useCallback(async (): Promise<boolean> => {
        const contentWindow = iframeRef.current?.contentWindow;
        const contentDocument = contentWindow?.document;
        if (!contentWindow || !contentDocument || uploadedFonts.length === 0) return false;
        const fontFaceCtor = (contentWindow as unknown as { FontFace?: typeof FontFace }).FontFace ?? FontFace;
        const known = new Set<string>(injectedFontsRef.current);
        contentDocument.fonts.forEach(face => known.add(face.family));
        let added = false;
        for (const descriptor of uploadedFonts) {
            if (!descriptor.family || known.has(descriptor.family)) continue;
            // Reserve before any await: the ready path and the uploadedFonts effect can start
            // concurrently, and both would otherwise register a FontFace for the same family.
            known.add(descriptor.family);
            injectedFontsRef.current.add(descriptor.family);
            let bytes: ArrayBuffer | null = null;
            try {
                const blob = await loadUploadedFontFile(descriptor.id).catch(() => null);
                bytes = blob ? await blob.arrayBuffer().catch(() => null) : null;
            } catch (error) {
                bytes = null;
            }
            if (!bytes) {
                injectedFontsRef.current.delete(descriptor.family);
                continue;
            }
            try {
                const face = new fontFaceCtor(descriptor.family, bytes);
                await face.load();
                contentDocument.fonts.add(face);
                added = true;
            } catch (error) {
                injectedFontsRef.current.delete(descriptor.family);
                console.warn('[spw-live-preview] font registration failed', descriptor.family, error);
            }
        }
        return added;
    }, [uploadedFonts]);

    // Measure the stage: scale the 1920x1080 virtual screen so it covers the box (1.15x crop).
    useLayoutEffect(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return undefined;
        const update = () => {
            const width = wrapper.clientWidth;
            const height = wrapper.clientHeight;
            if (width <= 0 || height <= 0) {
                setHidden(true);
                return;
            }
            setHidden(false);
            setShouldLoad(true);
            setScale((Math.max(width / PREVIEW_WIDTH, height / PREVIEW_HEIGHT)) * SAMPLE_ZOOM);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(wrapper);
        return () => observer.disconnect();
    }, []);

    // Messages from the child frame: ready / error / stats (docs/live-preview-iframe.md §消息契约).
    useEffect(() => {
        const onMessage = (event: MessageEvent<PreviewMessage>) => {
            if (event.origin !== window.location.origin) return;
            if (event.source !== iframeRef.current?.contentWindow) return;
            const data = event.data;
            if (!data || data.__spwFoliaPreview !== 1 || typeof data.kind !== 'string') return;
            if (data.kind === 'ready') {
                if (readyRef.current) return;
                readyRef.current = true;
                setReady(true);
                if (readyTimerRef.current != null) {
                    window.clearTimeout(readyTimerRef.current);
                    readyTimerRef.current = null;
                }
                lastSentAtRef.current = performance.now();
                // v0.4.1: live mode — no synthesized timeline; the parent forwards the host's clock.
                send('live', true);
                send('paused', pausedRef.current || hiddenRef.current);
                // Register uploaded fonts in the child document *before* the first config: Folia calls
                // document.fonts.load(family) while applying the config, and a face added afterwards
                // would not re-layout the already rendered lyrics.
                void applyUploadedFonts().then(() => {
                    if (!readyRef.current) return;
                    lastSentAtRef.current = performance.now();
                    send('config', configRef.current);
                });
                return;
            }
            if (data.kind === 'error') {
                const message = typeof data.payload === 'object' && data.payload != null
                    ? String((data.payload as { message?: unknown }).message ?? 'preview error')
                    : 'preview error';
                fail(message);
                return;
            }
            if (data.kind === 'stats' && typeof data.payload === 'object' && data.payload != null) {
                const stats = data.payload as { canvases?: unknown; frames?: unknown };
                statsRef.current = {
                    canvases: Number(stats.canvases) || 0,
                    frames: Number(stats.frames) || 0,
                };
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [applyUploadedFonts, fail, send]);

    // 4 s without `ready` (missing preview.html, broken shim) → fall back to the static sample. The
    // clock only runs while the iframe is actually loaded and the stage is visible: the settings
    // overlay lives in the DOM while closed (display:none), and that must not burn the timeout.
    useEffect(() => {
        if (ready || !shouldLoad || hidden) return undefined;
        readyTimerRef.current = window.setTimeout(() => {
            readyTimerRef.current = null;
            if (!readyRef.current) fail('preview iframe did not report ready in time');
        }, READY_TIMEOUT_MS);
        return () => {
            if (readyTimerRef.current != null) {
                window.clearTimeout(readyTimerRef.current);
                readyTimerRef.current = null;
            }
        };
    }, [fail, hidden, ready, shouldLoad]);

    useEffect(() => {
        if (!ready) return;
        scheduleConfig();
    }, [config, ready, scheduleConfig]);

    // A new upload (or a restored descriptor list) after the first render: register the face in the
    // child document and re-deliver the config so Folia re-lays out with the now resolvable family.
    useEffect(() => {
        if (!ready) return undefined;
        let cancelled = false;
        void applyUploadedFonts().then(added => {
            if (!cancelled && added) scheduleConfig();
        });
        return () => {
            cancelled = true;
        };
    }, [applyUploadedFonts, ready, scheduleConfig]);

    // v0.4.1 真实预览: forward the host's real clock/audio to the child, the same events the player
    // page consumes. The preview shim turns them into the SSE shapes Folia's renderer expects
    // (clock/audio) and stops its own synthetic tick; nothing is forwarded while paused or hidden,
    // because the child pins its last clock then.
    useEffect(() => {
        const forward = (kind: 'state' | 'audio') => (payload: unknown) => {
            if (!readyRef.current || pausedRef.current || hiddenRef.current) return;
            send(kind, payload);
        };
        const offState = bridgeOn<BridgeStatePayload>('state', forward('state'));
        const offAudio = bridgeOn<unknown>('audio', forward('audio'));
        return () => {
            offState();
            offAudio();
        };
    }, [send]);

    // The overlay is display:none while closed: freeze the child instead of paying for a hidden 1080p
    // renderer. The pause button freezes it too.
    useEffect(() => {
        if (!ready) return;
        send('paused', paused || hidden);
    }, [paused, hidden, ready, send]);

    useEffect(() => () => {
        if (configTimerRef.current != null) window.clearTimeout(configTimerRef.current);
        if (readyTimerRef.current != null) window.clearTimeout(readyTimerRef.current);
    }, []);

    return (
        <div
            ref={wrapperRef}
            data-spw-live-preview="true"
            data-live-preview-ready={ready ? 'true' : 'false'}
            className="absolute inset-0 overflow-hidden"
        >
            {shouldLoad && (
                <iframe
                    ref={iframeRef}
                    title="歌词动画预览"
                    src={IFRAME_URL()}
                    tabIndex={-1}
                    aria-hidden="true"
                    data-spw-live-preview-iframe="true"
                    onLoad={() => {
                        // A reloaded child document has an empty FontFace table again.
                        injectedFontsRef.current.clear();
                    }}
                    style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        width: `${PREVIEW_WIDTH}px`,
                        height: `${PREVIEW_HEIGHT}px`,
                        border: 0,
                        pointerEvents: 'none',
                        background: 'transparent',
                        transform: `translate(-50%, -50%) scale(${scale})`,
                        transformOrigin: 'center',
                    }}
                />
            )}
        </div>
    );
};

export default LivePreview;
