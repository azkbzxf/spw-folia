/* Minimal stand-in for Folia's mod-host registry: the empty registries are stable snapshots, so
 * useSyncExternalStore can subscribe without looping. */
import { useSyncExternalStore } from 'react';

export interface FoliumHostRegistry {
    list: () => unknown;
    subscribe: (listener: () => void) => () => void;
}

const EMPTY = Object.freeze([]) as readonly unknown[];

/** Builds an always-empty host registry (0.7.22). Its snapshot is frozen, so the hook is stable. */
export const createFoliumRegistry = (_name: string, _options?: unknown): FoliumHostRegistry => ({
    list: () => EMPTY,
    subscribe: (_listener: () => void) => () => {},
});

export const useFoliumRegistryEntries = (registry: FoliumHostRegistry): unknown[] =>
    useSyncExternalStore(registry.subscribe, registry.list as () => unknown[], registry.list as () => unknown[]) as unknown[];
