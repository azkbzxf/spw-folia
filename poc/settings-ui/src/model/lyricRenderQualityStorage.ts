/* #929 / issue #22 item 1: 把本页 store 里的「歌词画布分辨率 / 抗锯齿」全局挡位镜像进 Folia 自己的
 * localStorage 键。
 *
 * 为什么需要这一步（两件事，别混）：
 *  1. **本次运行生效**靠的是 `publisher/config.ts` 里的物化：播放页的渲染器只从 config 里读各样式 tuning
 *     的 `render` 覆盖，**不读** config 里的全局挡位（上游 `ObsBrowserSourceConfig` 里没有这个字段）。
 *     所以改完立刻生效必须走发布层。
 *  2. **下次开窗一致**靠这里：Folia 自己的 store（`useVisualizerSettingsStore`）初始值来自
 *     `localStorage['lyric_render_quality']`。设置岛与播放页同一个 document、同一个 origin，可以直接写，
 *     于是用户改完的挡位下次开窗仍是同一个，而不是被播放页的默认值顶回去。
 *
 * 注意写入时机：Folia 的 store 在本页模块加载时就已读过这个键，所以这里**不能**让当前这次运行生效
 * （那是 (1) 的职责），它只是把值留给下一次初始化。
 *
 * 键名取上游常量，不硬编码字符串：上游改名时构建期就会炸，而不是悄悄写到一个没人读的键上。
 */
import { LYRIC_RENDER_QUALITY_STORAGE_KEY } from '@/utils/lyricRenderQuality';
import type { LyricRenderQuality } from '@/types';
import { useSettingsStore } from './settings';

/** 把一组挡位写进 Folia 的存储键。localStorage 在某些沙箱/隐私设置下会抛，写失败不影响设置页本身。 */
const writeQuality = (value: LyricRenderQuality): void => {
    try {
        localStorage.setItem(LYRIC_RENDER_QUALITY_STORAGE_KEY, JSON.stringify(value));
    } catch (error) {
        console.warn('[settings-ui] 歌词画布挡位写入 localStorage 失败', error);
    }
};

/**
 * 立刻写一次（把设置树里的值同步过去），并在此后每次挡位变化时再写。
 * 返回取消订阅的函数，调用方在卸载时用。
 */
export const installLyricRenderQualityMirror = (): (() => void) => {
    writeQuality(useSettingsStore.getState().lyricRenderQuality);
    let previous = useSettingsStore.getState().lyricRenderQuality;
    return useSettingsStore.subscribe(state => {
        const next = state.lyricRenderQuality;
        // 只有真的换了挡位才写：store 里任何字段变化都会回调，逐次 stringify 一个固定值没有意义。
        if (next === previous) return;
        previous = next;
        writeQuality(next);
    });
};
