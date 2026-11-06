/* Mounts the settings window. Injected into Folia's own page it mounts into a container it creates
 * (the page's DOM belongs to the visualizer), while `dev.html` mounts into the page's #root. */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';
import { bridgeIsInjected } from './bridge';

/**
 * Module-scope root. Guards against re-entry **within one module instance only** — and that is not
 * enough, which is why [MOUNTED_FLAG] below exists.
 */
let root: Root | null = null;

/**
 * Cross-instance guard, stored on `window` because module scope is NOT shared between instances of
 * this bundle.
 *
 * ## The v0.4.14 bug this fixes
 *
 * The host injects the island as `…/settings-ui.js?v=<version>` (`HostForm.cs:1404`), but the
 * bundle's own lazily-loaded chunks import the entry back **without** the query string —
 * `import{…}from"../settings-ui.js"` appears in 35 chunks (55 references). The browser keys ES
 * modules by full URL, so `?v=…` and the bare path are two different module records: the entry
 * module is instantiated twice, and its top-level `mountSettingsUi()` therefore runs twice.
 *
 * The second instance found `document.getElementById('spw-settings-ui-root')` already present,
 * `createRoot()`-ed that *same* container, and React unmounted the first tree to adopt it. Because
 * `App`'s `open` state is `useState` — per tree — the panel the user had just opened vanished, and
 * `registerSettingsUiController` overwrote `window.__SPW_FOLIA_UI__` with a controller whose `open`
 * was still `false`. Symptom for the user: 「第一次打开设置，几秒钟后自动退出」.
 *
 * A `window` flag is shared by every instance, so the second one now returns immediately.
 */
const MOUNTED_FLAG = '__SPW_FOLIA_SETTINGS_UI_MOUNTED__';

type MountHost = Window & {
    [MOUNTED_FLAG]?: boolean;
    __SPW_FOLIA_SETTINGS_UI_READY__?: boolean;
};

/**
 * The island's stacking level, and the reason it is 100 and not a huge number.
 *
 * The island is ONE stacking context that hosts the whole settings window **and** the player chrome.
 * Folia, meanwhile, portals its floating layers to `<body>` as siblings of the island:
 * `CustomSelect`'s option menu and `Sheet` at `z-[200]` (`components/shared/CustomSelectMenu.tsx`,
 * `components/shared/Sheet.tsx`), kit tooltips at `z-[210]`, `PonderStage` at `z-[220]`, the debug
 * window at `z-[300]`. A sibling only paints above the island when its own z-index is larger than
 * the island's, so any island above 200 puts **every one of those layers behind the settings
 * window**: they render, they are in the DOM, and not one pixel of them can be hit.
 *
 * That was issue #21: 字幕 → 底部字幕行数 = 三行 → 第二行/第三行 的下拉点了没反应. The menu opened
 * (`aria-expanded` flipped, the listbox mounted), painted under the island, and its options were
 * unreachable — `elementFromPoint` over the menu returned the combobox of the row *behind* it, the
 * next row's trigger. The same held for every other kit Select on every page, which is why the
 * symptom read as "the dropdown does not switch".
 *
 * 100 is chosen from measurement, not taste: Folia's own page content tops out at `z-20`
 * (`probe-band`: the highest non-island element inside the visualizer page is 20), so 100 still
 * covers the picture, while all six of Folia's portaled layers (200/205/210/220/300) come out on
 * top. The chrome's own numbers in `app.css` (2147482990…2147483002) all live INSIDE this island,
 * so they keep their relative order either way; the `#spw-folia-splash` overlay the host injects
 * sits at 2147483000 as a body sibling and now covers the island — correct, since it only exists
 * while the page is still starting.
 *
 * Do not raise this "to be safe". Anything above 200 silently re-breaks every dropdown in the
 * settings window; `verify-select-layers.mjs` fails if it happens.
 */
const ISLAND_Z_INDEX = '100';

const resolveContainer = (injected: boolean): HTMLElement => {
    const existing = document.getElementById('spw-settings-ui-root');
    if (existing) return existing;
    const container = injected ? document.createElement('div') : (document.getElementById('root') ?? document.createElement('div'));
    if (injected) {
        container.id = 'spw-settings-ui-root';
        container.style.cssText = `position:fixed;inset:0;z-index:${ISLAND_Z_INDEX};pointer-events:none;`;
        document.body.appendChild(container);
    }
    return container;
};

export const mountSettingsUi = (): void => {
    const host = window as MountHost;
    // Already mounted by a DIFFERENT module instance of this same bundle (see MOUNTED_FLAG). Adopting
    // the shared container again would unmount the live tree and silently close the settings panel.
    if (host[MOUNTED_FLAG]) {
        console.info('[spw-folia] settings UI already mounted by another instance; ignoring duplicate mount');
        return;
    }
    if (root) return;
    host[MOUNTED_FLAG] = true;

    const injected = bridgeIsInjected();
    const container = resolveContainer(injected);
    // Last line of defence: a container that already carries a React root must never be handed to
    // createRoot again (React logs a warning and the previous tree is abandoned).
    if ((container as HTMLElement & { __spwReactRoot?: unknown }).__spwReactRoot) {
        console.warn('[spw-folia] settings container already has a React root; refusing to re-create it');
        return;
    }
    root = createRoot(container, {
        // Keep crashes visible in the host log with a component stack: the injected page has no
        // dev-time overlay and the host's `js:` line only carries the JavaScript stack.
        onUncaughtError: (error: unknown, errorInfo: { componentStack?: string }) => {
            console.error(`[spw-folia] uncaught: ${String(error)}\n${errorInfo.componentStack ?? ''}`);
        },
        onCaughtError: (error: unknown, errorInfo: { componentStack?: string }) => {
            console.error(`[spw-folia] caught: ${String(error)}\n${errorInfo.componentStack ?? ''}`);
        },
    });
    (container as HTMLElement & { __spwReactRoot?: unknown }).__spwReactRoot = root;
    root.render(<App injected={injected} />);
    host.__SPW_FOLIA_SETTINGS_UI_READY__ = true;
};

export const unmountSettingsUi = (): void => {
    root?.unmount();
    root = null;
    delete (window as MountHost)[MOUNTED_FLAG];
};
