/* Folia's mods/folium tuning cards: not installed in this POC, so the mod registry is empty. */
import { useSyncExternalStore } from 'react';
import type React from 'react';

const EMPTY = [] as const;

const EMPTY_TUNINGS: Readonly<Record<string, number>> = Object.freeze({});

const subscribeTunings = (_listener: () => void) => () => {};

export const tuningsRegistry = {
    list: () => EMPTY,
    subscribe: (_listener: () => void) => () => {},
    get: (_id: string): unknown => undefined,
};

/** Merged tuning multipliers for a target mode (0.7.22). No mods are installed, so always empty. */
export const useFoliumTunings = (_target: string): Readonly<Record<string, number>> =>
    useSyncExternalStore(subscribeTunings, () => EMPTY_TUNINGS, () => EMPTY_TUNINGS);

export const FoliumTuningCards: React.FC<Record<string, unknown>> = () => null;

export default { tuningsRegistry, useFoliumTunings, FoliumTuningCards };
