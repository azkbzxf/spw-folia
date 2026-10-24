// Vite config for the injected spw-folia settings UI.
//
// The UI is a React island on top of Folia's own settings-kit components: it imports them straight
// out of the Folia checkout (work/folia/folia-major-main/src) instead of copying them, so the
// injected page looks exactly like Folia's own 歌词样式 window. Everything that Folia's components
// touch outside a browser (stores, registries, analysis models) is mapped to a stub under ./src/stubs
// by the `folia-stubs` plugin: the stubs keep the same selector/return shapes but read from this
// page's own settings store.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, '../..');
const foliaSrc = path.join(workspaceRoot, 'work/folia/folia-major-main/src');
const stubs = path.join(here, 'src/stubs');

/** Folia module specifier -> stub file. Applied only when the importer is a Folia source file. */
const STUB_RULES: Array<[RegExp, string]> = [
    // Tail-matched on purpose: Folia imports these both through '@/...' and through relative
    // specifiers, so the patterns cannot assume a full path from src/.
    [/useVisualizerSettingsStore$/, 'useVisualizerSettingsStore.ts'],
    [/usePlayerChromeSettingsStore$/, 'usePlayerChromeSettingsStore.ts'],
    [/useVisualizerAssetStore$/, 'useVisualizerAssetStore.ts'],
    [/useStatusMessageStore$/, 'useStatusMessageStore.ts'],
    [/useThemeSettingsStore$/, 'useThemeSettingsStore.ts'],
    [/useSmartBeatAvailability$/, 'useSmartBeatAvailability.ts'],
    [/services\/analysis\/modelAvailability$/, 'modelAvailability.ts'],
    [/visualizer\/backgrounds\/registry$/, 'backgrounds.tsx'],
    [/(?:^|\/)backgrounds\/registry$/, 'backgrounds.tsx'],
    [/preview\/BackgroundPicture$/, 'BackgroundPicture.tsx'],
    [/mods\/folium\/registries\/tunings$/, 'foliumTunings.tsx'],
    [/mods\/folium\/registries\/backgrounds$/, 'foliumBackgrounds.tsx'],
    [/mods\/folium\/registries\/visualizers$/, 'foliumVisualizers.ts'],
    [/mods\/runtime\/registry$/, 'foliumRuntime.ts'],
    [/mods\/runtime\/missingEntries$/, 'foliumMissingEntries.ts'],
    [/services\/temperaImageArchive$/, 'temperaImageArchive.ts'],
    [/visualizer\/tempera\/TemperaImageLayerDialog$/, 'TemperaImageLayerDialog.tsx'],
    // Local-file pipelines: the injected page has no local library, no tag parser worker and no
    // IndexedDB image cache, but some settings panels import their helpers transitively.
    [/localMetadataWorkerClient$/, 'localMetadataWorkerClient.ts'],
    [/lyrics\/workerClient$/, 'lyricsWorkerClient.ts'],
    [/lyrics\/parserCore$/, 'lyricsParserCore.ts'],
    [/services\/db$/, 'db.ts'],
    // Online-music adapters: every provider imports a Node-only SDK and the registry is the one
    // module that pulls all of them in. The settings window never plays music — the host does.
    [/services\/onlineMusic\/providerRegistry$/, 'onlineMusicProviderRegistry.ts'],
    [/services\/localCoverAssetService$/, 'localCoverAssetService.ts'],
    [/services\/localMusicService$/, 'localMusicService.ts'],
];

const foliaSrcPosix = foliaSrc.replace(/\\/g, '/');

/** Folia serves two generated modules through Vite virtual ids: the zh-TW bundle and the command
 *  palette's pinyin dictionary. 0.7.22's reused pages import both transitively (i18n/config.ts and
 *  the command registry the settings window pulls in), so their generators have to run here too.
 *  Both are plain Node ESM with no Folia `@/` imports, so they are imported straight from the
 *  checkout. */
const FOLIA_DEV = path.join(workspaceRoot, 'work/folia/folia-major-main/dev');
const foliaVirtualModules = async (): Promise<Plugin[]> => {
    const { traditionalLocalePlugin } = await import(`file://${path.join(FOLIA_DEV, 'i18n/traditionalLocalePlugin.mjs').replace(/\\/g, '/')}`);
    const { commandPinyinPlugin } = await import(`file://${path.join(FOLIA_DEV, 'pinyin/commandPinyinPlugin.mjs').replace(/\\/g, '/')}`);
    return [traditionalLocalePlugin(), commandPinyinPlugin()];
};

