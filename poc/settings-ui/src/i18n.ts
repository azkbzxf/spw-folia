/* The zh-CN bundle is Folia's own locale data, so every kit label we reuse reads exactly like the
 * desktop app. Only the settings window is translated here; the bundle is static.
 *
 * v0.4.0: the plugin adds a few labels of its own (the font import flow, the player-chrome close
 * button). They live here in a small overlay instead of in `work/folia/…/zh-CN.ts`, because that
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
        /** v0.4.17 (issue #18 item 2): 「显示播放条」 moved off SPW's 配置 page into the player page's
         *  bottom-right settings menu, as one row of that panel. */
        showPlaybackBar: '显示播放条',
        /** v0.4.17: that panel now holds three unrelated switches, so it can no longer be named after
         *  the transparency switch alone ("透明背景" would be a lie for a screen reader). */
        playerPageSettings: '播放页设置',
        /** issue #22 item 1: 视觉样式 tab 顶部新增的「渲染」组。组标题是本页独有的（上游把这两行放在
         *  「动画与性能」页，那一页不注入），两个**行**的标签则复用上游已有的 key，不在这里重复。
         *  标题必须叫「全局渲染」而不是「渲染」：上游每个样式自己的面板里也有一个「渲染」组
         *  （`options.lyricRenderSection`），同名的两组会叠在同一个 tab 里，用户分不出哪个是全局挡位。 */
        renderGroup: '全局渲染',
        /** issue #22 item 2: 通用 tab 的两行文字颜色。上游没有任何「文字颜色」的 key，所以这一组全部
         *  是本页新增的。 */
        fontColor: '文字颜色',
        /** 「浅色」指的是**文字**本身，不是浅色外观 —— 中文里极易读反，所以 hint 直说配什么画面。 */
        fontColorHint: '浅色文字，适合深色画面',
        fontColorDesc: '只改歌词与字幕的文字颜色，不影响背景与封面色。跟随系统时，不透明窗口由封面明暗决定，'
            + '透明窗口跟随系统的深色/浅色模式。',
        fontColorLight: '浅色',
        fontColorDark: '深色',
        fontColorSystem: '跟随系统',
        transparentFontColor: '透明窗口下的文字颜色',
        transparentFontColorHint: '透明窗口时单独生效',
        transparentFontColorDesc: '透明窗口没有封面底色可依据，所以这一份单独设置；默认跟随系统，'
            + '与引入这个设置之前的行为一致。',
        /* issue #23 · 模组市场（Beta）。全部是本页新增的 key：上游 Folia 没有「市场」这个概念。
         * 每一条都必须同时出现在 `LOCAL_KEYS_EN` 里（那边的注释说明了为什么）。 */
        modMarket: '模组市场（Beta）',
        modMarketTitle: '模组市场',
        modMarketBetaBadge: 'Beta',
        modMarketSearch: '搜索名称或作者',
        modMarketInstalledSection: '已安装',
        modMarketInstalledEmpty: '还没有安装模组。装好后它会立刻出现在歌词样式货架上。',
        modMarketOfficial: '官方',
        modMarketCommunity: '社区',
        modMarketBeta: 'Beta',
        modMarketInstall: '安装',
        modMarketInstalling: '正在下载并安装……完成前不要关闭这个窗口。',
        modMarketUninstall: '卸载',
        modMarketEnable: '启用',
        modMarketDisable: '禁用',
        modMarketEnabled: '已启用',
        modMarketDisabled: '已禁用',
        modMarketInstalled: '已安装',
        modMarketPermissions: '声明的权限数',
        modMarketUnverifiable: '这份 catalog 没有提供校验值，按我们的规矩不提供安装按钮',
        modMarketUnverifiableShort: '无法校验',
        modMarketOpenFolder: '打开模组文件夹',
        modMarketLoading: '正在读取市场…',
        modMarketLoadingHint: '正在读取市场清单……（离线时下方仍会列出已安装的模组）',
        modMarketReady: '已连接市场',
        modMarketFromCache: '市场清单（缓存）',
        modMarketEmpty: '市场是空的',
        modMarketEmptyHint: '市场清单里没有可显示的模组。已安装的模组仍然可用。',
        modMarketOffline: '离线',
        modMarketOfflineHint: '连不上市场，只列出已安装的模组。这不是「市场里没有模组」。',
        modMarketRetry: '重试',
        modMarketFooter: '模组由第三方提供，未经验证；安装前请自行判断。',
    },
} as const;

