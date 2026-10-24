/* The sample songs Folia's playground samples with (work/folia/.../PreviewPlaceholder.ts).
 *
 * Hand-copied on purpose: importing that Folia module pulls the renderer graph (three/pixi lazy
 * chunks) into the injected bundle, which v0.1.5 broke on (MISSING_EXPORT / React #185). Only the
 * lyrics data is needed here — the live renderer itself runs in the preview iframe.
 *
 * Times below are milliseconds because the settings-ui publisher speaks `PublisherLyricLine`;
 * word boundaries are generated the same way Folia does it (per character for CJK, per token for
 * space-separated scripts). Background-vocal (harmony) data is intentionally not carried over: the
 * injected config always disables the harmony overlay (publisher/config.ts).
 *
 * v0.4.0 预览文本 `current`: the sample the stage shows by default is no longer one of the two
 * hand-copied songs but the lyrics of the song that is actually playing (`livePreviewSong`, read
 * from the bridge's `inputs.lyrics` / `inputs.state`). The static pair stays as the fallback for an
 * idle player and as the explicit `default` / `reserved` choices. */
import { useEffect, useState } from 'react';
import { bridgeOn, getBridge } from '~/bridge';
import type { PublisherLyricLine, PublisherTrack, PublisherWord } from '~/publisher/config';
import type { PreviewPlaceholderId, StyleMode } from './settings';

const characterWords = (text: string, startMs: number, endMs: number): PublisherWord[] => {
    const chars = Array.from(text);
    const step = Math.max(0, endMs - startMs) / Math.max(1, chars.length);
    return chars.map((char, index) => ({
        text: char,
        startMs: Math.round(startMs + step * index),
        endMs: Math.round(startMs + step * (index + 1)),
    }));
};

const tokenWords = (tokens: string[], startMs: number, endMs: number): PublisherWord[] => {
    const step = Math.max(0, endMs - startMs) / Math.max(1, tokens.length);
    return tokens.map((token, index) => ({
        text: token,
        startMs: Math.round(startMs + step * index),
        endMs: Math.round(startMs + step * (index + 1)),
    }));
};

/** Folia's own split: per token for space-separated scripts, per character for CJK. */
const wordsFor = (text: string, startMs: number, endMs: number): PublisherWord[] => {
    const trimmed = text.trim();
    return /\s/.test(trimmed) ? tokenWords(trimmed.split(/\s+/), startMs, endMs) : characterWords(text, startMs, endMs);
};

export interface PreviewPlaceholderSong {
    id: PreviewPlaceholderId;
    title: string;
    /** One loop of the sampled lyric section, in seconds (Folia's playground loops it). */
    loopDuration: number;
    /** Placeholder cover file name under `/preview/` in the host bundle (stage-web.mjs copies it). */
    coverFile: string;
    lines: PublisherLyricLine[];
}

const SHINBUN_LINES: PublisherLyricLine[] = [
    {
        startMs: 700,
        endMs: 3600,
        main: '詩情を持たずとも、あなたを現実へと導くその神文の詩を紡ぐ。',
        sub: '编织那没有诗意，却能将你带到现实的神文之诗。',
        romanization: 'Shijō o motazu tomo, anata o genjitsu e to michibiku sono shinbun no shi o tsumugu.',
        words: characterWords('詩情を持たずとも、あなたを現実へと導くその神文の詩を紡ぐ。', 700, 3600),
    },
    {
        startMs: 4200,
        endMs: 7200,
        main: 'Weave that prosaic divine poem that leads you to reality.',
        sub: '编织那没有诗意，却能将你带到现实的神文之诗。',
        romanization: 'Weave that prosaic divine poem that leads you to reality.',
        words: tokenWords(
            ['Weave', 'that', 'prosaic', 'divine', 'poem', 'that', 'leads', 'you', 'to', 'reality.'],
            4200,
            7200,
        ),
    },
    {
        startMs: 7800,
        endMs: 10900,
        main: 'Tisse ce poème divin sans poésie qui te mène au réel.',
        sub: '编织那没有诗意，却能将你带到现实的神文之诗。',
        romanization: 'Tisse ce poème divin sans poésie qui te mène au réel.',
        words: tokenWords(
            ['Tisse', 'ce', 'poème', 'divin', 'sans', 'poésie', 'qui', 'te', 'mène', 'au', 'réel.'],
            7800,
            10900,
        ),
    },
    {
        startMs: 11500,
        endMs: 14400,
        main: '编织那没有诗意，却能将你带到现实的神文之诗。',
        sub: '编织那没有诗意，却能将你带到现实的神文之诗。',
        romanization: 'Biānzhī nà méiyǒu shīyì, què néng jiāng nǐ dài dào xiànshí de shénwén zhī shī.',
        words: characterWords('编织那没有诗意，却能将你带到现实的神文之诗。', 11500, 14400),
    },
];

