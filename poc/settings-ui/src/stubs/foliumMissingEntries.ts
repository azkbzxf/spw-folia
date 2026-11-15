/* issue #23 · 「存着的模组样式，但那个模组现在用不了」的唯一出口。
 *
 * ## 为什么这个文件必须是真的
 *
 * 上游 `VisPlaygroundSettingsPanel.tsx:223,237-242` 用 `useMissingFoliumSelections()` 画一行提示：
 *
 *     const missing = missingFoliumSelections.find(entry => entry.kind === kind);
 *     return missing ? t('options.foliumMissingSelection').replace('{{modId}}', missing.modId) : null;
 *
 * 也就是说：**选了 `mod:<id>:<viz>`、但那个模组被卸载或禁用时，用户能看到的唯一解释就从这里来。**
 * 桩返回空数组的后果不是「少一行提示」，而是「样式静默跳回内置」—— 用户只看到画面变了，无从知道
 * 为什么、也无从知道该去装回哪个模组。这类静默失效正是本仓库明令禁止的（`docs/known-inert-settings.md`）。
 *
 * ## 真相源
 *
 * 上游的实现读 localStorage 里的 `visualizer_mode`，并在 `hasVisualizerMode()` 判假时报缺失。本页
 * 不能照抄：注入岛里的选择存在自己的 zustand store 里（`visualizerMode` + `modVisualizerMode`），
 * 而「模组装没装、启用没启用」由插件注入的 `mods` 成员说了算（页面没有第二份真相）。所以判据是：
 *
 *     当前 store 选了 `mod:<id>:<viz>`  **且**  该 id 不在「已装且启用」的清单里  ⇒ 报缺失
 *
 * 注意**不能**反过来判「这个 mode 有没有注册」：设置岛是独立 bundle，读不到播放页那个上游 registry
 * 实例，页面里根本没有「注册表」这个概念。用「模组清单」判定既准确又不依赖跨 bundle 状态。
 *
 * ## 契约
 *
 * 签名与上游 `mods/runtime/missingEntries.ts` 的 `MissingFoliumSelection` 完全一致（本文件被
 * `vite.config.ts:39` 的 STUB_RULES 顶到那个模块路径上，类型必须能顶替）。只报 `visualizer`：v2 不
 * 涉及模组背景，`background` 一条永远不会出现。
 */
import { useEffect, useState } from 'react';
import { effectiveVisualizerMode, useSettingsStore } from '~/model/settings';
import {
    EMPTY_MISSING_SELECTIONS,
    readMissingFoliumSelections,
    type MissingFoliumSelection,
} from '~/model/modStyles';
import type { ModStyleMode } from '~/model/modStyles';
import { useInjectedMods } from '~/model/useInjectedMods';

export type { MissingFoliumSelection };
export { readMissingFoliumSelections };

const EMPTY: MissingFoliumSelection[] = EMPTY_MISSING_SELECTIONS;

/**
 * 选了模组样式、但那个模组已经卸载或禁用：返回一条缺失记录，否则空数组。
 *
 * 判据全在 `model/modStyles.ts` 的 `readMissingFoliumSelections` 里（纯函数，门禁与探针直接驱动它）。
 * 这个 hook 只负责把「当前选择 + 已装清单」两路输入接起来。
 *
 * 每次都返回**同一个空数组引用**（模块级 `EMPTY`），避免上游那些 `useMemo` 依赖每次渲染都变。
 */
export const useMissingFoliumSelections = (): MissingFoliumSelection[] => {
    const mods = useInjectedMods();
    /* 用 selector 而不是整个 store：上游面板在滑动条拖动时每帧都会重渲染，这里只关心两个字段。 */
    const visualizerMode = useSettingsStore(state => state.visualizerMode);
    const modVisualizerMode = useSettingsStore(state => state.modVisualizerMode);

    const effective = effectiveVisualizerMode({
        visualizerMode,
        modVisualizerMode: modVisualizerMode as ModStyleMode | null,
    });

    /* 结果按「两个输入」缓存：同一个 mode 与同一份清单必须给出同一个数组，否则上游那个
     * `useMemo([..., missingFoliumSelections])` 会每帧失效。`useInjectedMods` 每次 settings 事件都
     * 给新数组，所以这里用「长度 + 缺失的 mode」当指纹，而不是引用相等。 */
    const [snapshot, setSnapshot] = useState<MissingFoliumSelection[]>(EMPTY);
    useEffect(() => {
        const next = readMissingFoliumSelections(effective, mods);
        setSnapshot(current => {
            if (current.length === next.length && current.every((item, index) => item.mode === next[index].mode)) {
                return current;
            }
            return next.length === 0 ? EMPTY : next;
        });
    }, [effective, mods]);

    return snapshot;
};

export default useMissingFoliumSelections;