const foliaStubs = (): Plugin => ({
    name: 'spw-folia-stubs',
    enforce: 'pre',
    resolveId(source, importer) {
        // Ids reach this hook with forward slashes on every platform; compare in that form.
        if (!importer) return null;
        const importerPosix = importer.replace(/\\/g, '/');
        if (!importerPosix.startsWith(foliaSrcPosix)) return null;
        // Sibling imports (`./parserCore` from utils/lyrics/*) carry no directory part, so the rules
        // are matched against the importer-relative target as well as the raw specifier.
        const sibling = source.startsWith('.')
            ? path.posix.normalize(path.posix.join(path.posix.dirname(importerPosix), source.replace(/\\/g, '/')))
            : source;
        for (const [pattern, file] of STUB_RULES) {
            if (pattern.test(source) || pattern.test(sibling)) {
                return path.join(stubs, file);
            }
        }
        return null;
    },
});

/** Injects the built CSS into the entry module: the host adds only one <script> tag, so a separate
 *  stylesheet would never be requested — the window must carry its own styles. */
const inlineCssIntoEntry = (): Plugin => ({
    name: 'spw-inline-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
        const cssKeys = Object.keys(bundle).filter(key => key.endsWith('.css'));
        if (cssKeys.length === 0) return;
        const css = cssKeys
            .map(key => {
                const asset = bundle[key];
                return asset && asset.type === 'asset' ? String(asset.source) : '';
            })
            .join('\n');
        for (const key of cssKeys) delete bundle[key];
        for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
            chunk.code = `(function(){if(typeof document==='undefined')return;if(document.querySelector('style[data-spw-settings-ui-css]'))return;var s=document.createElement('style');s.setAttribute('data-spw-settings-ui-css','');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);})();\n${chunk.code}`;
        }
    },
});

/** The Folia checkout under work/ is a bare source tree: it has no node_modules of its own, so Vite
 *  resolves nothing bare from inside it. Up to v0.3.x the reused panels only imported a handful of
 *  packages that resolved through the aliases; 0.7.22's style previews pull in the whole visualizer
 *  registry (three.js, pixi.js, …) plus the two dev/ generators, so the checkout needs a real
 *  dependency root. `work/` is a local, gitignored checkout, so the link is part of the local build
 *  setup and is (re)created on demand. */
const ensureFoliaDeps = () => {
    const link = path.join(workspaceRoot, 'work/folia/folia-major-main/node_modules');
    if (fs.existsSync(link)) return;
    try {
        fs.symlinkSync(path.join(here, 'node_modules'), link, 'junction');
    } catch (error) {
        throw new Error(
            `[spw-folia] could not link Folia's dependencies (${link} -> ${path.join(here, 'node_modules')}): ${String(error)}`,
        );
    }
};

const debugWhoImports = (): Plugin => ({
    name: 'spw-debug-importer',
    enforce: 'pre',
    resolveId(source, importer) {
        const pattern = process.env.SPW_DEBUG_IMPORTERS;
        if (pattern && new RegExp(pattern).test(source)) {
            console.log('[importer]', source, '<-', importer);
        }
        return null;
    },
});

/** Applies spw-folia's v0.1.3 settings surgery to the reused Folia panels.
 *
 *  The injected page cannot provide several things Folia's desktop app assumes, so the controls that
 *  could never take effect are removed at build time instead of being shown as dead switches:
 *
 *  A. beat-driven animation (beat_this / htdemucs WebGPU models are not in the page, and the host
 *     sends no beat events): 智能动感模式 card, 动感效果 card, 和声字幕 group (no harmony data), and
 *     the 罗马音 subtitle content modes (translation is the only lyric sub-text the plugin sends).
 *  B. uploads / custom media (no local file services, no IndexedDB asset store): custom font choice,
 *     背景 URL image mode, and the tempera / monet / cappella image upload controls.
 *
 *  Every removal is marker-checked: if a future Folia update changes a panel the build fails instead
 *  of silently shipping a dead control again. */
interface SettingsSurgery {
    what: string;
    find: string | RegExp;
    replace: string;
}

interface SettingsSurgeryFile {
    /** Tail of the module id, slash-separated, relative to Folia's src/. */
    suffix: string;
    edits: SettingsSurgery[];
}

