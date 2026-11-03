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

const resolveContainer = (injected: boolean): HTMLElement => {
    const existing = document.getElementById('spw-settings-ui-root');
    if (existing) return existing;
    const container = injected ? document.createElement('div') : (document.getElementById('root') ?? document.createElement('div'));
    if (injected) {
        container.id = 'spw-settings-ui-root';
        container.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
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
