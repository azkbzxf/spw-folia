/* 歌词样式小图的**磁盘**缓存：把上游冻结好的那张静态图留在本机，下次开窗口直接贴出来。
 *
 * 为什么需要它：上游 `preview/pictureImages.ts` 那只 Map 只活在**页面生命周期**里（KEEP 64）。
 * 同一页关掉再开设置是 48ms（真机实测），但**重启进程**就全没了 —— 17 格又得逐格把真实渲染器
 * 拉进来造图，实测 23.0s / 81 个渲染器 chunk。这只缓存补的就是「重启之后」这一段。
 *
 * 分工（别混）：
 *   - 页内 Map（上游）仍是一级缓存，本文件不替代它；
 *   - 本文件是二级缓存，只存「已经冻结成静态图」的结果，**不存渲染器、不存 canvas、不存活对象**；
 *   - 命中时把静态片段还原成普通元素塞回上游的 Map（`keepImage`），于是 `LivePicture` 认为
 *     「这张图已经有了」：不排队造图、不拉渲染器 chunk、不起 rAF；hover 时才走它自己的
 *     `image → live` 那条既有路径挂真渲染器。
 *
 * 键：**复用上游的 `stylePictureKey`**，但**不传上传图**，再在前面加一个 schema 版本前缀。
 * 为什么不直接拿上游那份键：`pictureKey` 会把「上传图对象」编码成 WeakMap 序号
 * （`markOf`），序号取决于本页第一次见到该对象时是第几个 —— **每次重启都不一样**，用它做磁盘键
 * 会让缓存永远不命中。上游那份键继续做页内 Map 的键（那里序号在同一页里是稳的），我们另算一份
 * 只含纯数据的键落盘。上传图在场时整条缓存直接关掉（`uploadsBlockCaching`），所以不会丢信息。
 *
 * 不自己拼一份字段清单的原因：上游那个函数已经把 mode/stage/theme/isDaylight/sample/fontScale/
 * tuning/mod 设置全写进 JSON 了，重写一遍就是等它哪天加字段时静默错位。
 *
 * 为什么走 IndexedDB 而不是 localStorage：一张小图的 DOM 串有几十 KB 字符，17 格会把 localStorage
 * 的 5MB 配额吃满；IndexedDB 存的仍是字符串，够用且不引依赖（与 `uploadedFonts.ts` 同一手法）。
 *
 * 失败必须无声降级：没有 IndexedDB、配额满、记录损坏、反序列化抛错 —— 一律当作「没有缓存」，
 * 调用方回落到现场造图。这个文件里所有导出函数都**不会抛**。
 */
import { stylePictureKey, type StylePictureShows } from '@/components/visualizer/preview/pictureImages';

/** 库名 / 仓库名 / 主键名是**契约**：真机验收脚本按这三个名字取证，别改。 */
export const PICTURE_DB_NAME = 'spw-folia-preview';
export const PICTURE_STORE = 'pictures';
export const PICTURE_KEY_PATH = 'key';

/**
 * 缓存格式版本。任何「同样的输入但画出来不一样」的改动（还原方式的改变、`staticPictureHtml`
 * 的产物格式变化、渲染器输出格式变化）都必须 +1：旧记录因此整体失效，而不是被当成新图贴出来。
 */
export const PICTURE_SCHEMA_VERSION = 1;

/** 条目上限：17 样式 + 随机格用不到，留余量给「换过主题/字号」留下的旧图。 */
const MAX_ENTRIES = 32;
/** 总字节上限：WebP 下 17 张合计约 300KB，32 张也不会过 1MB；8MB 是很宽的天花板。 */
const MAX_BYTES = 8 * 1024 * 1024;
/**
 * 单条上限：超过就不存。
 *
 * 实测 WebP 0.85 下最大的单格约 90KB（pendolo），所以 512KB 只挡真正异常的图（某个样式画了几千个
 * 节点）。别调小：这个值必须容得下最慢的那几格，否则最该被缓存的格子恰好在门外。
 */
