/* 市场专用窗口的挂载点（issue #23 第二轮）。
 *
 * ## 为什么是「同一个 bundle 里的一个分支」而不是第二个 vite 入口
 *
 * 用户的抱怨是「商店不再依赖 folia 的主界面」：从配置里点「模组市场」只该弹一个装着市场的小窗，
 * 不需要播放页存在。窗口由宿主开（第二个 `spw-folia-host.exe`，`--url` 指向
 * `mod-market.html`），页面仍然由**同一个** `settings-ui.js` 挂载 —— 只是这次只渲染市场面板。
 *
 * 不另开 vite 入口有两个硬理由：
 *   1. `vite.config.ts` 的 `entryFileNames` 是固定字符串 `settings-ui.js`，两个入口会互相覆盖；
 *   2. `stage-web.mjs` 从**这一个文件**里反推样式货架清单，`assemble-release.py` 硬性要求它存在，
 *      `verify-layout.mjs` 断言 `settingsScripts === 1`。多一个入口要同时改这三处。
 * 而这个分支的增量成本约等于 0：`ModMarketPanel` 本来就已经在这个 bundle 里（`App.tsx` 引了它）。
 *
 * ## 它需要什么、不需要什么
 *
 * 需要：`settings` 事件里的 `mods`（已装清单，插件拥有）、`modProgress`、`chrome.webview`
 * （`modAction` 与 `openUrl` 都走它）、`requestClose`（关窗）。这些在只有市场的页面里全部照常工作。
 *
 * 不需要：`__SPW_FOLIA_MOD_VISUALIZERS__`（那是货架用的，市场不读）、`setSettingsUiOpenState`
 * （没有设置浮层）、热区上报（没有穿透）、`/__mods/*` 文件服务（市场只列清单和预览图，导入
 * `client.mjs` 是播放页的事）。所以这个窗口**不传** `--mods-dir`。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ModMarketPanel from '../chrome/mods/ModMarketPanel';
import { getBridge } from '../bridge';

/**
 * 本窗口是不是「只有市场」。
 *
 * 判定用 URL 的查询串（`?market=1`）而不是路径：路径由 `--url` 决定，而查询串是宿主和页面之间
 * 唯一稳定的约定；`public/mod-market.html` 里写死 `?market=1`，宿主的 `--url` 也照抄它。
 */
export const isMarketWindow = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        return new URLSearchParams(window.location.search).get('market') === '1';
    } catch {
        return false;
    }
};

/**
 * 挂载市场面板本身。
 *
 * 面板是 `fixed inset-0` + 半透明遮罩的**模态**形状，在没有播放页的窗口里它就成了整页内容：
 * 遮罩会盖住那层 `#111113`，视觉上就是一整块深色底 + 居中的面板，正是要的效果。所以这里不改
 * 面板自己的布局（改它就得同时照顾设置岛里的用法）。
 *
 * `onClose` 走 `requestClose`（Shim 的 `post({type:'action',name:'close'})`）：这个窗口没有
 * 「设置浮层」可以退回去，关掉市场就等于关掉窗口，宿主收到 action 后正常退出进程。
 */
export const mountMarketWindow = (): void => {
    const container = document.getElementById('root');
    if (!container) {
        // 宁可大声说，也不要给一个空白窗口（`mod-market.html` 的注释写了 `#root` 是必需的）。
        console.error('[spw-folia] mod-market.html is missing #root; the market window cannot mount');
        return;
    }
    if ((container as HTMLElement & { __spwReactRoot?: unknown }).__spwReactRoot) return;
    // 全局标记：Shim 的 `case 'mods'` 据此跳过模组激活（见 Shim.js 那一处注释）。
    (window as Window & { __SPW_FOLIA_MARKET_ONLY__?: boolean }).__SPW_FOLIA_MARKET_ONLY__ = true;
    const root = createRoot(container, {
        onUncaughtError: (error: unknown, errorInfo: { componentStack?: string }) => {
            console.error(`[spw-folia] market window uncaught: ${String(error)}\n${errorInfo.componentStack ?? ''}`);
        },
    });
    (container as HTMLElement & { __spwReactRoot?: unknown }).__spwReactRoot = root;
    root.render(
        <ModMarketPanel
            open
            /* 这个窗口里没有播放页，面板自己就是窗口内容：去掉模态遮罩与内边距，
             * 否则窗口底色会从四周露出一圈黑边（用户报的就是这个）。 */
            standalone
            onClose={() => {
                // 宿主可能不在（dev 直接打开这个 html）：那就只打一行日志，不抛。
                getBridge().requestClose?.();
            }}
        />,
    );
};
