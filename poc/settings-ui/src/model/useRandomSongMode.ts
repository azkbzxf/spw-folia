/* 0.7.22 随机歌词样式: the per-song draw.
 *
 * Port of Folia's `src/hooks/useRandomVisualizerMode.ts` to this shell: upstream watches its
 * `currentSong` object, we watch the host `track` bridge event (the plugin pushes one per song).
 * The rules are upstream's, minus everything that needs Folia's `SongResult`:
 *
 *  - one style per song: a *new* track id draws a style, a repeated one (metadata refreshed,
 *    StrictMode replaying effects, the host re-emitting the same track) never does;
 *  - nothing happens while 随机 is off — switching it on is the store's job, it draws at once in
 *    `setRandomVisualizerModePerSong(true)`;
 *  - the current style must be inside the pool before it is replaced: a style the user picked
 *    outside the pool means the shelf, not the pool, is driving, so it is left alone;
 *  - `preserveRandom: true` keeps 随机 switched on through the draw (the store otherwise reads a
 *    `setVisualizerMode` as "the user picked this style by hand" and turns random off).
 *
 * The raw `getBridge().inputs?.track` id is taken as the baseline at mount, so a page that loads
 * mid-song does not switch style under the listener's nose; the first *event* afterwards is only
 * compared against it. Mount once, in the shell (App.tsx). */
import { useEffect } from 'react';
import { bridgeOn, getBridge, type BridgeTrackMessage } from '~/bridge';
import {
    normalizeRandomModes,
    pickRandomMode,
    useSettingsStore,
} from './settings';

/** Whether a track event is a *change* (and therefore draws a style). The first id seen, a
 *  repeated id and an event without an id all draw nothing (see the header). */
export const isTrackChange = (previousSongId: string | null, nextSongId: string | null): boolean =>
    previousSongId !== null && nextSongId !== null && previousSongId !== nextSongId;

export const useRandomSongMode = (): void => {
    useEffect(() => {
        // Baseline: the song already playing when this page was mounted. A null baseline means
        // "no song seen yet" — the first event then establishes it without drawing (upstream's
        // `observedSongIdRef.current !== null` guard).
        let observedSongId: string | null = getBridge().inputs?.track?.id ?? null;

        const onTrack = (payload: Partial<BridgeTrackMessage> | null | undefined): void => {
            const songId = typeof payload?.id === 'string' && payload.id.length > 0 ? payload.id : null;
            const changed = isTrackChange(observedSongId, songId);
            // A track without an id cannot be told apart from the current song: keep the baseline.
            if (songId !== null) observedSongId = songId;
            if (!changed) return;

            const state = useSettingsStore.getState();
            if (!state.randomVisualizerModePerSong) return;
            const pool = normalizeRandomModes(state.randomVisualizerModes);
            const current = state.visualizerMode;
            if (!pool.includes(current)) return;
            const next = pickRandomMode(pool, current);
            if (next !== current) state.setVisualizerMode(next, { preserveRandom: true });
        };

        return bridgeOn<BridgeTrackMessage>('track', onTrack);
    }, []);
};
