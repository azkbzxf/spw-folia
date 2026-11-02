// 页面内探针 + runner（由 verify-shelf-live.mjs 读进宿主 eval，不是 node 模块）。
// 上游自己把舞台标成 data-picture="image"/"making"/"running"（LivePicture.tsx）；
// __SPW_SHELF_STATE__（model/ShelfLive.tsx）把它们与 pictureTurns.runningPicture() 一起读出来。
(() => {
    const results = [];
    window.__SHELF_RESULTS__ = results;
    const record = (name, value) => { results.push({ name, value }); return value; };

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const shelfRoot = () => document.querySelector('[data-spw-shelf]');
    const state = () => (window.__SPW_SHELF_STATE__ ? window.__SPW_SHELF_STATE__() : null);
    const tiles = () => [...document.querySelectorAll('[data-spw-shelf] [data-value]')];
    const tileOf = value => document.querySelector('[data-spw-shelf] [data-value="' + value + '"]');
    const chosen = () => document.querySelector('[data-spw-shelf] [aria-checked="true"]')?.dataset.value ?? null;

    const wait = async (check, timeoutMs, label) => {
        const started = performance.now();
        while (performance.now() - started <= timeoutMs) {
            let value = null;
            try { value = check(); } catch (error) { value = null; }
            if (value) return value;
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
        return record('timeout:' + label, state());
    };

    const hover = value => {
        const tile = tileOf(value);
        if (!tile) return 'no-tile:' + value;
        tile.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerId: 1, pointerType: 'mouse' }));
        return 'hovered:' + value;
    };
    const leaveGrid = () => {
        const grid = shelfRoot()?.querySelector('[role="radiogroup"]');
        grid?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false, pointerId: 1, pointerType: 'mouse' }));
        return 'left';
    };

    // 舞台在 ms 内的 DOM 变化数：静止的图一个都没有。
    const mutations = (ms) => new Promise(resolve => {
        const stage = shelfRoot()?.querySelector('[data-picture="running"]');
        if (!stage) { resolve({ stage: false, count: 0 }); return; }
        let count = 0;
        const observer = new MutationObserver(records => { count += records.length; });
        observer.observe(stage, { subtree: true, childList: true, attributes: true, characterData: true });
        setTimeout(() => { observer.disconnect(); resolve({ stage: true, count }); }, ms);
    });

    // running 舞台里 canvas 的像素指纹：两次不同就是真的在画。
    const canvasHash = () => {
        const stage = shelfRoot()?.querySelector('[data-picture="running"]');
        if (!stage) return 'no-stage';
        const canvas = stage.querySelector('canvas');
        if (!canvas || !canvas.width) return 'no-canvas';
        const scratch = document.createElement('canvas');
        scratch.width = 32; scratch.height = 20;
        const context = scratch.getContext('2d', { willReadFrequently: true });
        try {
            context.drawImage(canvas, 0, 0, 32, 20);
            const data = context.getImageData(0, 0, 32, 20).data;
            let hash = 0;
            for (let i = 0; i < data.length; i += 4) hash = (hash * 31 + data[i] + data[i + 1] * 3) % 2147483647;
            return hash;
        } catch (error) { return 'unreadable'; }
    };

    // 窗口是否真的在屏幕上（覆盖层是 display:none 而不是卸载，几何全 0 就是没显示）。
    const shell = () => {
        const overlay = document.querySelector('[data-spw-settings-ui]');
        const win = document.querySelector('.st-window');
        return {
            open: overlay?.dataset.open ?? null,
            display: overlay ? getComputedStyle(overlay).display : null,
            windowRect: win ? [Math.round(win.getBoundingClientRect().width), Math.round(win.getBoundingClientRect().height)] : null,
        };
    };

    // 每一格现在是什么：image（已冻结成图）/ making（正在造图）/ glyph（还只有字形，造不出图）/ live。
    // 用来回答「哪些样式在注入页里画不出来」——上游规则是造两次空舞台后落到 glyph。
    const tileStates = () => tiles().map(tile => {
        const value = tile.dataset.value;
        const frame = tile.querySelector('span');
        const stage = frame?.querySelector('[data-picture]');
        return {
            value,
            kind: stage ? stage.getAttribute('data-picture') : (value === '__random__' ? 'random-glyph' : 'glyph'),
            hasCanvas: Boolean(frame?.querySelector('canvas')),
        };
    });

    // running 那一格在屏幕上的矩形（宿主截图的裁切依据）：CSS px -> 截图 px 要乘 DSF。
    const runningRect = () => {
        const stage = shelfRoot()?.querySelector('[data-picture="running"]');
        const tile = stage?.closest('[data-value]');
        if (!tile) return null;
        const rect = tile.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    };

    // 一格的几何：tile 与 16:10 画框。
    const geometry = () => tiles().slice(0, 3).map(tile => {
        const rect = tile.getBoundingClientRect();
        const frame = tile.querySelector('span')?.getBoundingClientRect();
        return {
            value: tile.dataset.value,
            tile: [Math.round(rect.width), Math.round(rect.height)],
            frame: [Math.round(frame?.width ?? 0), Math.round(frame?.height ?? 0)],
        };
    });

    const start = async () => {
        try {
            record('shell-at-start', shell());

            // 0. 覆盖层是 display:none 而不是卸载：先把它打开（页面自己的 ui 控制器，等价于宿主的
            //    open-settings 命令；两者都走 registerSettingsUiController 的同一个 open()）。
            for (let i = 0; i < 40; i += 1) {
                if (shell().open === 'true' && shell().display !== 'none') break;
                try { window.__SPW_FOLIA__?.ui?.openSettings?.(); } catch (error) { /* not registered yet */ }
                await sleep(250);
            }
            record('shell-opened', shell());

            // 1. 等到至少一格有真实图片。
            record('first-image', await wait(() => {
                const now = state();
                return now && now.images > 0 ? now : null;
            }, 15000, 'first-image'));

            // 2. 等到 17 张样式图全部造好（造图串行：FIRST_IMAGE_REST_MS 450ms + 每张 0.1-0.6s）。
            record('all-images', await wait(() => {
                const now = state();
                return now && now.images >= 17 && now.making === 0 ? now : null;
            }, 32000, 'all-images'));
            record('tiles', tileStates());
            record('glyph-tiles', tileStates().filter(tile => tile.kind === 'glyph'));
            record('geometry', geometry());
            record('shell', shell());

            // 2b. 窗口窄的时候（生产 DSF 1.8 → CSS 848x515 → 4 列），货架要在自己内部滚动，而
            //     上游的规则是「看不见的格子不造图」（usePicturesInView + pictureWants('nothing')）。
            //     滚到底再等一轮，剩下的格子应当陆续出图 —— 这证明缺图是可见性驱动，不是画不出来。
            const grid = shelfRoot()?.querySelector('[role="radiogroup"]');
            if (grid && grid.scrollHeight > grid.clientHeight + 4) {
                record('scrolled', { scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight });
                // 一格一格往下滚（每次 60% 视口）：IntersectionObserver 逐行把新格子标成可见，
                // 每行都要留够造图时间（FIRST_IMAGE_REST_MS 450ms + 0.1–0.6s）。
                for (let step = 0; step < 8; step += 1) {
                    grid.scrollTop = grid.scrollTop + grid.clientHeight * 0.6;
                    await wait(() => {
                        const now = state();
                        return now && now.making === 0 && now.images >= 17 ? now : null;
                    }, 4000, 'row-' + step);
                }
                record('images-after-scroll', await wait(() => {
                    const now = state();
                    return now && now.images >= 17 && now.making === 0 ? now : null;
                }, 12000, 'images-after-scroll'));
                record('glyph-tiles-after-scroll', tileStates().filter(tile => tile.kind === 'glyph'));
                grid.scrollTop = 0;
                await sleep(700);
            } else {
                record('scrolled', { scrollHeight: grid?.scrollHeight ?? null, clientHeight: grid?.clientHeight ?? null });
            }

            // 3. 基线：指针不在货架上，running 必须是 0。
            record('idle', state());

            // 4. hover 一个非选中、非随机的格子：280ms 后它开始跑，且只有它。
            const chosenValue = chosen();
            const candidates = tiles().map(tile => tile.dataset.value).filter(value => value !== chosenValue && value !== '__random__');
            const target = candidates[0];
            record('hover', hover(target));
            record('running-after-hover', await wait(() => {
                const now = state();
                return now && now.running === 1 && now.runningValue === target ? now : null;
            }, 2500, 'running-after-hover'));

            // 5. 它真的在动吗。三种互证：
            //    a) DOM 变化数（元素型样式会动 DOM；canvas 样式不会）；
            //    b) 两次读 canvas 指纹（2D 画布可读，WebGL 读出来是空白）；
            //    c) 宿主截两张图，裁 running 那格做像素差（这才是「画面上真的变了」）。
            //    先把 rect 记下来，让 node 侧能在它跑着的时候去截图。
            record('running-rect', runningRect());
            record('motion-hold', 'start');
            await sleep(2400);
            const observed = await mutations(700);
            const first = canvasHash();
            await sleep(400);
            const second = canvasHash();
            record('motion', { target, mutations: observed, first, second, pixelsChanged: first !== second });
            record('motion-hold', 'end');

            // 6. 指针停到选中的格子：上游规则，选中的从不跑。它同时是「静止」对照：
            //    记下它的矩形，让 node 侧在它「应该不动」的时候连拍两张，裁同一块比较。
            hover(chosenValue);
            record('chosen-rect', (() => {
                const tile = tileOf(chosenValue);
                if (!tile) return null;
                const rect = tile.getBoundingClientRect();
                return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            })());
            await sleep(900);
            record('chosen-hover', { chosen: chosenValue, state: state() });

            // 7. 指针离开货架：running 归零。
            leaveGrid();
            record('leave', await wait(() => {
                const now = state();
                return now && now.running === 0 ? now : null;
            }, 2000, 'leave'));

            // 8. 换第二格再 hover：证明不是只有第一格能动。
            const secondTarget = candidates[1];
            record('hover-second', hover(secondTarget));
            record('running-second', await wait(() => {
                const now = state();
                return now && now.running === 1 && now.runningValue === secondTarget ? now : null;
            }, 2500, 'running-second'));
            const observedSecond = await mutations(700);
            const firstSecond = canvasHash();
            await sleep(400);
            const secondSecond = canvasHash();
            record('motion-second', { target: secondTarget, mutations: observedSecond, first: firstSecond, second: secondSecond, pixelsChanged: firstSecond !== secondSecond });

            // 9. 窗口其它部分没被弄坏。
            leaveGrid();
            await sleep(200);
            record('other-window', {
                styleWindows: document.querySelectorAll('.st-window').length,
                tabs: document.querySelectorAll('[role="tab"]').length,
                iframes: document.querySelectorAll('iframe').length,
                sliders: document.querySelectorAll('input[type="range"]').length,
                switches: document.querySelectorAll('[role="switch"]').length,
                brokenImages: [...document.querySelectorAll('[data-spw-shelf] img')].filter(image => image.naturalWidth === 0).length,
                glyphOnly: (state() || {}).glyphs,
            });
            // 9b. 舞台的暂停钮：上游 VisPlayground 用它暂停**同一个**预览时钟（大样例和小图共享），
            //     所以暂停后 hover 的格子应当停在原地不动。这里量两次画布指纹来确认。
            leaveGrid();
            await sleep(400);
            const pauseButton = document.querySelector('[data-spw-settings-ui] button[aria-label*="暂停"], [data-spw-settings-ui] button[aria-label*="pause"]');
            record('pause-button-found', Boolean(pauseButton));
            if (pauseButton) {
                pauseButton.click();
                await sleep(600);
                const pausedTarget = tiles().map(tile => tile.dataset.value).find(value => value !== chosen() && value !== '__random__');
                hover(pausedTarget);
                record('running-while-paused', await wait(() => {
                    const now = state();
                    return now && now.running === 1 && now.runningValue === pausedTarget ? now : null;
                }, 2500, 'running-while-paused'));
                const pausedRect = (() => {
                    const tile = tileOf(pausedTarget);
                    if (!tile) return null;
                    const rect = tile.getBoundingClientRect();
                    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
                })();
                record('paused-rect', pausedRect);
                record('paused-hold', 'start');
                await sleep(1800);
                record('paused-hold', 'end');
                leaveGrid();
                await sleep(300);
                pauseButton.click();
                await sleep(400);
            }

            // 10. 关窗再开窗两轮：注入的覆盖层是 display:none 而不是卸载，但 PictureGrid 里的
            //     LivePicture 会随 React 提交反复换图/换舞台。这一步专门走那条路径，确认不炸
            //     （早先版本在这里出过 NotFoundError: removeChild）。
            const cycles = [];
            for (let i = 0; i < 2; i += 1) {
                document.querySelector('[data-spw-settings-ui] [aria-label="返回"]')?.click();
                await sleep(900);
                window.__SPW_FOLIA__?.ui?.openSettings?.();
                await sleep(1400);
                cycles.push({ open: shell().open, state: state() });
            }
            record('reopen-cycles', cycles);
            // 再 hover 一次，确认重开之后依然能跑。
            const after = tiles().map(tile => tile.dataset.value).find(value => value !== chosen() && value !== '__random__');
            record('hover-after-reopen', hover(after));
            record('running-after-reopen', await wait(() => {
                const now = state();
                return now && now.running === 1 && now.runningValue === after ? now : null;
            }, 2500, 'running-after-reopen'));
            record('errors-after-reopen', (window.__SPW_PROBE_ERRORS__ || []).slice());
            record('done', true);
        } catch (error) {
            record('crash', String(error) + ' ' + (error && error.stack ? error.stack : ''));
            record('done', true);
        }
    };

    window.__SHELF_PROBE__ = { record, sleep, state, tiles, tileOf, chosen, wait, hover, leaveGrid, mutations, canvasHash, shell, geometry, runningRect, tileStates, start };
    return 'probe-installed';
})()
