// 页面内探针 + 计时器（由 measure-preview-cache.mjs 读进宿主 eval，不是 node 模块）。
//
// 为什么要有它：宿主 eval 只回传返回值，返回 Promise 会丢（verify-shelf-live.mjs 注释里的坑 a），
// 所以计时必须在页面内自己跑 —— arm() 之后每 16ms 采一次样，关键事件带 performance.now() 时间戳，
// node 侧只做同步读（report()），不掐任何绝对时间、不靠截图猜。
//
// 采的东西（基线与之后的缓存对比都靠这些数字）：
//   · 覆盖层真的可见（data-open=true 且 display≠none）、货架挂载、18 格齐全
//   · 第一个 [data-picture]、第一格 image、17 格全 image 各自的时刻
//   · 每格：第一次出现 stage（making 或 image）、第一次 making、第一次 image ——
//     这三者一起回答「这格的图是现场造出来的，还是直接就有」
//   · making 的峰值并发：上游串行造图（pictureTurns.takeTurn），峰值应当是 1；大于 1 说明
//     串行被破坏，等于 0 说明这一轮根本没有造图（缓存命中的判据）
//   · 本轮内新加载的 JS chunk（resource timing）与主线程长任务（PerformanceObserver）
//
// 时间基准：所有 xMs 都相对本轮 arm() 的 t0；chunk 与长任务用同一根 performance.now() 时钟。
(() => {
    const now = () => performance.now();
    const round1 = value => Math.round(value * 10) / 10;

    const overlayNode = () => document.querySelector('[data-spw-settings-ui]');
    const overlayOpen = () => {
        const node = overlayNode();
        if (!node) return false;
        if (node.dataset.open !== 'true') return false;
        return getComputedStyle(node).display !== 'none';
    };
    const shelfRoot = () => document.querySelector('[data-spw-shelf]');
    const shelfState = () => (typeof window.__SPW_SHELF_STATE__ === 'function' ? window.__SPW_SHELF_STATE__() : null);

    // 主线程长任务：单次占住 > 50ms。这是「打开设置卡不卡」唯一不靠体感的硬指标。
    const longTasks = [];
    try {
        if (typeof PerformanceObserver === 'function') {
            const observer = new PerformanceObserver(list => {
                for (const entry of list.getEntries()) {
                    longTasks.push({ startMs: entry.startTime, durationMs: entry.duration });
                }
            });
            observer.observe({ entryTypes: ['longtask'] });
        }
    } catch (error) {
        // 老 WebView2 没有 longtask：报告里就是 0 条，这里不能抛。
    }

    /** 本轮内（startMs 之后）新加载的 JS chunk：动态 import 的渲染器就是从这里来的。 */
    const chunksSince = startMs => {
        let entries = [];
        try {
            entries = performance.getEntriesByType('resource') || [];
        } catch (error) {
            return { count: 0, bytes: 0, files: [] };
        }
        const files = entries
            .filter(entry => entry.startTime >= startMs - 50)
            .filter(entry => /\/assets\/[^/]+\.js(\?|$)/.test(entry.name))
            .map(entry => ({
                file: entry.name.slice(entry.name.lastIndexOf('/') + 1).split('?')[0],
                startMs: round1(entry.startTime - startMs),
                // 虚拟主机映射（spw-folia.local）不走网络栈，transferSize/encodedBodySize 常是 0；
                // decodedBodySize 是解压后的真实体积，作为兜底。三者全 0 时给 null，不假报 0KB。
                bytes: entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || null,
            }));
        const measured = files.filter(file => file.bytes !== null);
        return {
            count: files.length,
            bytes: measured.length ? measured.reduce((sum, file) => sum + file.bytes, 0) : null,
            bytesMeasured: measured.length,
            files,
        };
    };

    /** 本轮时间窗内的长任务：条数、总时长、最长一次、以及主线程被占住的累计（>50ms 的部分）。 */
    const longTasksSince = startMs => {
        const hit = longTasks.filter(task => task.startMs + task.durationMs >= startMs - 50);
        if (hit.length === 0) return { count: 0, totalMs: 0, maxMs: 0, blockingMs: 0, tasks: [] };
        const totalMs = hit.reduce((sum, task) => sum + task.durationMs, 0);
        const blockingMs = hit.reduce((sum, task) => sum + Math.max(0, task.durationMs - 50), 0);
        return {
            count: hit.length,
            totalMs: round1(totalMs),
            maxMs: round1(Math.max(...hit.map(task => task.durationMs))),
            blockingMs: round1(blockingMs),
            tasks: hit.map(task => ({ atMs: round1(task.startMs - startMs), ms: round1(task.durationMs) })),
        };
    };

    /**
     * IndexedDB 现状：缓存改动要落在这里（页面里已有的先例是 uploadedFonts.ts 的字体库）。
     * 基线跑出来应当是「没有任何预览缓存库」；之后跑出来应当有库、有记录 —— 这就是缓存真的
     * 落地了的证据，比看 DOM 强。探测是异步的，结果写进 stored，report() 同步读，避免宿主
     * eval 丢 Promise 的坑。
     */
    const idb = { supported: false, databases: null, error: null };
    const surveyIndexedDb = async () => {
        try {
            if (typeof indexedDB === 'undefined' || !indexedDB) {
                idb.error = 'no-indexeddb';
                return;
            }
            idb.supported = true;
            let names = [];
            if (typeof indexedDB.databases === 'function') {
                names = (await indexedDB.databases()).map(info => info.name).filter(Boolean);
            } else {
                idb.error = 'indexedDB.databases unsupported';
            }
            const databases = [];
            for (const name of names) {
                databases.push(await describeDatabase(name));
            }
            idb.databases = databases;
        } catch (error) {
            idb.error = String(error && error.message ? error.message : error);
        }
    };

    /** 打开一个库，读出它的 store 名与（尽力而为的）记录数，然后关掉：只读，不改任何东西。 */
    const describeDatabase = name => new Promise(resolve => {
        let settled = false;
        const done = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        // IndexedDB 的 blocked 事件在别的标签页占着库时才来；给 1.5s 的硬上限，别把探针挂住。
        setTimeout(() => done({ name, error: 'timeout' }), 1500);
        let request;
        try {
            request = indexedDB.open(name);
        } catch (error) {
            done({ name, error: String(error) });
            return;
        }
        request.onerror = () => done({ name, error: 'open-failed' });
        request.onblocked = () => done({ name, error: 'blocked' });
        request.onsuccess = () => {
            const db = request.result;
            const stores = [...db.objectStoreNames];
            let left = stores.length;
            const counts = {};
            if (left === 0) {
                db.close();
                done({ name, version: db.version, stores, counts });
                return;
            }
            for (const store of stores) {
                try {
                    const countRequest = db.transaction(store, 'readonly').objectStore(store).count();
                    countRequest.onsuccess = () => {
                        counts[store] = countRequest.result;
                        left -= 1;
                        if (left === 0) {
                            db.close();
                            done({ name, version: db.version, stores, counts });
                        }
                    };
                    countRequest.onerror = () => {
                        left -= 1;
                        if (left === 0) {
                            db.close();
                            done({ name, version: db.version, stores, counts });
                        }
                    };
                } catch (error) {
                    counts[store] = 'ERR';
                    left -= 1;
                    if (left === 0) {
                        db.close();
                        done({ name, version: db.version, stores, counts });
                    }
                }
            }
        };
    });

    const blankRound = () => ({
        label: null,
        ended: true,
        t0: 0,
        /** 覆盖层第一次真的可见 */
        tOpened: null,
        tShelf: null,
        tTiles: null,
        tFirstPicture: null,
        tFirstImage: null,
        tAllImages: null,
        /** 18 格：17 个样式格能出 [data-picture]，随机格只有字形，永远没有 */
        tileCount: 0,
        images: 0,
        making: 0,
        running: 0,
        pictures: 0,
        peakMaking: 0,
        peakRunning: 0,
        peakPictures: 0,
        samples: 0,
        /** value -> 该格的关键时刻 */
        tiles: {},
        log: [],
    });

    let round = blankRound();
    let timer = null;

    const mark = (self, field, at, what) => {
        if (self[field] !== null) return;
        self[field] = round1(at);
        self.log.push({ at: round1(at), what });
    };

    const sample = () => {
        const self = round;
        if (!self || self.ended) return;
        const t = now() - self.t0;
        self.samples += 1;

        if (overlayOpen()) mark(self, 'tOpened', t, 'overlay-visible');

        const root = shelfRoot();
        if (!root) return;
        mark(self, 'tShelf', t, 'shelf-mounted');

        const tiles = root.querySelectorAll('[data-value]');
        if (tiles.length > self.tileCount) self.tileCount = tiles.length;
        if (tiles.length >= 18) mark(self, 'tTiles', t, 'tiles-complete');

        let images = 0;
        let making = 0;
        let running = 0;
        let pictures = 0;
        for (const tile of tiles) {
            const value = tile.dataset.value || '?';
            const stage = tile.querySelector('[data-picture]');
            const kind = stage ? (stage.getAttribute('data-picture') || 'none') : 'none';
            let entry = self.tiles[value];
            if (!entry) {
                entry = {
                    value,
                    firstSeenMs: round1(t),
                    firstPictureMs: null,
                    firstMakingMs: null,
                    firstImageMs: null,
                    firstRunningMs: null,
                    finalKind: 'none',
                    canvas: false,
                };
                self.tiles[value] = entry;
                self.log.push({ at: round1(t), what: 'tile:' + value });
            }
            if (stage) {
                pictures += 1;
                if (entry.firstPictureMs === null) entry.firstPictureMs = round1(t);
            }
            if (kind === 'image') {
                images += 1;
                if (entry.firstImageMs === null) {
                    entry.firstImageMs = round1(t);
                    mark(self, 'tFirstImage', t, 'first-image:' + value);
                }
            } else if (kind === 'making') {
                making += 1;
                if (entry.firstMakingMs === null) entry.firstMakingMs = round1(t);
            } else if (kind === 'running') {
                running += 1;
                if (entry.firstRunningMs === null) entry.firstRunningMs = round1(t);
            }
            if (stage && self.tFirstPicture === null) mark(self, 'tFirstPicture', t, 'first-picture:' + value);
            entry.finalKind = kind;
            entry.canvas = Boolean(tile.querySelector('canvas'));
        }

        self.images = images;
        self.making = making;
        self.running = running;
        self.pictures = pictures;
        if (making > self.peakMaking) self.peakMaking = making;
        if (running > self.peakRunning) self.peakRunning = running;
        if (pictures > self.peakPictures) self.peakPictures = pictures;

        // 17 个样式格全出图、且没有任何一格还在造图 —— 这一轮到此为止。
        // （18 格减去随机格；随机格在 __random__ 这个 value 上。）
        const styleTiles = self.tiles.__random__ ? Math.max(0, self.tileCount - 1) : self.tileCount;
        if (self.tileCount >= 18 && styleTiles > 0 && images >= styleTiles && making === 0) {
            mark(self, 'tAllImages', t, 'all-images');
        }
    };

    const arm = label => {
        round = blankRound();
        round.label = label;
        round.t0 = now();
        round.ended = false;
        if (timer !== null) clearInterval(timer);
        timer = setInterval(sample, 16);
        sample();
        return 'armed:' + label;
    };

    const stop = () => {
        round.ended = true;
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
        return 'stopped';
    };

    const perTile = () => Object.keys(round.tiles)
        .map(key => round.tiles[key])
        .sort((a, b) => {
            const left = a.firstImageMs === null ? Number.MAX_SAFE_INTEGER : a.firstImageMs;
            const right = b.firstImageMs === null ? Number.MAX_SAFE_INTEGER : b.firstImageMs;
            return left - right;
        })
        .map(entry => ({
            ...entry,
            // 出图之前是否搭过舞台（= 挂过真实渲染器）。false 只可能是「直接就有图」。
            stageBeforeImage: entry.firstMakingMs !== null && (entry.firstImageMs === null || entry.firstMakingMs <= entry.firstImageMs),
        }));

    const report = () => {
        if (!round || round.label === null) return { armed: false };
        const elapsed = now() - round.t0;
        const styleTiles = round.tiles.__random__ ? Math.max(0, round.tileCount - 1) : round.tileCount;
        return {
            armed: true,
            label: round.label,
            ended: round.ended,
            elapsedMs: round1(elapsed),
            tOpened: round.tOpened,
            tShelf: round.tShelf,
            tTiles: round.tTiles,
            tFirstPicture: round.tFirstPicture,
            tFirstImage: round.tFirstImage,
            tAllImages: round.tAllImages,
            tileCount: round.tileCount,
            styleTiles,
            images: round.images,
            pictures: round.pictures,
            making: round.making,
            running: round.running,
            peakMaking: round.peakMaking,
            peakRunning: round.peakRunning,
            peakPictures: round.peakPictures,
            samples: round.samples,
            done: round.tAllImages !== null,
            shelfState: shelfState(),
            chunks: chunksSince(round.t0),
            longTasks: longTasksSince(round.t0),
            indexedDb: idb,
            perTile: perTile(),
            log: round.log.slice(0, 400),
        };
    };

    window.__PC_PROBE__ = { arm, stop, report, sample, overlayOpen, shelfState, surveyIndexedDb };
    surveyIndexedDb();
    return 'preview-cache-probe-installed';
})()
