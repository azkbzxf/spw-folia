/* The 17 lyric styles in Folia's shelf order (each entry's `order` ascending), with the real settings
 * panel its registry entry renders and the beat effects it declares. Only the panels are reused; the
 * style previews are static frames captured from the real renderers (poc/webview/server/out/styles). */
import React from 'react';
import {
    CappellaSettingsPanel,
    CladdaghSettingsPanel,
    ClassicSettingsPanel,
    DioramaSettingsPanel,
    FumeSettingsPanel,
    PartitaSettingsPanel,
    TiltSettingsPanel,
} from '@/components/visualizer/settingsPanels';
import SonnetSettingsPanel from '@/components/visualizer/sonnet/SonnetSettingsPanel';
import TemperaSettingsPanel from '@/components/visualizer/tempera/TemperaSettingsPanel';
import LumiereSettingsPanel from '@/components/visualizer/lumiere/LumiereSettingsPanel';
import HanabiSettingsPanel from '@/components/visualizer/hanabi/HanabiSettingsPanel';
import MachiSettingsPanel from '@/components/visualizer/machi/MachiSettingsPanel';
import NebbiaSettingsPanel from '@/components/visualizer/nebbia/NebbiaSettingsPanel';
import CadenzaSettingsPanel from '@/components/visualizer/cadenza/CadenzaSettingsPanel';
import PendoloSettingsPanel from '@/components/visualizer/pendolo/PendoloSettingsPanel';
import { MonetSettingsPanel } from '@/components/visualizer/monet/MonetSettingsPanel';
import { BEAT_EFFECT_IDS, type BeatEffectDef } from '@/components/../services/beatFx/beatEffects';
import type { StyleMode } from './settings';
import { STYLE_MODE_SHELF_ORDER } from './settings';
import { stylePreviewUrl } from './assetBase';

export interface StyleEntry {
    mode: StyleMode;
    order: number;
    labelKey: string;
    labelFallback: string;
    /** Static preview frame in public/styles. */
    thumb: string;
    renderSettingsPanel?: (props: any) => React.ReactNode;
    ownFontSizeNoticeKey?: string;
    beatEffects?: readonly BeatEffectDef[];
}

const panel = (component: React.FC<any>) =>
    function StyleSettingsPanel(props: any) {
        return React.createElement(component, props);
    };

