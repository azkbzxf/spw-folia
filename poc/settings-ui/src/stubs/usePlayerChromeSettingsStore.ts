/* Player chrome settings: a read-only mirror of the few fields the reused panels select.
 *
 * The injected window is not Folia's desktop app, so nothing here is writable — the panels only READ:
 *  - `enablePlayerPageNativeBlur` / `playerChromeVisibilityMode`: the native-blur notice and the chrome
 *    auto-hide row (VisPlaygroundSettingsPanel). Permanently false/'auto' here: these belong to Folia's
 *    desktop player chrome, which this window does not own.
 *  - `transparentPlayerBackground`: 雾笺's panel asks `state.transparentPlayerBackground ||
 *    state.enablePlayerPageNativeBlur` to tell whether the player page is transparent (0.7.26), and
 *    switches one explanatory line. That flag is real for this window — it is the colour-keyed player
 *    window, owned by `model/settings.ts` — so the mirror FOLLOWS our store instead of hard-coding
 *    `false`: a hint that says "the outside is always behind the window" would be a lie while
 *    transparency is on, and the panel is otherwise unable to see the real value. */
import { create } from 'zustand';
import { useSettingsStore } from '../model/settings';

interface PlayerChromeSettingsState {
    enablePlayerPageNativeBlur: boolean;
    playerChromeVisibilityMode: 'auto' | 'always' | 'hover';
    transparentPlayerBackground: boolean;
}

export const usePlayerChromeSettingsStore = create<PlayerChromeSettingsState>(() => ({
    enablePlayerPageNativeBlur: false,
    playerChromeVisibilityMode: 'auto',
    transparentPlayerBackground: useSettingsStore.getState().transparentPlayerBackground === true,
}));

// Mirror the page-owned transparency flag (both directions, including the store's own guards that
// turn it off for a style that cannot render it).
useSettingsStore.subscribe(state => {
    const next = state.transparentPlayerBackground === true;
    if (usePlayerChromeSettingsStore.getState().transparentPlayerBackground === next) return;
    usePlayerChromeSettingsStore.setState({ transparentPlayerBackground: next });
});
