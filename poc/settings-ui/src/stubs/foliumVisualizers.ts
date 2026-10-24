/* Folia's mods/folium visual styles: not installed in this POC. */
const EMPTY = [] as const;

export const visualizersRegistry = {
    list: () => EMPTY,
    subscribe: (_listener: () => void) => () => {},
    get: (_mode: string): unknown => undefined,
};

/** Per-mode mod settings for `mod:` styles (0.7.22). None are installed, so always null. */
export const useFoliumVisualizerSettings = (_mode: string): unknown => null;

export default { visualizersRegistry, useFoliumVisualizerSettings };