const WILD_SESAME_LINES: PublisherLyricLine[] = [
    {
        startMs: 0,
        endMs: 3100,
        main: 'You and the others who think',
        sub: '你和那些自以为如此的人',
        romanization: 'You and the others who think',
        words: tokenWords(['You', 'and', 'the', 'others', 'who', 'think'], 0, 3100),
    },
    {
        startMs: 3600,
        endMs: 6900,
        main: '真実のために生きていると思う人たち、',
        sub: '那些自以为为真理而活的人，',
        romanization: 'Shinjitsu no tame ni ikite iru to omou hitotachi,',
        words: characterWords('真実のために生きていると思う人たち、', 3600, 6900),
    },
    {
        startMs: 7400,
        endMs: 10300,
        main: 'et, par extension, qui aiment',
        sub: '并因此爱上一切……',
        romanization: 'et, par extension, ki em',
        words: tokenWords(['et,', 'par', 'extension,', 'qui', 'aiment'], 7400, 10300),
    },
    {
        startMs: 10800,
        endMs: 13600,
        main: '一切冰冷的事物。',
        sub: 'all that is cold.',
        romanization: 'Yīqiè bīnglěng de shìwù.',
        words: characterWords('一切冰冷的事物。', 10800, 13600),
    },
];

/** The static sample songs. `current` is live, so it is not a key here. */
export const PREVIEW_PLACEHOLDERS: Record<Exclude<PreviewPlaceholderId, 'current'>, PreviewPlaceholderSong> = {
    default: {
        id: 'default',
        title: '神文之诗',
        loopDuration: 14.4,
        coverFile: 'placeholder_cover.jpg',
        lines: SHINBUN_LINES,
    },
    reserved: {
        id: 'reserved',
        title: '野芝麻',
        loopDuration: 13.6,
        coverFile: 'placeholder_cover-2.jpg',
        lines: WILD_SESAME_LINES,
    },
};

/** The ids the 预览文本 control lists as static choices (everything but `current`). */
export const STATIC_PREVIEW_PLACEHOLDER_IDS: Exclude<PreviewPlaceholderId, 'current'>[] = ['default', 'reserved'];

/** v0.4.0: sample the song that is playing right now, like Folia 0.7.22 does. */
export const DEFAULT_PREVIEW_PLACEHOLDER_ID: PreviewPlaceholderId = 'current';

/* ------------------------------------------------------------------------------------------------
 * Live sample (`current`): read the playing song's lyrics off the bridge.
 * ---------------------------------------------------------------------------------------------- */

/** One lyric line as either side shapes it, already normalised to milliseconds. */
interface LiveLyricLine {
    startMs: number;
    endMs: number;
    main: string;
    sub?: string;
    id?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * `inputs.lyrics` as the host hands it over: the plugin's own line shape (protocol §3:
 * `{startMs,endMs,main,sub,cells}`) or Folia's `LyricData` (`{startTime,endTime,fullText,translation}`
 * in SECONDS). Mirrors `toPublisherLyrics` in `useConfigPublisher.ts` so both paths accept exactly
 * the same payloads (that module owns the live publisher; this one feeds the sample).
 */