const SMART_BEAT_REVEAL = '{/* spw-folia v0.1.3: 智能动感模式开关已移除 — 注入页没有节拍分析模型（A1）。 */}';

const SETTINGS_SURGERY: SettingsSurgeryFile[] = [
    {
        suffix: '/components/visualizer/window/VisPlaygroundSettingsPanel.tsx',
        edits: [
            // 0.7.22 moved the card into a fifth 全局 tab; the tab itself goes too (surgery below),
            // so the card's own line is dropped and nothing renders for `global` any more.
            {
                what: 'SmartBeatSettingsCard element',
                find: '                    {activeSection === \'global\' && <SmartBeatSettingsCard t={t} />}\n',
                replace: '',
            },
            {
                what: 'global tab option',
                find: "const SECTION_OPTIONS: VisPlaygroundEditSection[] = ['visualizer', 'background', 'common', 'subtitle', 'global'];",
                replace: "const SECTION_OPTIONS: VisPlaygroundEditSection[] = ['visualizer', 'background', 'common', 'subtitle'];",
            },
            {
                what: 'SmartBeatSettingsCard import',
                find: /^import SmartBeatSettingsCard from '[^']*';\r?\n/m,
                replace: '',
            },
            {
                what: 'BeatEffectsGroup element',
                find: '                                {/* Its 智能动感模式 effects, each named, switched and scaled on its own. */}\n                                <BeatEffectsGroup\n                                    t={t}\n                                    effects={visualizerEntry.beatEffects}\n                                    onSliderPointerDown={onSliderPointerDown}\n                                    onSliderCommit={onSliderCommit}\n                                    onOpenSmartBeat={() => onSectionChange(\'global\')}\n                                />\n',
                replace: '',
            },
            {
                what: 'BeatEffectsGroup import',
                find: /^import BeatEffectsGroup from '[^']*';\r?\n/m,
                replace: '',
            },
            {
                what: 'background registry URL filter',
                find: '        VISUALIZER_BACKGROUND_REGISTRY.map(entry => ({',
                replace: "        VISUALIZER_BACKGROUND_REGISTRY.filter(entry => entry.mode !== 'url').map(entry => ({",
            },
            {
                what: 'romanization subtitle content options',
                find: "                                            { label: t('options.subtitleContentRomanization'), value: 'romanization' },\n                                            { label: t('options.subtitleContentBoth'), value: 'both' },\n",
                replace: '',
            },
            // v0.4.0: the 当前字体 row is KEPT. In 0.7.22 it is the only place the panel surfaces the
            // chosen family and a 选择自定义字体 button, and the shell now opens its own picker when
            // `onFontStyleChange('custom')` fires — the reveal is exactly the hook for that.
            {
                what: 'harmony subtitle group',
                find: "                            <Group def={HARMONY_GROUP}>\n                                <ToggleRow\n                                    label={t('options.showHarmonySubtitle')}\n                                    note={t('options.showHarmonySubtitleDesc')}\n                                    checked={showHarmonySubtitle}\n                                    disabled={!onToggleShowHarmonySubtitle}\n                                    onChange={next => onToggleShowHarmonySubtitle?.(next)}\n                                />\n                                <Reveal when={showHarmonySubtitle}>\n                                    <ToggleRow\n                                        sub\n                                        label={t('options.harmonySubtitleBackground')}\n                                        note={t('options.harmonySubtitleBackgroundDesc')}\n                                        checked={harmonySubtitleBackground}\n                                        disabled={!onToggleHarmonySubtitleBackground}\n                                        onChange={next => onToggleHarmonySubtitleBackground?.(next)}\n                                    />\n                                </Reveal>\n                            </Group>\n",
                replace: '',
            },
            // v0.4.1 真实预览: the stage always previews the song that is playing, so the 预览文本
            // choice (placeholder songs) has no meaning any more. Remove the row and the plumbing the
            // reused panel would otherwise require from App.tsx.
            {
                what: 'preview text import',
                find: /^import \{ type PreviewPlaceholderId \} from '[^']*';\r?\n/m,
                replace: '',
            },
            {
                what: 'preview text props',
                find: '    previewPlaceholderId: PreviewPlaceholderId;\n    previewPlaceholderOptions: PresetOption<PreviewPlaceholderId>[];\n    onPreviewPlaceholderChange: (id: PreviewPlaceholderId) => void;\n',
                replace: '',
            },
            {
                what: 'preview text destructure',
                find: '        previewPlaceholderId,\n        previewPlaceholderOptions,\n        onPreviewPlaceholderChange,\n',
                replace: '',
            },
            {
                what: 'preview text reset call',
                find: "                    onPreviewPlaceholderChange('default');\n",
                replace: '',
            },
            {
                what: 'preview text row',
                find: "                            <Row label={t('options.previewText')}>\n                                <Segmented value={previewPlaceholderId} options={previewPlaceholderOptions} onChange={onPreviewPlaceholderChange} />\n                            </Row>\n",
                replace: '',
            },
        ],
    },
    {
        suffix: '/components/visualizer/tempera/TemperaSettingsPanel.tsx',
        edits: [
            {
                what: 'tempera image layer group',
                find: '            <Group def={IMAGE_GROUP}>\n                <TemperaImageLayerControls\n                    images={temperaTuning.layerImages}\n                    depth={temperaTuning.layerImageDepth}\n                    frequency={temperaTuning.layerImageFrequency}\n                    rangeInputClass={rangeInputClass}\n                    isDaylight={isDaylight}\n                    onCommit={patch => onTemperaTuningChange?.(patch)}\n                />\n            </Group>\n\n',
                replace: '',
            },
            {
                what: 'TemperaImageLayerControls import',
                find: /^import TemperaImageLayerControls from '[^']*';\r?\n/m,
                replace: '',
            },
        ],
    },
    {
        suffix: '/components/visualizer/monet/MonetSettingsPanel.tsx',
        edits: [
            {
                what: 'monet custom portrait source option',
                find: "                            {\n                                value: 'custom',\n                                label: t('options.monetPortraitSourceCustom'),\n                                disabled: !monetPortraitImage && !isLoadingMonetPortraitImage,\n                            },\n",
                replace: '',
            },
            {
                what: 'monet portrait upload row',
                find: "                <Row\n                    label={t('options.monetUploadPortrait')}\n                    hint={feedback || monetPortraitImage?.name || '-'}\n                >\n                    <Button\n                        icon={ImagePlus}\n                        onClick={() => fileInputRef.current?.click()}\n                        disabled={isLoadingMonetPortraitImage || !onUploadMonetPortraitImage}\n                    >\n                        {t('options.monetUploadPortrait')}\n                    </Button>\n                    <Button\n                        icon={Trash2}\n                        onClick={() => void onClearMonetPortraitImage?.()}\n                        disabled={!monetPortraitImage || !onClearMonetPortraitImage}\n                    >\n                        {t('options.monetClearPortrait')}\n                    </Button>\n                    <input\n                        ref={fileInputRef}\n                        type=\"file\"\n                        accept=\".png,.jpg,.jpeg,.gif,.webp,.svg,image/*\"\n                        className=\"hidden\"\n                        onChange={(event) => void handleFileChange(event)}\n                    />\n                </Row>\n",
                replace: '',
            },
        ],
    },
    {
        suffix: '/components/visualizer/settingsPanels.tsx',
        edits: [
            {
                what: 'cappella custom avatar source option',
                find: "                            { value: 'custom', label: t('options.cappellaAvatarSourceCustom'), disabled: !hasCappellaCustomAvatar },\n",
                replace: '',
            },
            {
                what: 'cappella avatar upload row',
                find: "            <Row\n                label={t('options.cappellaAvatarPreview')}\n                hint={hasCappellaCustomAvatar\n                    ? `${t('options.cappellaEmojiCount')} ${cappellaCustomAvatarImages.length}`\n                    : t('options.cappellaAvatarUploadHint')}\n                below={<CappellaImageSlots round images={cappellaCustomAvatarImages} emptyName={t('options.cappellaEmojiEmptySlot')} />}\n            >\n                <Button onClick={handleAvatarImportClick} disabled={isImportingAvatar || isCappellaCustomAvatarLoading}>\n                    {isImportingAvatar ? t('options.cappellaAvatarUploading') : t('options.cappellaAvatarUpload')}\n                </Button>\n                <Button\n                    onClick={() => void handleClearCustomAvatar()}\n                    disabled={!hasCappellaCustomAvatar || isImportingAvatar || isCappellaCustomAvatarLoading}\n                >\n                    {t('options.cappellaAvatarClear')}\n                </Button>\n                <input\n                    ref={avatarFileInputRef}\n                    type=\"file\"\n                    accept=\".png,.jpg,.jpeg,.gif,.webp,.svg,image/*\"\n                    multiple\n                    className=\"hidden\"\n                    onChange={(event) => void handleAvatarFileChange(event)}\n                />\n            </Row>\n",
                replace: '',
            },
            {
                what: 'cappella custom emoji source option',
                find: "                            { value: 'custom', label: t('options.cappellaEmojiSourceCustom'), disabled: !hasCappellaCustomEmojiPack },\n",
                replace: '',
            },
            {
                what: 'cappella emoji upload row',
                find: "                <Row\n                    sub\n                    label={t('options.cappellaEmojiPreview')}\n                    hint={hasCappellaCustomEmojiPack\n                        ? `${t('options.cappellaEmojiCount')} ${cappellaCustomEmojiCount}`\n                        : t('options.cappellaEmojiUploadHint')}\n                    below={<CappellaImageSlots images={cappellaCustomEmojiImages} emptyName={t('options.cappellaEmojiEmptySlot')} />}\n                >\n                    <Button onClick={handleImportClick} disabled={isImporting || isCappellaCustomEmojiPackLoading}>\n                        {isImporting ? t('options.cappellaEmojiUploading') : t('options.cappellaEmojiUpload')}\n                    </Button>\n                    <Button\n                        onClick={() => void handleClearCustomPack()}\n                        disabled={!hasCappellaCustomEmojiPack || isImporting || isCappellaCustomEmojiPackLoading}\n                    >\n                        {t('options.cappellaEmojiClear')}\n                    </Button>\n                    <input\n                        ref={emojiFileInputRef}\n                        type=\"file\"\n                        accept=\".png,.jpg,.jpeg,.gif,.webp,.svg,image/*\"\n                        multiple\n                        className=\"hidden\"\n                        onChange={(event) => void handleFileChange(event)}\n                    />\n                </Row>\n",
                replace: '',
            },
        ],
    },
];

