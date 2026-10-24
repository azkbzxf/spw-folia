/* The lyric line that is playing right now — plain text, for the settings window's font picker.
 *
 * v0.4.1 真实预览: the stage no longer samples a song of its own. It used to hand-copy Folia's
 * `PreviewPlaceholder` songs here and rebuild a config from them; now it renders the exact config
 * the publisher pushed to the player, so the placeholder machinery is gone. What is left is the one
 * place that needs plain text instead of a renderer: the custom-font picker previews the current
 * lyric line above its font list.
 *
 * `inputs.lyrics` arrives in either shape: the plugin's own line shape (protocol §3:
 * `{startMs,endMs,main,sub,cells}`) or Folia's `LyricData` (`{startTime,endTime,fullText,translation}`
 * in SECONDS). Mirrors `toPublisherLyrics` in `useConfigPublisher.ts`. */
import { useEffect, useState } from 'react';
import { bridgeOn, getBridge } from '~/bridge';

/** One lyric line, already normalised to milliseconds. */
interface LyricLine {
    startMs: number;
    endMs: number;
    main: string;
    sub?: string;
    id?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toLyricLines = (payload: unknown): LyricLine[] => {
    if (!isRecord(payload)) return [];
    const raw = payload.lines;
    if (!Array.isArray(raw)) return [];
    const mapped: LyricLine[] = [];
    for (const value of raw) {
        if (!isRecord(value)) continue;
        const main = value.main;
        const startMs = value.startMs;
        const endMs = value.endMs;
        if (typeof main === 'string' && typeof startMs === 'number' && typeof endMs === 'number') {
            mapped.push({
                startMs,
                endMs,
                main,
                ...(typeof value.sub === 'string' ? { sub: value.sub } : {}),
                ...(typeof value.id === 'string' ? { id: value.id } : {}),
            });
            continue;
        }
        // Folia LyricData line: seconds + fullText.
        const foliaStart = value.startTime;
        const foliaEnd = value.endTime;
        const fullText = value.fullText;
        if (typeof fullText === 'string' && typeof foliaStart === 'number' && typeof foliaEnd === 'number') {
            mapped.push({
                startMs: foliaStart * 1000,
                endMs: foliaEnd * 1000,
                main: fullText,
                ...(typeof value.translation === 'string' && value.translation ? { sub: value.translation } : {}),
                ...(typeof value.id === 'string' ? { id: value.id } : {}),
            });
        }
    }
    return mapped;
};

/** The current playback position in ms (the bridge reports seconds), 0 when unknown/IDLE. */
const livePositionMs = (): number => {
    const currentTime = getBridge()?.inputs?.state?.currentTime;
    return typeof currentTime === 'number' && Number.isFinite(currentTime) ? Math.max(0, currentTime * 1000) : 0;
};

/** The lyric line playing right now (or the next one) as plain text; `null` when nothing is loaded. */
export const currentLyricText = (): string | null => {
    const bridge = getBridge();
    const usable = toLyricLines(bridge?.inputs?.lyrics)
        .filter(line => line.main.trim().length > 0)
        .sort((a, b) => a.startMs - b.startMs);
    if (usable.length === 0) return null;
    const positionMs = livePositionMs();
    const playing = usable.find(line => positionMs >= line.startMs && positionMs < line.endMs);
    if (playing) return playing.main;
    const upcoming = usable.find(line => line.startMs >= positionMs);
    return (upcoming ?? usable[0]).main;
};

/** The live line as a React value. Re-reads on every `lyrics`/`state` event, so the font picker's
 *  preview follows playback instead of freezing on the line it opened with. */
export const useCurrentLyricText = (): string | null => {
    const [text, setText] = useState<string | null>(() => currentLyricText());
    useEffect(() => {
        const read = (): void => setText(currentLyricText());
        read();
        const offLyrics = bridgeOn('lyrics', read);
        const offState = bridgeOn('state', read);
        return () => {
            offLyrics();
            offState();
        };
    }, []);
    return text;
};
