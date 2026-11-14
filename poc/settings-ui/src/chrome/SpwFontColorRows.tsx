/* issue #22 item 2: 通用 tab 的两行文字颜色。
 *
 * 需求原文：「增加字体颜色的选择：浅色，深色，跟随系统设置；开启透明窗口时需要另外选择，浅色，深色，
 * 跟随系统设置；（均默认为跟随系统设置，即当前的设置策略不变）」
 *
 * 两个关键决定：
 *  1. **只影响歌词与字幕的文字**，不影响背景与强调色。生效方式是换 `themeFromSample` 的
 *     `isLightOverride`（见 `useConfigPublisher.ts` 的 `themedInputs`）：它只改写
 *     `primaryColor`/`accentColor`/`secondaryColor`，`backgroundColor` 仍由封面色决定 —— 改那个会把
 *     画面本身的底色也翻过去，那不是「字体颜色」。
 *  2. 标签文案要说清「浅色」指的是**文字**，不是浅色主题：中文里「浅色」很容易被读成浅色外观，而这里的
 *     语义正好相反（浅色文字配深色画面）。所以 hint 直接写「浅色文字，适合深色画面」。
 *
 * 第二行（透明窗口）用 `Reveal` 只在透明窗口开启时出现：透明时页面没有封面底色，文字色跟的是系统配色，
 * 与不透明时是两套不同的取值，所以需求要求分开选。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Reveal, Row, Segmented } from '@/components/modal/settings/kit';
import { useSettingsStore, type FontColorMode } from '~/model/settings';

/** 三档的标签 key。`LOCAL_KEYS` 里新增（上游没有这三个词，见 `src/i18n.ts`）。 */
const MODE_LABEL_KEYS: Record<FontColorMode, string> = {
    light: 'options.fontColorLight',
    dark: 'options.fontColorDark',
    system: 'options.fontColorSystem',
};

const MODE_OPTIONS: FontColorMode[] = ['light', 'dark', 'system'];

const SpwFontColorRows: React.FC = () => {
    const { t } = useTranslation();
    const fontColorMode = useSettingsStore(state => state.fontColorMode);
    const setFontColorMode = useSettingsStore(state => state.setFontColorMode);
    const transparentFontColorMode = useSettingsStore(state => state.transparentFontColorMode);
    const setTransparentFontColorMode = useSettingsStore(state => state.setTransparentFontColorMode);
    const transparent = useSettingsStore(state => state.transparentPlayerBackground === true);

    const options = MODE_OPTIONS.map(mode => ({ value: mode, label: t(MODE_LABEL_KEYS[mode]) }));

    return (
        <div data-spw-font-color="true">
            <Row
                label={t('options.fontColor')}
                hint={t('options.fontColorHint')}
                note={t('options.fontColorDesc')}
            >
                <Segmented<FontColorMode> value={fontColorMode} options={options} onChange={setFontColorMode} />
            </Row>
            <Reveal when={transparent}>
                <Row
                    sub
                    label={t('options.transparentFontColor')}
                    hint={t('options.transparentFontColorHint')}
                    note={t('options.transparentFontColorDesc')}
                >
                    <Segmented<FontColorMode>
                        value={transparentFontColorMode}
                        options={options}
                        onChange={setTransparentFontColorMode}
                    />
                </Row>
            </Reveal>
        </div>
    );
};

export default SpwFontColorRows;