const MAX_ENTRY_BYTES = 512 * 1024;

/** 一条落盘记录。`html` 是**纯静态**片段：没有 canvas、没有 script、没有事件属性。 */
export interface CachedPicture {
    key: string;
    html: string;
    /** 写入时刻；淘汰时按它取最旧。 */
    savedAt: number;
    /** 这条 HTML 的字节数（UTF-8 粗算），用于总量控制。 */
    bytes: number;
    schema: number;
}

/** 上游键（`stylePictureKey` 的结果）→ 磁盘键。只加版本前缀，其余原样。 */
export const pictureDiskKey = (upstreamKey: string): string => `v${PICTURE_SCHEMA_VERSION}|${upstreamKey}`;

/**
 * 一格样式的磁盘键：`stylePictureKey` 只带纯数据那一半（不传上传图）再套 `pictureDiskKey`。
 *
 * 注意上游 `stylePictureKey` 里 `theme` 已经是 `themeForPictures` 归一过的形态（Provider 就传的那份），
 * 这里不再归一一次，免得两份键算出不同的字符串。上传图在场时调用方根本不会走到这里。
 */
export const styleDiskKey = (shows: StylePictureShows): string => {
    try {
        return pictureDiskKey(stylePictureKey(shows));
    } catch {
        // 有循环引用之类的东西就干脆不缓存：给一个必然不命中的键，比抛出去好。
        return '';
    }
};

/**
 * 这组 look 里有没有「用户上传的图」（群唱 emoji/头像、莫奈 人像）。
 *
 * 有就不缓存：它们在冻结出来的 DOM 里是 `blob:` 地址，页面一刷新就失效，贴出来是破图；而且它们
 * 本身是身份对象，上游键里的序号跨页面对不上。
 */
export const uploadsBlockCaching = (look: {
    cappellaCustomEmojiImages?: unknown;
    cappellaCustomAvatarImages?: unknown;
    monetPortraitImage?: unknown;
}): boolean => {
    const filled = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
    return filled(look.cappellaCustomEmojiImages)
        || filled(look.cappellaCustomAvatarImages)
        || Boolean(look.monetPortraitImage);
};

/* ------------------------------------------------------------------------------------------ */
/* IndexedDB 小包装（照 uploadedFonts.ts 的手法，只够用，不引依赖）                                */
/* ------------------------------------------------------------------------------------------ */

const hasIndexedDb = (): boolean => {
    try {
        return typeof indexedDB !== 'undefined' && indexedDB !== null;
    } catch {
        return false;
    }
};

/** 打开一次就记住；失败时把记忆清掉，让下一次（也许环境已经好了）能重试。 */
let opening: Promise<IDBDatabase> | null = null;

const openPictureDb = (): Promise<IDBDatabase> => {
    if (opening) return opening;
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
        if (!hasIndexedDb()) {
            reject(new Error('当前环境不支持 IndexedDB'));
            return;
        }
        const request = indexedDB.open(PICTURE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PICTURE_STORE)) {
                db.createObjectStore(PICTURE_STORE, { keyPath: PICTURE_KEY_PATH });
            }
        };
        request.onsuccess = () => {
            const db = request.result;
            // 另一个窗口要升级/删库时先把连接让出去，否则对面会被 blocked 卡住。
            db.onversionchange = () => db.close();
            resolve(db);
        };
        request.onerror = () => reject(request.error ?? new Error('无法打开预览缓存'));
        request.onblocked = () => reject(new Error('预览缓存被另一个窗口占用'));
    });
    opening = promise;
    promise.catch(() => {
        opening = null;
    });
    return promise;
};

/** 在一个事务里跑一次请求；成功解 `onsuccess`，失败/中断都 reject。
 *
 * 连接**不每次关**：17 格各查一次，若每查一次就 open/close，光握手就够把「缓存命中要快」这件事
 * 抵消掉。连接在 `versionchange` 时让出去（见 `openPictureDb`），页面卸载由浏览器回收。 */