export const STYLE_ENTRIES: StyleEntry[] = [
    {
        mode: 'sonnet',
        order: 10,
        labelKey: 'ui.visualizerSonnet',
        labelFallback: '商籁',
        thumb: stylePreviewUrl('sonnet'),
        renderSettingsPanel: panel(SonnetSettingsPanel),
        ownFontSizeNoticeKey: 'options.sonnetFontSizeAutoNotice',
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.sonnetLensTear,
                nameKey: 'options.beatEffect_sonnetLensTear',
                descKey: 'options.beatEffect_sonnetLensTearDesc',
                source: 'beats',
            },
        ],
    },
    {
        mode: 'tempera',
        order: 20,
        labelKey: 'ui.visualizerTempera',
        labelFallback: '凝彩',
        thumb: stylePreviewUrl('tempera'),
        renderSettingsPanel: panel(TemperaSettingsPanel),
        ownFontSizeNoticeKey: 'options.temperaFontSizeAutoNotice',
        // 0.7.25 gave 凝彩 its first beat effect: the ink flashed on htdemucs drum hits. Declared here
        // exactly as tempera/entry.tsx does; the tempera tuning panel also gained the three 墨染奥行
        // depth sliders (depthOfField / depthPan / glyphDepth) in the same release, which is another
        // strength the effect's slider scales.
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.temperaInkFlash,
                nameKey: 'options.beatEffect_temperaInkFlash',
                descKey: 'options.beatEffect_temperaInkFlashDesc',
                source: 'drums',
            },
        ],
    },
    {
        mode: 'lumiere',
        order: 25,
        labelKey: 'ui.visualizerLumiere',
        labelFallback: '绘光',
        thumb: stylePreviewUrl('lumiere'),
        renderSettingsPanel: panel(LumiereSettingsPanel),
        ownFontSizeNoticeKey: 'options.lumiereFontSizeAutoNotice',
    },
    {
        mode: 'hanabi',
        order: 26,
        labelKey: 'ui.visualizerHanabi',
        labelFallback: '花火',
        thumb: stylePreviewUrl('hanabi'),
        renderSettingsPanel: panel(HanabiSettingsPanel),
        ownFontSizeNoticeKey: 'options.hanabiFontSizeAutoNotice',
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.hanabiBeatBursts,
                nameKey: 'options.beatEffect_hanabiBeatBursts',
                descKey: 'options.beatEffect_hanabiBeatBurstsDesc',
                source: 'beats',
            },
            {
                id: BEAT_EFFECT_IDS.hanabiBeatPulse,
                nameKey: 'options.beatEffect_hanabiBeatPulse',
                descKey: 'options.beatEffect_hanabiBeatPulseDesc',
                source: 'beats',
            },
        ],
    },
    /* 0.7.25 町景 (order 27) and 雾笺 (order 29) — the two styles upstream added between 花火 (26) and
     * 古典 (30). Everything below is copied from their own `entry.tsx` declarations: the beat effects
     * are the entry's list verbatim (ids, i18n keys, source and — for 雾笺 — the two parts), because
     * `BEAT_EFFECT_IDS` and `beatEffects.ts` own that vocabulary and this page must not restate it. */
    {
        mode: 'machi',
        order: 27,
        labelKey: 'ui.visualizerMachi',
        labelFallback: '町景',
        thumb: stylePreviewUrl('machi'),
        renderSettingsPanel: panel(MachiSettingsPanel),
        ownFontSizeNoticeKey: 'options.machiFontSizeAutoNotice',
        // 智能动感模式 (machi/entry.tsx): the neon swells on the beats, each kick rings a ripple over
        // the wet ground and each snare flashes the lyric screen (htdemucs_gpu drum hits).
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.machiNeonPulse,
                nameKey: 'options.beatEffect_machiNeonPulse',
                descKey: 'options.beatEffect_machiNeonPulseDesc',
                source: 'beats',
            },
            {
                id: BEAT_EFFECT_IDS.machiDrumRipple,
                nameKey: 'options.beatEffect_machiDrumRipple',
                descKey: 'options.beatEffect_machiDrumRippleDesc',
                source: 'drums',
            },
            {
                id: BEAT_EFFECT_IDS.machiScreenFlash,
                nameKey: 'options.beatEffect_machiScreenFlash',
                descKey: 'options.beatEffect_machiScreenFlashDesc',
                source: 'drums',
            },
        ],
    },
    {
        mode: 'nebbia',
        order: 29,
        labelKey: 'ui.visualizerNebbia',
        labelFallback: '雾笺',
        thumb: stylePreviewUrl('nebbia'),
        renderSettingsPanel: panel(NebbiaSettingsPanel),
        // 疏雨轻车 (nebbia/entry.tsx): one effect, two parts, both read from the htdemucs run
        // (`source: 'stems'`): rain follows the vocal stem, the bus jolts on the kicks. Each part gets
        // its own strength slider, so the `parts` keys are part of the declaration, not decoration.
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.nebbiaDrizzleRide,
                nameKey: 'options.beatEffect_nebbiaDrizzleRide',
                descKey: 'options.beatEffect_nebbiaDrizzleRideDesc',
                source: 'stems',
                parts: [
                    { key: 'rain', nameKey: 'options.beatEffectPart_nebbiaRain' },
                    { key: 'bump', nameKey: 'options.beatEffectPart_nebbiaBump' },
                ],
            },
            // 0.7.26 舞潮踏拍: the aquarium's own beat reaction, off Beat This!' beats (`source: 'beats'`).
            // One effect, four parts — the jellyfish pulse, the seaweed sway, the row of big bubbles,
            // the spotlight's pool — each with its own strength slider, so the `parts` keys are part of
            // the declaration. Copied verbatim from nebbia/entry.tsx (id, i18n keys, source, parts).
            {
                id: BEAT_EFFECT_IDS.nebbiaAquaBeat,
                nameKey: 'options.beatEffect_nebbiaAquaBeat',
                descKey: 'options.beatEffect_nebbiaAquaBeatDesc',
                source: 'beats',
                parts: [
                    { key: 'jelly', nameKey: 'options.beatEffectPart_nebbiaJelly' },
                    { key: 'weed', nameKey: 'options.beatEffectPart_nebbiaWeed' },
                    { key: 'bubble', nameKey: 'options.beatEffectPart_nebbiaBubble' },
                    { key: 'spot', nameKey: 'options.beatEffectPart_nebbiaSpot' },
                ],
            },
        ],
    },
    {
        mode: 'classic',
        order: 30,
        labelKey: 'ui.visualizerClassic',
        labelFallback: '流光',
        thumb: stylePreviewUrl('classic'),
        renderSettingsPanel: panel(ClassicSettingsPanel),
    },
    {
        mode: 'cadenza',
        order: 40,
        labelKey: 'ui.visualizerCadenze',
        labelFallback: '心象',
        thumb: stylePreviewUrl('cadenza'),
        // 0.7.26 (#929): 心象 got a settings panel for the first time — a render-only group (the
        // 渲染 group's 分辨率 row; its text canvas is 2D, so no antialias row). Until this release
        // cadenza and still were the two styles with no panel at all; now only 静止 has none.
        renderSettingsPanel: panel(CadenzaSettingsPanel),
    },
    {
        mode: 'partita',
        order: 50,
        labelKey: 'ui.visualizerPartita',
        labelFallback: '云阶',
        thumb: stylePreviewUrl('partita'),
        renderSettingsPanel: panel(PartitaSettingsPanel),
    },
    {
        mode: 'fume',
        order: 60,
        labelKey: 'ui.visualizerFume',
        labelFallback: '浮名',
        thumb: stylePreviewUrl('fume'),
        renderSettingsPanel: panel(FumeSettingsPanel),
    },
    {
        mode: 'tilt',
        order: 70,
        labelKey: 'ui.visualizerTilt',
        labelFallback: '倾诉',
        thumb: stylePreviewUrl('tilt'),
        renderSettingsPanel: panel(TiltSettingsPanel),
    },
    {
        mode: 'claddagh',
        order: 80,
        labelKey: 'ui.visualizerCladdagh',
        labelFallback: '回环',
        thumb: stylePreviewUrl('claddagh'),
        renderSettingsPanel: panel(CladdaghSettingsPanel),
    },
    {
        mode: 'monet',
        order: 90,
        labelKey: 'ui.visualizerMonet',
        labelFallback: '莫奈',
        thumb: stylePreviewUrl('monet'),
        renderSettingsPanel: panel(MonetSettingsPanel),
    },
    {
        mode: 'pendolo',
        order: 100,
        labelKey: 'ui.visualizerPendolo',
        labelFallback: '时计',
        thumb: stylePreviewUrl('pendolo'),
        renderSettingsPanel: panel(PendoloSettingsPanel),
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.pendoloDrumhead,
                nameKey: 'options.beatEffect_pendoloDrumhead',
                descKey: 'options.beatEffect_pendoloDrumheadDesc',
                source: 'drums',
            },
            {
                id: BEAT_EFFECT_IDS.pendoloGearBeats,
                nameKey: 'options.beatEffect_pendoloGearBeats',
                descKey: 'options.beatEffect_pendoloGearBeatsDesc',
                source: 'beats',
                retired: true,
            },
        ],
    },
    {
        mode: 'cappella',
        order: 110,
        labelKey: 'ui.visualizerCappella',
        labelFallback: '群唱',
        thumb: stylePreviewUrl('cappella'),
        renderSettingsPanel: panel(CappellaSettingsPanel),
    },
    {
        mode: 'diorama',
        order: 120,
        labelKey: 'ui.visualizerDiorama',
        labelFallback: '镜台',
        thumb: stylePreviewUrl('diorama'),
        renderSettingsPanel: panel(DioramaSettingsPanel),
        beatEffects: [
            {
                id: BEAT_EFFECT_IDS.dioramaRipple,
                nameKey: 'options.beatEffect_dioramaRipple',
                descKey: 'options.beatEffect_dioramaRippleDesc',
                source: 'beats',
            },
        ],
    },
    {
        mode: 'still',
        order: 130,
        labelKey: 'ui.visualizerStill',
        labelFallback: '静止',
        thumb: stylePreviewUrl('still'),
    },
];