const foliaSettingsSurgery = (): Plugin => ({
    name: 'spw-folia-settings-surgery',
    enforce: 'pre',
    transform(code, id) {
        const normalized = id.replace(/\\/g, '/');
        const group = SETTINGS_SURGERY.find(candidate => normalized.endsWith(candidate.suffix));
        if (!group) return null;
        let next = code;
        for (const edit of group.edits) {
            const matches = typeof edit.find === 'string' ? next.includes(edit.find) : edit.find.test(next);
            if (!matches) {
                throw new Error(`[spw-folia-surgery] ${group.suffix}: marker not found for "${edit.what}" — Folia source changed, update vite.config.ts`);
            }
            next = next.replace(edit.find, edit.replace);
        }
        return { code: next, map: null };
    },
});

ensureFoliaDeps();

export default defineConfig(async () => ({
    base: './',
    plugins: [
        ...(await foliaVirtualModules()),
        foliaSettingsSurgery(), react(), foliaStubs(), debugWhoImports(), inlineCssIntoEntry(), tailwindcss(),
    ],
    resolve: {
        alias: [
            { find: /^@\//, replacement: `${foliaSrc}/` },
            { find: /^~\//, replacement: path.join(here, 'src') + '/' },
        ],
        // Folia's source has no node_modules of its own: every bare import resolves from this project.
        // 0.7.22's style pictures pull the visualizer registry (and so three.js/pixi.js) into the
        // settings bundle; those packages must resolve to this project's copies as well.
        dedupe: [
            'react', 'react-dom', 'framer-motion', 'lucide-react', 'i18next', 'react-i18next',
            'zustand', 'react-colorful', 'react-window', 'dexie',
            'three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing',
            'pixi.js', 'twgl.js', '@chenglou/pretext', 'blueimp-md5', 'wanakana',
        ],
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'chrome110',
        assetsInlineLimit: 0,
        cssCodeSplit: false,
        rollupOptions: {
            // The injected page loads exactly one module: the settings window bundle. HTML pages are
            // dev-only (`pnpm dev`), because the host page is Folia's own dist index.html.
            input: { settings: path.join(here, 'src/main.tsx') },
            output: {
                format: 'es',
                entryFileNames: 'settings-ui.js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]',
            },
        },
    },
    server: { port: 18090, strictPort: true },
    preview: { port: 18091, strictPort: true },
}));