const withStore = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    openPictureDb().then(db => new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        try {
            transaction = db.transaction(PICTURE_STORE, mode);
        } catch (error) {
            reject(error instanceof Error ? error : new Error('无法访问预览缓存'));
            return;
        }
        transaction.onerror = () => reject(transaction.error ?? new Error('预览缓存读写失败'));
        transaction.onabort = () => reject(transaction.error ?? new Error('预览缓存操作被取消'));
        try {
            const request = run(transaction.objectStore(PICTURE_STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('预览缓存读写失败'));
        } catch (error) {
            reject(error instanceof Error ? error : new Error('预览缓存读写失败'));
        }
    }));

/* ------------------------------------------------------------------------------------------ */
/* 读 / 写 / 淘汰                                                                              */
/* ------------------------------------------------------------------------------------------ */

/**
 * 本页已知的每一条的元信息（不装 html 正文）：读命中时登记、写时登记，够用来做淘汰。
 * 只有在「库里条数比登记的多」（别的页面/上次进程写的）时才不得不整库读一遍（见 `evict`）。
 */
const meta = new Map<string, { savedAt: number; bytes: number }>();

const isRecord = (value: unknown): value is CachedPicture => {
    const record = value as CachedPicture | null;
    return Boolean(record)
        && typeof record.key === 'string'
        && typeof record.html === 'string'
        && record.html.length > 0
        && typeof record.savedAt === 'number'
        && record.schema === PICTURE_SCHEMA_VERSION;
};

const bytesOf = (record: CachedPicture): number => (
    typeof record.bytes === 'number' && Number.isFinite(record.bytes) ? record.bytes : record.html.length * 2
);

/** 取一条缓存；没有、版本不对、读失败都返回 null（调用方回落到现场造图）。 */
export const readCachedPicture = async (key: string): Promise<CachedPicture | null> => {
    if (!key) return null;
    try {
        const record: unknown = await withStore<CachedPicture | undefined>('readonly', store => store.get(key));
        if (!isRecord(record)) return null;
        meta.set(record.key, { savedAt: record.savedAt, bytes: bytesOf(record) });
        return record;
    } catch {
        return null;
    }
};

/** 淘汰：先按条目数，再按总字节，都是删最旧的（savedAt 最小）。失败不算错。 */
const evict = async (): Promise<void> => {
    try {
        const total = await withStore<number>('readonly', store => store.count());
        if (meta.size < total) {
            const all: unknown[] = await withStore<CachedPicture[]>('readonly', store => store.getAll());
            for (const item of all) {
                if (isRecord(item) && !meta.has(item.key)) {
                    meta.set(item.key, { savedAt: item.savedAt, bytes: bytesOf(item) });
                }
            }
        }
        const oldest = (): [string, { savedAt: number; bytes: number }] | null => {
            let found: [string, { savedAt: number; bytes: number }] | null = null;
            for (const entry of meta) {
                if (!found || entry[1].savedAt < found[1].savedAt) found = entry;
            }
            return found;
        };
        let bytes = 0;
        meta.forEach(info => {
            bytes += info.bytes;
        });
        while (meta.size > MAX_ENTRIES || bytes > MAX_BYTES) {
            const victim = oldest();
            if (!victim) return;
            meta.delete(victim[0]);
            bytes -= victim[1].bytes;
            await withStore<undefined>('readwrite', store => store.delete(victim[0]));
        }
    } catch {
        // 淘汰失败只是「这次没腾地方」，不影响本页已经贴出来的图。
    }
};