const toLiveLines = (payload: unknown): LiveLyricLine[] => {
    if (!isRecord(payload)) return [];
    const raw = payload.lines;
    if (!Array.isArray(raw)) return [];
    const mapped: LiveLyricLine[] = [];
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

/** How many upcoming lines the live sample carries (the playing one first, then its successors). */
const LIVE_SAMPLE_LINES = 8;
const LIVE_LOOP_MIN_SEC = 6;
const LIVE_LOOP_MAX_SEC = 30;

/** The current playback position in ms (the bridge reports seconds), 0 when unknown/IDLE. */
const livePositionMs = (): number => {
    const currentTime = getBridge()?.inputs?.state?.currentTime;
    return typeof currentTime === 'number' && Number.isFinite(currentTime) ? Math.max(0, currentTime * 1000) : 0;
};

/** The lyric line playing right now (or the next one), as plain text — the font picker's preview
 *  row and the settings window's own sample both show it. `null` when nothing is playing. */
export const currentLyricText = (): string | null => {
    const bridge = getBridge();
    const usable = toLiveLines(bridge?.inputs?.lyrics)
        .filter(line => line.main.trim().length > 0)
        .sort((a, b) => a.startMs - b.startMs);
    if (usable.length === 0) return null;
    const positionMs = livePositionMs();
    const playing = usable.find(line => positionMs >= line.startMs && positionMs < line.endMs);
    if (playing) return playing.main;
    const upcoming = usable.find(line => line.startMs >= positionMs);
    return (upcoming ?? usable[0]).main;
};

/** v0.4.0: the live line as a React value. Re-reads on every `lyrics`/`state` event, so the font
 *  picker's preview follows playback instead of freezing on the line it opened with. */
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

/**
 * v0.4.0: the sample built from the song that is actually playing, or `null` when nothing is
 * loaded. The window starts at the line that is playing now and is re-based to 0, because the
 * preview iframe loops a `[0, loopDuration)` clock: raw song timestamps (a 4-minute song) would
 * never be reached and the sample would stay blank.
 */
export const livePreviewSong = (): PreviewPlaceholderSong | null => {
    const bridge = getBridge();
    const usable = toLiveLines(bridge?.inputs?.lyrics)
        .filter(line => line.main.trim().length > 0)
        .sort((a, b) => a.startMs - b.startMs);
    if (usable.length === 0) return null;

    const positionMs = livePositionMs();
    let anchor = usable.findIndex(line => positionMs >= line.startMs && positionMs < line.endMs);
    if (anchor < 0) {
        // Intro/outro or a paused player between lines: the next upcoming line, else the first.
        anchor = usable.findIndex(line => line.startMs >= positionMs);
        if (anchor < 0) anchor = 0;
    }

    const windowLines = usable.slice(anchor, anchor + LIVE_SAMPLE_LINES);
    const baseMs = Math.max(0, windowLines[0].startMs);
    const lines: PublisherLyricLine[] = windowLines.map(line => {
        const startMs = Math.max(0, line.startMs - baseMs);
        // Degenerate lines (zero/negative span) still need a tick so their words are not all 0 ms.
        const endMs = Math.max(startMs + 1, line.endMs - baseMs);
        return {
            startMs,
            endMs,
            main: line.main,
            ...(line.sub ? { sub: line.sub } : {}),
            ...(line.id ? { id: line.id } : {}),
            words: wordsFor(line.main, startMs, endMs),
        };
    });

    const spanMs = Math.max(0, windowLines[windowLines.length - 1].endMs - baseMs);
    const loopDuration = Math.max(LIVE_LOOP_MIN_SEC, Math.min(LIVE_LOOP_MAX_SEC, spanMs / 1000));
    const trackTitle = bridge?.inputs?.track?.title;

    return {
        id: 'current',
        title: typeof trackTitle === 'string' && trackTitle.trim().length > 0 ? trackTitle : '当前播放',
        loopDuration,
        coverFile: 'placeholder_cover.jpg',
        lines,
    };
};

/**
 * The 预览文本 control's sample song: `current` (the default, and what null/unknown ids fall back
 * to) samples the playing song and falls back to the static default while nothing is playing;
 * `default`/`reserved` are the hand-copied static songs.
 */
export const getPreviewPlaceholder = (id: PreviewPlaceholderId | null | undefined): PreviewPlaceholderSong => {
    if (id === 'default' || id === 'reserved') return PREVIEW_PLACEHOLDERS[id] ?? PREVIEW_PLACEHOLDERS.default;
    return livePreviewSong() ?? PREVIEW_PLACEHOLDERS.default;
};

/** `coverBaseUrl` is the host origin + `/preview` (the folder stage-web.mjs fills). */
export const previewTrackFor = (
    id: PreviewPlaceholderId | null | undefined,
    coverBaseUrl: string,
): PublisherTrack => {
    const song = getPreviewPlaceholder(id);
    return {
        id: `preview-${song.id}`,
        title: song.title,
        artist: null,
        album: null,
        coverUrl: `${coverBaseUrl.replace(/\/+$/, '')}/${song.coverFile}`,
        durationMs: Math.round(song.loopDuration * 1000),
        lyrics: song.lines,
    };
};

/** Folia's per-style `previewStartOffset` modulo the placeholder loop (fume is the only non-zero). */
export const previewStartOffsetFor = (mode: StyleMode, loopDuration: number): number => {
    if (mode !== 'fume') return 0;
    const offset = 18.4 % Math.max(loopDuration, 0.001);
    return Number.isFinite(offset) ? offset : 0;
};
