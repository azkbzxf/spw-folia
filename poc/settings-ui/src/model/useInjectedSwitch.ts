/* SPW「模组管理 → 配置」里的开关，以**设置树顶层布尔**的形式由插件下发，页面只读（v0.4.10 起）。
 *
 * 目前两个：`showProblemButton`（显示问题反馈按钮，默认关）与 `previewAnimation`（歌词样式预览动
 * 画，默认开；关掉后货架每格只画简约图案，不加载渲染器）。两者的所有权都在插件侧
 * （`preference_config.json` → `config.json`），页面只是**读者**。
 *
 * 为什么不放进 `model/settings.ts` 的 zustand store / `SettingsSnapshot`：
 * 那棵树是**页面自己的**持久化状态（页面改动 → emit → 插件写盘）。把插件拥有的开关塞进去会有两个问题：
 *   ① 页面把值回显给插件、插件再落盘，同一件事实就有了两个写入方；
 *   ② 用户在 SPW 配置页改完后，页面里那份旧快照可能在启动竞态里把它覆盖回去。
 * 所以沿用 `systemFonts` 的同一条路（`useSystemFonts.ts`）：只读注入成员，不回显、不持久化；
 * 插件侧在 `FoliaPlugin.onSettingsFromPage` 里把它们剥掉再落盘。
 *
 * ## v0.4.17 (issue #18 item 2)：`showPlaybackBar` 已经**不在**这里了
 *
 * 「显示播放条」的所有权搬到了页面侧（用户在播放页右下角菜单里改），于是它按上面 ①② 的判据反过来
 * 走出这里：`model/settings.ts` 的 store + `SettingsSnapshot` 持有它（`showPlaybackBar` /
 * `setShowPlaybackBar` / `DEFAULT_SHOW_PLAYBACK_BAR`）。插件仍然读旧 `config.json` 里的同名键入
 * 下发，但改名为**顶层注入成员 `showPlaybackBarLegacy`**，仅供 `applySnapshot` 在持久化树里没有该键
 * 时播种一次（见 `model/settings.ts` 的 `resolveShowPlaybackBar`）。
 * 所以本文件**不再导出** `SHOW_PLAYBACK_BAR_KEY` / `useShowPlaybackBar`：留着它们就等于留着一条
 * 读旧键、恒返回 fallback 的错路。
 *
 * 取值有两条路，与系统字体一致：先读 `getBridge().getSettings()` 已持有的快照（插件先读配置、
 * 后开窗，第一帧就有值），之后每次 `settings` 事件再更新（配置页改动走
 * `FoliaHostBridge.sendSettings` 热推送，无需重开窗口）。
 *
 * 一条**不带**该键的 payload 不会把已有值改回默认：页面自己发出的设置回显里没有这些键，
 * 那不是「用户把它们关掉了」的意思。 */
import { useEffect, useState } from 'react';
import { bridgeOn, getBridge } from '~/bridge';

/** 显示右上角救生圈问题按钮的控制键（与 `FoliaPlugin.SHOW_PROBLEM_BUTTON_KEY` 同一拼写）。 */
export const SHOW_PROBLEM_BUTTON_KEY = 'showProblemButton';
/** 歌词样式预览动画的控制键（与 `FoliaPlugin.PREVIEW_ANIMATION_KEY` 同一拼写）。 */
export const PREVIEW_ANIMATION_KEY = 'previewAnimation';

/** 各自的默认值：与引入开关之前的版本行为一致。 */
export const DEFAULT_SHOW_PROBLEM_BUTTON = false;
/** 默认开：关掉会让货架失去「真实渲染器小图」这个卖点，必须是用户主动选择。 */
export const DEFAULT_PREVIEW_ANIMATION = true;

type SettingsObject = Record<string, unknown>;

/** `getSettings()` 正常给对象，但宿主 shim 各版本也可能塞 JSON 字符串；两种都吃。 */
const parseSettingsPayload = (payload: unknown): SettingsObject | null => {
    if (!payload) return null;
    if (typeof payload === 'string') {
        const text = payload.trim();
        if (!text.startsWith('{')) return null;
        try {
            const parsed: unknown = JSON.parse(text);
            return parsed && typeof parsed === 'object' ? (parsed as SettingsObject) : null;
        } catch {
            return null;
        }
    }
    return typeof payload === 'object' ? (payload as SettingsObject) : null;
};

/** 顶层 `key`，以及（容错）快照里再嵌一层的 `settings.key`。 */
const candidates = (payload: unknown, key: string): unknown[] => {
    const source = parseSettingsPayload(payload);
    if (!source) return [];
    const values: unknown[] = [source[key]];
    const nested = parseSettingsPayload(source.settings);
    if (nested && nested !== source) values.push(nested[key]);
    return values;
};

/** 严格布尔：只有 `true` / `false` 算数，`"true"` 这类字符串按「没带」处理。 */
export const extractInjectedSwitch = (payload: unknown, key: string): boolean | null => {
    for (const candidate of candidates(payload, key)) {
        if (candidate === true) return true;
        if (candidate === false) return false;
    }
    return null;
};

/** 这份 payload 是否真的带了这个键（带 `null` 也算带，但不改变值）。 */
export const payloadCarriesInjectedSwitch = (payload: unknown, key: string): boolean =>
    candidates(payload, key).some(candidate => candidate !== undefined);

/** 直接从桥里读一次；桥不在（dev）或读失败都返回默认值，绝不抛。 */
export const readInjectedSwitchFromBridge = (key: string, fallback: boolean): boolean => {
    try {
        const value = extractInjectedSwitch(getBridge()?.getSettings?.(), key);
        return value === null ? fallback : value;
    } catch {
        return fallback;
    }
};

/**
 * 订阅式读取：一次初始快照 + 之后每次 `settings` 事件（不轮询）。
 *
 * [fallback] 必须是 `useState` 的初始值来源，不要在每次渲染时从别处算 —— hook 只会在挂载时
 * 读一次桥，之后的真源是 `settings` 事件。
 */
export const useInjectedSwitch = (key: string, fallback: boolean): boolean => {
    const [value, setValue] = useState<boolean>(() => readInjectedSwitchFromBridge(key, fallback));

    useEffect(() => {
        let alive = true;
        const apply = (payload: unknown): void => {
            if (!alive) return;
            const next = extractInjectedSwitch(payload, key);
            if (next === null) return;
            setValue(next);
        };

        // 先挂监听再读快照：两次读之间到达的那一条事件不会丢。
        const off = bridgeOn<unknown>('settings', apply);
        let initial: unknown = null;
        try {
            initial = getBridge()?.getSettings?.() ?? null;
        } catch {
            initial = null;
        }
        apply(initial);

        return () => {
            alive = false;
            off();
        };
    }, [key]);

    return value;
};

/** 播放页右上角「出现问题」救生圈按钮是否显示。 */
export const useShowProblemButton = (): boolean => useInjectedSwitch(SHOW_PROBLEM_BUTTON_KEY, DEFAULT_SHOW_PROBLEM_BUTTON);

/**
 * 歌词样式货架是否画实时动画小图。
 *
 * 这是一个**粗开关**：false 时调用方要连同 `import` 一起断掉渲染器链（见 `ShelfLive`），
 * 不是画出来再 `display:none`。热更新由 `settings` 事件驱动，配置页改完立刻生效。
 */
export const usePreviewAnimation = (): boolean => useInjectedSwitch(PREVIEW_ANIMATION_KEY, DEFAULT_PREVIEW_ANIMATION);

export default useInjectedSwitch;