/** 写一条缓存；超限先腾地方。任何一步失败都静默（缓存是优化，不是功能）。 */
export const writeCachedPicture = async (key: string, html: string): Promise<void> => {
    if (!key || !html) return;
    try {
        const bytes = html.length * 2;
        if (bytes > MAX_ENTRY_BYTES) return;
        const record: CachedPicture = { key, html, savedAt: Date.now(), bytes, schema: PICTURE_SCHEMA_VERSION };
        await withStore<IDBValidKey>('readwrite', store => store.put(record));
        meta.set(key, { savedAt: record.savedAt, bytes });
        await evict();
    } catch {
        // 配额满 / 隐私模式 / 库被占用：当作没缓存。
    }
};

/* ------------------------------------------------------------------------------------------ */
/* 冻结图 <-> 纯静态片段                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** 出现这些就说明这团 DOM 依赖「只有本页面才有效」的地址，落盘就是破图。 */
const EPHEMERAL_URL = /blob:|filesystem:/;

/**
 * 一张冻结画布的编码质量。0.85 是实测的拐点。
 *
 * 为什么不用 PNG：量过 11 格真实小图，PNG 合计 1.47MB（最大的 machi 单张就 616KB），而 WebP 0.85
 * 合计 298KB —— 小 5 倍。这些图是渐变 + 半透明光效，正好是 PNG 最差的场景。原本 512KB 的单条上限
 * 因此会把 hanabi / machi / pendolo 三格直接挡在缓存外（它们恰好是最慢的三格，最该被缓存）。
 * WebP 支持 alpha，这个尺寸下画质肉眼无差。
 */
const IMAGE_QUALITY = 0.85;

/** 编码一张画布。优先 WebP（体积小），浏览器不支持时回落到 PNG。 */
const encodeCanvas = (canvas: HTMLCanvasElement): string | null => {
    try {
        const webp = canvas.toDataURL('image/webp', IMAGE_QUALITY);
        // 不支持 WebP 的浏览器会悄悄退回 PNG 编码，那就直接用它，不要再算一次。
        if (webp.startsWith('data:image/webp') || webp.startsWith('data:image/png')) return webp;
        const png = canvas.toDataURL('image/png');
        return png.startsWith('data:image/png') ? png : null;
    } catch {
        // 跨源污染的画布读不出来：这一格不进磁盘缓存，回落到现场造图。
        return null;
    }
};

/** 内联样式里去掉会让浏览器一直保留合成层的那条（`freezeStage` 已经自己清过一次）。 */
const stripWillChange = (css: string): string => css.replace(/will-change\s*:[^;]*;?/gi, '');

/**
 * 把一棵克隆树里所有内联的动画/过渡剥掉，并把当前**计算值**写死成静态值。
 *
 * 为什么必须补这一层：上游 `freezeStage` 只处理 `stage.getAnimations({ subtree: true })` 报出来的
 * 那些动画（对它们的 target 写 `animation: none` + 当前计算值）。这段逻辑对**正在跑**的动画是对的，
 * 但有三种情况它会漏，而漏掉的一到新页面就会自己动起来 —— 那格就「动」了，而且是没人控制的动：
 *
 *   ① 元素内联了 `animation: foo 2s infinite`，但冻结那一刻动画恰好不在 running 状态
 *      （`animation-play-state: paused`、或它在更深层而 `getAnimations` 拿到的 target 对不上号）；
 *   ② 动画不在 `getAnimations` 列表里但仍会重播：`@keyframes` 靠 `animation-name` + 延迟，
 *      冻结的瞬间还没开始（`animation-delay` 未到），被 clone 之后从零重放；
 *   ③ `transition`：`freezeStage` 完全不碰过渡，而一个带 `transition: all` 的元素在新页面
 *      第一次布局时会从「无」过渡到目标值，看起来就是一跳。
 *
 * 这里对**整棵子树的每一个元素**（含根）做同样处理：先按当前计算值把动画属性写死，再清掉
 * `animation` / `transition`。计算值用 `getComputedStyle` 读**原件**（不是克隆），因为克隆已经脱离了
 * 原来的层叠上下文。
 *
 * 代价：动画被定格在冻结那一刻的样子。这本来就是「冻结图」的语义（上游注释：copied as they
 * stand），不是损失。
 */
