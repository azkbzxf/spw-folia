/* issue #22 item 1: 视觉样式 tab 顶部的「渲染」组 —— 歌词画布的全局分辨率与抗锯齿。
 *
 * 上游把这两行放在「动画与性能」页（`components/modal/settings/pages/GraphicsPage.tsx` 的
 * `PERFORMANCE` 组），而那一页本插件不注入，于是用户在整个设置窗里找不到它们（issue #22 第 1 条）。
 * 这里用上游的 kit 重新画同一对控件，写回本页 store 的 `lyricRenderQuality`。
 *
 * 三个「为什么这样做」：
 *  1. 选项值与文案都从上游取（`LYRIC_RENDER_SCALES` / `LYRIC_ANTIALIAS_MODES` /
 *     `LYRIC_ANTIALIAS_LABEL_KEYS`）：上游加一档时这里自动跟上，也不会出现「1.5×」被重写成别的写法。
 *  2. 组标题是本页新增的 i18n key（`options.renderGroup`），行标签复用上游已有 key —— 与上游同名的
 *     控件在两处显示成同样的字，用户不会以为是两个不同的设置。
 *  3. 与「随机歌词样式」无关：挡位是全局的，随机池开着时这一组照样要能改，所以插入点在
 *     `randomEnabled` 分支之外（见 `vite.config.ts` 的 SETTINGS_SURGERY）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { LyricAntialias } from '@/types';
import {
    formatLyricRenderScale,
    LYRIC_ANTIALIAS_MODES,
    LYRIC_RENDER_SCALES,
} from '@/utils/lyricRenderQuality';
import { Group, Row, Segmented, type SettingsGroupDef } from '@/components/modal/settings/kit';
import { useSettingsStore } from '~/model/settings';

/** 组标题只有本页需要，key 在 `src/i18n.ts` 的 LOCAL_KEYS 里（上游没有这一组）。 */
const RENDER_GROUP: SettingsGroupDef = { id: 'spw-render-quality', titleKey: 'options.renderGroup' };

/** 抗锯齿三档的标签：上游自己的 key 表（`LyricRenderQualityRows.tsx` 导出的同名映射）。 */
const ANTIALIAS_LABEL_KEYS: Record<LyricAntialias, string> = {
    auto: 'options.lyricAntialiasAuto',
    on: 'options.lyricAntialiasOn',
    off: 'options.lyricAntialiasOff',
};

const SpwRenderQualityGroup: React.FC = () => {
    const { t } = useTranslation();
    const quality = useSettingsStore(state => state.lyricRenderQuality);
    const setQuality = useSettingsStore(state => state.handleSetLyricRenderQuality);

    // Segmented 的值必须是 string：倍数以字符串形式过一遍控件，回来再按上游的列表查回真值。
    const scaleOptions = LYRIC_RENDER_SCALES.map(scale => ({ value: String(scale), label: formatLyricRenderScale(scale) }));
    const antialiasOptions = LYRIC_ANTIALIAS_MODES.map(mode => ({ value: mode, label: t(ANTIALIAS_LABEL_KEYS[mode]) }));

    return (
        <div data-spw-render-quality="true">
            <Group def={RENDER_GROUP}>
                <Row label={t('options.lyricRenderScale')} note={t('options.lyricRenderScaleDesc')}>
                    <Segmented<string>
                        value={String(quality.scale)}
                        options={scaleOptions}
                        onChange={value => {
                            const scale = LYRIC_RENDER_SCALES.find(candidate => String(candidate) === value);
                            if (scale) setQuality({ scale });
                        }}
                    />
                </Row>
                <Row label={t('options.lyricAntialias')} note={t('options.lyricAntialiasDesc')}>
                    <Segmented<LyricAntialias>
                        value={quality.antialias}
                        options={antialiasOptions}
                        onChange={antialias => setQuality({ antialias })}
                    />
                </Row>
            </Group>
        </div>
    );
};

export default SpwRenderQualityGroup;
