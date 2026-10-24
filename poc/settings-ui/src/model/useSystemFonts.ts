/* 系统字体：插件（Kotlin 侧）枚举本机已安装的字体族，然后以 `systemFonts: string[]` 的形式注入
 * 到设置树里。注入式设置页跑在 WebView2 里，自己拿不到这份列表——`queryLocalFonts()` 只在顶层文档
 * 且用户授权后可用，而这里是被 Folia 播放页嵌进去的同一个文档。
 *
 * 取值有两条路：启动时先读 `getBridge().getSettings()` 已经持有的快照（插件先枚举、后开窗时列表
 * 立刻就在），之后每次 `settings` 事件再更新（宿主侧的枚举是异步的，列表常常晚一班车才到）。
 *
 * 一条不带 `systemFonts` 键的 payload 绝不会清空已有列表：本页自己发出的设置快照里没有这个键，
 * 它被宿主回显时会走同一条 `settings` 通道，那不是“系统没有字体”的意思。
 *
 * v0.4.0：自定义歌词字体需要这份列表（`FontPickerModal` 的“系统字体”一节）。 */
import { useEffect, useState } from 'react';
import { bridgeOn, getBridge } from '~/bridge';

/** 设置树里系统字体列表的键名（与插件侧约定的契约）。 */
export const SYSTEM_FONTS_KEY = 'systemFonts';

/** 还没收到列表时等多久才承认“本机读不到字体”，以免第一帧就闪一下空状态。 */
const READY_GRACE_MS = 1500;

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

/** 顶层 `systemFonts`，以及（容错）快照里再嵌一层的 `settings.systemFonts`。 */
const systemFontCandidates = (payload: unknown): unknown[] => {
    const source = parseSettingsPayload(payload);
    if (!source) return [];
    const values: unknown[] = [source[SYSTEM_FONTS_KEY]];
    const nested = parseSettingsPayload(source.settings);
    if (nested && nested !== source) values.push(nested[SYSTEM_FONTS_KEY]);
    return values;
};

/** 拉丁字母开头的排前面（Inter、Microsoft YaHei…），中日韩名在后面按 zh-Hans-CN 排。 */
const LEADING_LATIN = /^[\u0000-\u024f]/;

export const compareSystemFontNames = (a: string, b: string): number => {
    const aLatin = LEADING_LATIN.test(a);
    const bLatin = LEADING_LATIN.test(b);
    if (aLatin !== bLatin) return aLatin ? -1 : 1;
    return a.localeCompare(b, 'zh-Hans-CN');
};

/** 去空、去重（大小写不敏感）、排序；不是字符串数组一律当成没有。 */
export const normalizeSystemFontNames = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const name = item.trim();
        if (!name) continue;
        const key = name.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names.sort(compareSystemFontNames);
};

/** 从任意一份设置 payload 里取系统字体；没有就是 `[]`。 */
export const extractSystemFonts = (payload: unknown): string[] => {
    for (const candidate of systemFontCandidates(payload)) {
        if (Array.isArray(candidate)) return normalizeSystemFontNames(candidate);
    }
    return [];
};

/** 这份 payload 是否真的带了 `systemFonts`（哪怕是空数组）。没带就不能覆盖现有列表。 */
export const payloadCarriesSystemFonts = (payload: unknown): boolean =>
    systemFontCandidates(payload).some(candidate => candidate !== undefined);

/** 直接从桥里读一次；桥不在（dev）或读失败都返回 `[]`，绝不抛。 */
export const readSystemFontsFromBridge = (): string[] => {
    try {
        const settings = getBridge()?.getSettings?.();
        return extractSystemFonts(settings);
    } catch {
        return [];
    }
};

export interface SystemFontsState {
    fonts: string[];
    /** 已经拿到过一份列表（哪怕是空数组），或宽限期已过：空状态与加载中由此区分。 */
    ready: boolean;
}

/** 订阅式读取：一次初始快照 + 之后每次 `settings` 事件（不轮询）。 */
export const useSystemFontsState = (): SystemFontsState => {
    const [fonts, setFonts] = useState<string[]>([]);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let alive = true;
        const apply = (payload: unknown): void => {
            if (!alive || !payloadCarriesSystemFonts(payload)) return;
            setFonts(extractSystemFonts(payload));
            setReady(true);
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
        if (!payloadCarriesSystemFonts(initial)) {
            // 还没等到列表：给宿主枚举留一点时间，再承认是空的。
            window.setTimeout(() => {
                if (alive) setReady(true);
            }, READY_GRACE_MS);
        }

        return () => {
            alive = false;
            off();
        };
    }, []);

    return { fonts, ready };
};

/** `FontPickerModal` / 设置面板要的那份列表。 */
export const useSystemFonts = (): string[] => useSystemFontsState().fonts;

export default useSystemFonts;
