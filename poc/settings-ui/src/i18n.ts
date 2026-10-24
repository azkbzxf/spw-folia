/* The zh-CN bundle is Folia's own locale data, so every kit label we reuse reads exactly like the
 * desktop app. Only the settings window is translated here; the bundle is static.
 *
 * v0.4.0: the plugin adds a few labels of its own (the live-lyric preview choice, the font import
 * flow). They live here in a small overlay instead of in `work/folia/…/zh-CN.ts`, because that
 * checkout is pristine upstream source — editing it would surface as a diff on the next sync for a
 * string that only this window ever shows. Keys already present upstream must NOT be repeated
 * here, or the overlay silently wins over Folia's own wording. */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../../work/folia/folia-major-main/src/i18n/locales/zh-CN';
import type { ResourceLanguage } from 'i18next';

/** Labels this plugin needs that Folia 0.7.22 has no string for. */
const LOCAL_KEYS = {
    options: {
        /** The font preview text: the lyric line playing at this moment. */
        previewTextCurrent: '当前歌词',
        /** Font picker: the two ways of choosing a custom lyrics font. */
        importFontPack: '导入字体包',
        importFontPackDesc: '支持 .ttf/.otf/.woff/.woff2，最大 50 MB',
        systemFontList: '系统字体',
        systemFontSearch: '搜索字体',
        systemFontEmpty: '没有找到匹配的字体',
        systemFontLoading: '正在读取系统字体…',
        uploadedFontList: '已导入的字体',
        uploadedFontEmpty: '还没有导入字体包',
        fontPreviewSample: '永和九年，岁在癸丑',
        fontImportFailed: '字体导入失败',
        fontRemove: '移除',
        chooseSystemFontEmpty: '这台电脑上没有可用的系统字体列表',
        /** v0.4.0: top-left close button on the player chrome (mirror of the top-right gear). */
        closePlayer: '退出 Folia',
    },
} as const;

/** Shallow merge of one namespace's keys over the upstream bundle. */
const mergeLocale = (base: ResourceLanguage, extra: ResourceLanguage): ResourceLanguage => {
    const merged: ResourceLanguage = { ...base };
    for (const [namespace, values] of Object.entries(extra)) {
        const existing = merged[namespace];
        merged[namespace] = typeof existing === 'object' && existing !== null
            ? { ...(existing as ResourceLanguage), ...(values as ResourceLanguage) }
            : values;
    }
    return merged;
};

void i18n.use(initReactI18next).init({
    resources: { 'zh-CN': { translation: mergeLocale(zhCN as ResourceLanguage, LOCAL_KEYS as ResourceLanguage) } },
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    interpolation: { escapeValue: false },
    returnNull: false,
    initImmediate: false,
});

/* v0.4.0: Folia's own `i18n/config.ts` is in this bundle too (the reused visualizer panels import it
 * transitively), and it calls `i18n.init()` with its own resource map a second time. Whichever init
 * runs last owns the resource store, so the overlay above can be dropped — which showed up as raw
 * `options.previewTextCurrent` / `options.fontPreviewSample` text in the font section. Re-apply the
 * overlay (deep, overwriting) once every module in the graph has settled, and again whenever the
 * language changes, so the labels survive either order. */
const applyLocalKeys = (): void => {
    for (const language of ['zh-CN', 'en']) {
        i18n.addResourceBundle(language, 'translation', LOCAL_KEYS as ResourceLanguage, true, true);
    }
};

applyLocalKeys();
i18n.on('initialized', applyLocalKeys);
i18n.on('languageChanged', applyLocalKeys);
// The injected page is zh-CN only (the plugin's own copy is Chinese): pin it instead of whatever
// Folia's language detector guesses from the host page.
window.setTimeout(() => {
    applyLocalKeys();
    if (i18n.resolvedLanguage !== 'zh-CN') void i18n.changeLanguage('zh-CN');
}, 0);

export default i18n;