export const getStyleEntry = (mode: StyleMode): StyleEntry =>
    STYLE_ENTRIES.find(entry => entry.mode === mode) ?? STYLE_ENTRIES[0];

export const STYLE_COUNT = STYLE_ENTRIES.length;

/* Folia's `DefineVisualizer` invariant (`types/visualizerModes.ts#assertBuiltinModeList`): the shelf
 * order lives in two places — this table (mode + `order`, what the picture grid draws) and
 * `STYLE_MODE_SHELF_ORDER` (settings.ts: what 随机歌词样式 draws from and what the store normalises
 * pools against). Adding a style to one of them and forgetting the other would silently desync the
 * shelf from the random pool, so the two lists are compared once, at module load, and a mismatch
 * throws at once instead of quietly shipping 17 tiles over a 16-mode pool.
 * `./settings` imports nothing from this module by value (only the `StyleMode` type is declared
 * here, and `import type` is erased), so importing the order back is not a cycle. */
const declaredShelfOrder = [...STYLE_ENTRIES]
    .sort((left, right) => left.order - right.order)
    .map(entry => entry.mode);
const missingFromStyles = STYLE_MODE_SHELF_ORDER.filter(mode => !declaredShelfOrder.includes(mode));
const staleInStyles = declaredShelfOrder.filter(mode => !STYLE_MODE_SHELF_ORDER.includes(mode));
const orderDrifted = missingFromStyles.length === 0
    && staleInStyles.length === 0
    && declaredShelfOrder.join(',') !== STYLE_MODE_SHELF_ORDER.join(',');
if (missingFromStyles.length > 0 || staleInStyles.length > 0 || orderDrifted) {
    throw new Error(
        '[spw-folia] model/styles.tsx 与 model/settings.ts 的样式清单不一致：'
        + `${missingFromStyles.length > 0 ? ` styles.tsx 缺少 ${missingFromStyles.join(', ')}；` : ''}`
        + `${staleInStyles.length > 0 ? ` styles.tsx 多出 ${staleInStyles.join(', ')}；` : ''}`
        + `${orderDrifted ? ` 排序不同（styles.tsx: ${declaredShelfOrder.join(',')} / settings.ts: ${STYLE_MODE_SHELF_ORDER.join(',')}）；` : ''}`
        + ' 两种改法：在 STYLE_ENTRIES 加/删条目（或改 order），或同步 STYLE_MODE_SHELF_ORDER。',
    );
}