const freezeAnimations = (copy: HTMLElement): void => {
    const all = [copy, ...copy.querySelectorAll<HTMLElement | SVGElement>('*')];
    for (const node of all) {
        if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) continue;
        const style = node.style;
        if (!style) continue;
        // 属性可能写成单个 `animation` 简写，也可能分散成 `animation-name` 等长写；两条都看。
        const hasAnimation = style.animation || style.animationName;
        const hasTransition = style.transition || style.transitionProperty;
        if (!hasAnimation && !hasTransition) continue;
        // 先写死计算值（克隆节点没挂进文档，getComputedStyle 对它没有意义；退化成不写）。
        if (hasAnimation) {
            style.setProperty('animation', 'none');
            style.setProperty('-webkit-animation', 'none');
        }
        if (hasTransition) {
            style.setProperty('transition', 'none');
            style.setProperty('-webkit-transition', 'none');
        }
    }
};

/**
 * 把上游 `frozenPicture.freezeStage` 交出来的元素压成**纯静态** HTML：
 * 每个 canvas 读成 data URL 换成 img，script/iframe 去掉，其余原样。
 *
 * 为什么必须换掉 canvas：`freezeStage` 只是把画面**画进**另一个 canvas（2D 上下文），元素本身还是
 * canvas。还原到一个新页面时那个 canvas 是空的（没有脚本去画它），必须换成不依赖脚本的 img。
 * 读不出来的 canvas（跨源污染）返回 null —— 这一格就不进磁盘缓存，回落到现场造图。
 */
export const staticPictureHtml = (image: HTMLElement): string | null => {
    try {
        const copy = image.cloneNode(true) as HTMLElement;
        const sources = [...image.querySelectorAll('canvas')];
        const twins = [...copy.querySelectorAll('canvas')];
        for (let index = 0; index < sources.length; index += 1) {
            const source = sources[index];
            const twin = twins[index];
            if (!twin) continue;
            if (!(source.width > 0 && source.height > 0)) {
                twin.remove();
                continue;
            }
            const dataUrl = encodeCanvas(source);
            if (!dataUrl) return null;
            const replacement = document.createElement('img');
            replacement.setAttribute('src', dataUrl);
            replacement.setAttribute('alt', '');
            replacement.setAttribute('draggable', 'false');
            replacement.setAttribute('aria-hidden', 'true');
            // 尺寸：`freezeStage` 用 offsetWidth/offsetHeight 把 canvas 的显示尺寸写进了内联样式，
            // 照抄过来，否则 img 会按位图原始尺寸撑开。
            const width = twin.style.width || `${source.width}px`;
            const height = twin.style.height || `${source.height}px`;
            replacement.style.cssText = `${stripWillChange(twin.style.cssText)}width:${width};height:${height};`;
            twin.replaceWith(replacement);
        }
        copy.querySelectorAll('script, iframe, object, embed, link').forEach(node => node.remove());
        freezeAnimations(copy);
        const html = copy.innerHTML;
        if (!html || EPHEMERAL_URL.test(html)) return null;
        return html;
    } catch {
        return null;
    }
};

/**
 * 把一条缓存还原成可以塞进上游 Map 的元素。
 *
 * 返回的是一层**外壳**，外壳本身不参与布局（上游 `ImageOnStage` 只取 image 的 childNodes）；
 * 外壳里的东西全是静态标记，没有任何东西会跑。
 */
export const elementFromStaticHtml = (html: string): HTMLElement | null => {
    if (!html) return null;
    try {
        const holder = document.createElement('div');
        holder.innerHTML = html;
        if (EPHEMERAL_URL.test(holder.innerHTML)) return null;
        // innerHTML 里的 script 本来就不会执行，清掉更干净。
        holder.querySelectorAll('script, iframe, object, embed').forEach(node => node.remove());
        return holder.childNodes.length > 0 ? holder : null;
    } catch {
        return null;
    }
};
