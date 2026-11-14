// 页面内探针 + runner（由 verify-issue22-island.mjs 读进宿主 eval，不是 node 模块）。
//
// issue #22 设置岛部分的两条：
//   A. 视觉样式 tab 顶部出现「渲染」组，点 1.5× 之后
//      - localStorage['lyric_render_quality'] 变成 {"scale":1.5,...}
//      - 播放页收到的 config 里 visualizerTunings.<当前样式>.render.scale === 1.5
//      - settings.styleTunings 里那一份**没被写回**（跟随全局的状态必须还在）
//   B. 通用 tab 出现两行文字颜色，选「浅色」之后 config.theme 的 primaryColor 变亮
//      （= 浅色文字），而 backgroundColor 不变（背景不跟着翻）。
//
// 结果写进 window.__ISSUE22_RESULTS__，node 侧只做同步读取（宿主 eval 只回传返回值，
// 返回 Promise 会序列化成 {}）。
(() => {
    const results = [];
    window.__ISSUE22_RESULTS__ = results;
    const record = (name, value) => { results.push({ name, value }); return value; };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const q = sel => document.querySelector(sel);
    const qa = sel => [...document.querySelectorAll(sel)];

    /** 设置窗的根：宿主注入的覆盖层（data-spw-settings-ui）。 */
    const root = () => q('[data-spw-settings-ui]');

    /** 某个 tab 的按钮（上游 Tabs 的 role=tab，label 是文案）。 */
    const tab = label => qa('[data-spw-settings-ui] [role="tab"]').find(el => el.textContent.trim() === label) || null;

    /** 点一下并等 React 落地。 */
    const click = async el => {
        if (!el) return false;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        el.click();
        await sleep(220);
        return true;
    };

    /** 等一个条件成立（同步检查）。 */
    const wait = async (check, timeoutMs, label) => {
        const started = performance.now();
        while (performance.now() - started <= timeoutMs) {
            let value = null;
            try { value = check(); } catch { value = null; }
            if (value) return value;
            await sleep(60);
        }
        return record('timeout:' + label, null);
    };

    /** 一个 Row 里「标签文字 = label」的那一行。 */
    const rowByLabel = label => qa('[data-spw-settings-ui] [data-settings-row], [data-spw-settings-ui] .st-row')
        .find(el => (el.textContent || '').includes(label)) || null;

    /** 行里某个 Segmented 选项（按可见文字精确匹配）。 */
    const optionIn = (row, label) => row
        ? [...row.querySelectorAll('button[aria-pressed]')].find(el => el.textContent.trim() === label) || null
        : null;

    /** 当前选中的样式 id：从发布出去的 config 读（设置岛自己的 publisher 是唯一来源）。 */
    const currentStyle = () => {
        const cfg = lastConfig();
        return cfg && typeof cfg.visualizerMode === 'string' ? cfg.visualizerMode : null;
    };

    /** 播放页收到的最后一份 config（Shim 存着；可能被字符串包一层，要 peel）。 */
    const lastConfig = () => {
        let raw = null;
        try {
            const bridge = window.__SPW_FOLIA__;
            raw = bridge && typeof bridge.lastConfig === 'function' ? bridge.lastConfig() : null;
        } catch { raw = null; }
        if (raw == null) raw = window.__SPW_FOLIA_LAST_CONFIG__ ?? null;
        // 有的路径把 config 当 JSON 字符串传，逐层 peel 到对象为止。
        for (let i = 0; i < 3 && typeof raw === 'string'; i += 1) {
            try { raw = JSON.parse(raw); } catch { break; }
        }
        return raw && typeof raw === 'object' ? raw : null;
    };

    const readStored = () => {
        try {
            const raw = localStorage.getItem('lyric_render_quality');
            return raw == null ? null : JSON.parse(raw);
        } catch (error) {
            return { parseError: String(error) };
        }
    };

    /** 设置树里该样式的 render 覆盖（用来证明「跟随全局」没有被写回 store）。
     *  注意 `bridge.getSettings()` 是宿主侧的设置树，与设置岛自己 store 里的那份是两回事；
     *  这里要证明的是**岛自己没把 'global' 写回去**，所以读岛自己发布出去的 config 的源 —— 即
     *  `__SPW_FOLIA__.getSettings()` 里 styleTunings 的那一份（宿主保存的正是岛 emit 的快照）。 */
    const storedRenderOverride = styleId => {
        try {
            const bridge = window.__SPW_FOLIA__;
            const settings = bridge && typeof bridge.getSettings === 'function' ? bridge.getSettings() : null;
            const tunings = settings && settings.styleTunings ? settings.styleTunings : null;
            if (!tunings || !styleId || !tunings[styleId]) return null;
            return tunings[styleId].render ?? null;
        } catch {
            return null;
        }
    };

    /** #RRGGBB 的相对亮度（0..1），与 deriveTheme 的 luminance 同一个公式。 */
    const lum = hex => {
        if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };

    /**
     * issue #22 item 2 的取证方式，以及为什么**不**注入封面。
     *
     * 直觉上「浅色 vs 跟随系统」需要一张浅色封面才区分得开。但注入封面只能走
     * `__SPW_FOLIA__.emit('track', …)`，那条路径会把消息 post 给 C# 宿主 —— 而宿主此刻正由另一位同事
     * 修改（本次实测里那条 emit 之后宿主进程直接以 -1 退出，取证链断在别人正在改的代码上）。所以这里
     * 不碰它。
     *
     * 没有封面时用的是两套固定回退调色板（`deriveTheme.ts` 的 DARK/LIGHT_FALLBACK），而深色回退的
     * 文字本来就是浅色，于是三档的结果是：
     *   跟随系统 → 深色回退 → 浅色文字（#f4f4f5）+ 深色背景（#09090b）—— 引入前的样子；
     *   浅色     → 浅色文字 + 深色背景 —— 与上面**相同**：因为「浅色文字配深色画面」正是回退调色板已经
     *              给出的组合，这个相等是正确结果，不是判据失效；
     *   深色     → 深色文字（#18181b）+ 深色背景 —— 文字翻了，背景**没动**。
     *
     * 于是这组对照正好证明两件事，而且比有封面时更干净：
     *  (1) 显式选择真的驱动文字（深色把 primary 的亮度从 0.957 压到 0.095）；
     *  (2) 背景侧不受影响（三档的 backgroundColor 都是 #09090b）—— 也就是 `textIsLight` 与
     *      `isLightOverride` 的拆分确实生效，没有把 `isDaylight` 一起翻过去。
     * 另外 #18181b 正是 LIGHT_FALLBACK 的原始 primary：它穿过 `ensureContrast` 后**一位没变**
     * （0.095 远低于浅色侧的 0.45 上限），说明显式选择不会被对比度保护拉走。
     */
    const runner = async () => {
        const stage = name => { window.__ISSUE22_STAGE__ = name; };
        // ---- 设置窗必须是开着的（node 侧先发 open-settings 命令） ----
        await wait(() => root() && root().getAttribute('data-open') === 'true', 8000, 'settings-open');
        await sleep(600);
        record('config.initial.present', Boolean(lastConfig()));

        // ---- A: 视觉样式 tab 顶部的「渲染」组 ----
        stage('A');
        const visualizerTab = tab('视觉样式') || tab('歌词动画') || tab('样式');
        await click(visualizerTab);
        const group = await wait(() => q('[data-spw-render-quality="true"]'), 5000, 'render-group');
        record('A.group.present', Boolean(group));
        record('A.group.title', group ? (group.querySelector('h3')?.textContent || '').trim() : null);
        record('A.group.isFirstGroupInVisualizerTab', Boolean(group) && !group.parentElement?.previousElementSibling
            ? true
            : (() => {
                // 更稳的判据：它上面没有别的 Group（同级的 st-card 卡片的标题块）。
                const body = group?.parentElement;
                if (!body) return false;
                const groups = [...body.children].filter(el => el.querySelector && el.querySelector('h3'));
                return groups.length > 0 && groups[0] === group;
            })());
        record('A.group.rows', group
            ? [...group.querySelectorAll('.st-row')].map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40))
            : []);

        // ---- A: 点 1.5× ----
        const scaleRow = group ? [...group.querySelectorAll('.st-row')]
            .find(el => (el.textContent || '').includes('歌词画布分辨率')) : null;
        const scale15 = optionIn(scaleRow, '1.5×');
        record('A.scale.option1_5.present', Boolean(scale15));
        const styleId = currentStyle();
        record('A.styleId', styleId);
        const beforeOverride = storedRenderOverride(styleId);
        record('A.storeRenderOverride.before', beforeOverride);
        record('A.localStorage.before', readStored());
        await click(scale15);
        await sleep(450);

        const afterStored = readStored();
        record('A.localStorage.after', afterStored);
        record('A.localStorage.scale', afterStored ? afterStored.scale : null);
        record('A.localStorage.antialias', afterStored ? afterStored.antialias : null);

        // 发布出去的副本里，该样式的 render.scale 必须已经是 1.5（物化）
        const cfg = await wait(() => {
            const next = lastConfig();
            const tunings = next && next.visualizerTunings;
            const bag = tunings && styleId ? tunings[styleId] : null;
            return bag && bag.render && bag.render.scale === 1.5 ? next : null;
        }, 5000, 'config-materialised');
        const published = cfg && cfg.visualizerTunings && styleId ? cfg.visualizerTunings[styleId] : null;
        record('A.config.present', Boolean(cfg));
        record('A.config.visualizerTunings.scale', published && published.render ? published.render.scale : null);
        record('A.config.visualizerTunings.antialias', published && published.render ? published.render.antialias : null);
        // 其它样式也必须被物化（不是只有当前这一份）
        record('A.config.allMaterialised', (() => {
            const tunings = cfg && cfg.visualizerTunings ? cfg.visualizerTunings : {};
            const bad = [];
            for (const [mode, bag] of Object.entries(tunings)) {
                if (!bag || !bag.render) continue;
                if (bag.render.scale === 'global' || bag.render.antialias === 'global') bad.push(mode);
            }
            return bad;
        })());
        // 町景：quality 也要物化，且 antialias 的映射与上游 settle() 一致
        const machi = cfg && cfg.visualizerTunings ? cfg.visualizerTunings.machi : null;
        record('A.config.machi.quality', machi && machi.quality
            ? { renderScale: machi.quality.renderScale, antialias: machi.quality.antialias }
            : null);

        // 纪律：store 里那一份不能被写回（跟随全局必须还在）
        record('A.storeRenderOverride.after', storedRenderOverride(styleId));

        // 换回 1×，确认「跟随全局」还在（否则这一步会停在 1.5 上）
        const scale1 = optionIn(scaleRow, '1×');
        await click(scale1);
        await sleep(400);
        const cfgBack = lastConfig();
        const back = cfgBack && cfgBack.visualizerTunings && styleId ? cfgBack.visualizerTunings[styleId] : null;
        record('A.revert.config.scale', back && back.render ? back.render.scale : null);
        record('A.revert.localStorage', readStored());
        record('A.revert.storeRenderOverride', storedRenderOverride(styleId));

        // ---- B: 通用 tab 的文字颜色两行 ----
        stage('B');
        const commonTab = tab('通用') || tab('字体') || tab('常用');
        await click(commonTab);
        const fontRows = await wait(() => q('[data-spw-font-color="true"]'), 5000, 'font-color-rows');
        record('B.rows.present', Boolean(fontRows));
        record('B.rows.labels', fontRows
            ? [...fontRows.querySelectorAll('.st-row')].map(el => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50))
            : []);
        // 透明窗口未开启时第二行不该在文档里（Reveal 默认不保留）
        record('B.transparentRow.visibleWhenOpaque', fontRows
            ? (fontRows.textContent || '').includes('透明窗口下的文字颜色')
            : null);

        const colorRow = fontRows ? [...fontRows.querySelectorAll('.st-row')]
            .find(el => (el.textContent || '').includes('文字颜色') && !(el.textContent || '').includes('透明窗口')) : null;
        const lightOpt = optionIn(colorRow, '浅色');
        record('B.light.option.present', Boolean(lightOpt));

        const themeBefore = lastConfig() ? lastConfig().theme : null;
        record('B.theme.before', themeBefore
            ? { primary: themeBefore.primaryColor, background: themeBefore.backgroundColor, primaryLum: lum(themeBefore.primaryColor) }
            : null);
        await click(lightOpt);
        await sleep(500);
        const cfgLight = lastConfig();
        const themeLight = cfgLight ? cfgLight.theme : null;
        record('B.theme.light', themeLight
            ? { primary: themeLight.primaryColor, background: themeLight.backgroundColor, primaryLum: lum(themeLight.primaryColor) }
            : null);
        // 浅色文字 = primaryColor 变亮；背景色必须不动
        record('B.primaryBrightened', Boolean(themeBefore && themeLight)
            && lum(themeLight.primaryColor) > lum(themeBefore.primaryColor));
        record('B.backgroundUnchanged', Boolean(themeBefore && themeLight)
            && themeLight.backgroundColor === themeBefore.backgroundColor);
        // 字幕主题也要跟着走（subtitleTheme 复用 derived.theme）
        record('B.subtitleTheme.light', cfgLight && cfgLight.subtitleTheme
            ? { primary: cfgLight.subtitleTheme.primaryColor, primaryLum: lum(cfgLight.subtitleTheme.primaryColor) }
            : null);

        // 换成「深色」，确认能反着走
        const darkOpt = optionIn(colorRow, '深色');
        await click(darkOpt);
        await sleep(450);
        const cfgDark = lastConfig();
        const themeDark = cfgDark ? cfgDark.theme : null;
        record('B.theme.dark', themeDark
            ? { primary: themeDark.primaryColor, background: themeDark.backgroundColor, primaryLum: lum(themeDark.primaryColor) }
            : null);
        record('B.darkDarkerThanLight', Boolean(themeLight && themeDark)
            && lum(themeDark.primaryColor) < lum(themeLight.primaryColor));
        record('B.dark.backgroundUnchanged', Boolean(themeBefore && themeDark)
            && themeDark.backgroundColor === themeBefore.backgroundColor);

        // 回到「跟随系统」（= 引入前的行为）
        const systemOpt = optionIn(colorRow, '跟随系统');
        await click(systemOpt);
        await sleep(500);
        const cfgSystem = lastConfig();
        record('B.theme.system', cfgSystem && cfgSystem.theme
            ? { primary: cfgSystem.theme.primaryColor, background: cfgSystem.theme.backgroundColor }
            : null);
        record('B.system.restoresOpaqueDefault', Boolean(cfgSystem && themeBefore && cfgSystem.theme)
            && cfgSystem.theme.primaryColor === themeBefore.primaryColor);

        // ---- 错误收集 ----
        record('errors', window.__ISSUE22_ERRORS__ || []);
        record('done', true);
        window.__ISSUE22_DONE__ = true;
    };

    // 页面级错误：任何未捕获异常/拒绝都算失败，哪怕断言全过。
    window.__ISSUE22_ERRORS__ = [];
    window.addEventListener('error', event => {
        window.__ISSUE22_ERRORS__.push(String(event.message) + ' @ ' + String(event.filename));
    });
    window.addEventListener('unhandledrejection', event => {
        window.__ISSUE22_ERRORS__.push('rejection: ' + String(event.reason));
    });

    window.__ISSUE22_START__ = () => { void runner(); return 'started'; };
    return 'probe-installed';
})();