/** en overlay for the same keys. Folia's upstream bundle is keyed in English already, but this
 *  overlay wins for the two strings above (the merge is shallow per namespace, ours last). */
const LOCAL_KEYS_EN = {
    options: {
        showPlaybackBar: 'Show playback bar',
        playerPageSettings: 'Player page settings',
        renderGroup: 'Global rendering',
        fontColor: 'Text colour',
        fontColorHint: 'Light text, for dark artwork',
        fontColorDesc: 'Changes the colour of lyrics and subtitles only — not the background or the cover palette. '
            + 'On System, an opaque window follows the cover\'s brightness and a transparent one follows the OS theme.',
        fontColorLight: 'Light',
        fontColorDark: 'Dark',
        fontColorSystem: 'System',
        transparentFontColor: 'Text colour while transparent',
        transparentFontColorHint: 'Applies to the transparent window only',
        transparentFontColorDesc: 'A transparent window has no cover colour to derive from, so its text colour is '
            + 'chosen separately. System keeps the behaviour from before this setting existed.',
        modMarket: 'Mod market (Beta)',
        modMarketTitle: 'Mod market',
        modMarketBetaBadge: 'Beta',
        modMarketSearch: 'Search name or author',
        modMarketInstalledSection: 'Installed',
        modMarketInstalledEmpty: 'No mods installed yet. An installed mod shows up on the lyric-style shelf right away.',
        modMarketOfficial: 'Official',
        modMarketCommunity: 'Community',
        modMarketBeta: 'Beta',
        modMarketInstall: 'Install',
        modMarketInstalling: 'Downloading and installing… keep this window open until it finishes.',
        modMarketUninstall: 'Uninstall',
        modMarketEnable: 'Enable',
        modMarketDisable: 'Disable',
        modMarketEnabled: 'Enabled',
        modMarketDisabled: 'Disabled',
        modMarketInstalled: 'Installed',
        modMarketPermissions: 'Declared permissions',
        modMarketUnverifiable: 'This catalog entry carries no checksum, so we offer no install button',
        modMarketUnverifiableShort: 'Unverifiable',
        modMarketOpenFolder: 'Open mod folder',
        modMarketLoading: 'Reading the market…',
        modMarketLoadingHint: 'Reading the market catalog… installed mods are listed below either way.',
        modMarketReady: 'Market connected',
        modMarketFromCache: 'Market catalog (cached)',
        modMarketEmpty: 'The market is empty',
        modMarketEmptyHint: 'The catalog lists no displayable mods. Installed mods keep working.',
        modMarketOffline: 'Offline',
        modMarketOfflineHint: 'Cannot reach the market, so only installed mods are listed. This does not mean the market has none.',
        modMarketRetry: 'Retry',
        modMarketFooter: 'Mods come from third parties and are unverified; judge before you install.',
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
 * `options.importFontPack` / `options.fontPreviewSample` text in the font section. Re-apply the
 * overlay (deep, overwriting) once every module in the graph has settled, and again whenever the
 * language changes, so the labels survive either order. */
const applyLocalKeys = (): void => {
    for (const language of ['zh-CN', 'en']) {
        i18n.addResourceBundle(language, 'translation', LOCAL_KEYS as ResourceLanguage, true, true);
    }
    // The en strings are a full bundle over `LOCAL_KEYS`'s zh-CN one: the same key set, translated.
    i18n.addResourceBundle('en', 'translation', LOCAL_KEYS_EN as ResourceLanguage, true, true);
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
