/* 导入字体包：持久化 + 注册。
 *
 * 设置 UI 与 Folia 播放页是**同一个 document**（mount.tsx 把 React 岛挂进播放页自己的 DOM），所以
 * `document.fonts.add(new FontFace(family, bytes))` 注册出来的字族，播放器的渲染层（Pixi 的画布字体
 * 栈、以及 CSS 侧的 `font-family`）当场就能用——不需要再把字节喂给渲染器。
 *
 * 持久化用**自己的一只 IndexedDB**（`spw-folia-fonts` / 一个 `fonts` 仓库，主键 `id`），不去动
 * `stubs/db.ts`（那是给 Folia 组件桩用的，全部 no-op），也不依赖 dexie。
 *
 * 分工：
 *  - 字体**文件字节**留在这只 DB 里；
 *  - 字体的**描述符**（id/label/family/createdAt）走设置树（`model/settings.ts` 的
 *    `uploadedFonts`），由插件持久化，这样宿主重启后列表还在、字节按 id 再取回来重新注册。
 *
 * v0.4.0 */
import {
    useSettingsStore,
    type UploadedFontDescriptor,
} from './settings';

/** 单只字体包的上限，与 Folia 自身的移动端实现（services/customLyricsFont.ts）一致。 */
export const MAX_UPLOADED_FONT_SIZE = 50 * 1024 * 1024;

/** 浏览器能直接吃下的字体格式。 */
export const SUPPORTED_FONT_EXTENSIONS = ['.woff2', '.woff', '.ttf', '.otf'] as const;

/** 注册出去的字族一律加这个前缀，好和本机系统字体区分开（也便于 `customFontSource` 判断来源）。 */
export const UPLOADED_FONT_FAMILY_PREFIX = 'SpwFoliaFont';

/** 插件自己的 DB：名字固定，别改（改了旧用户的字体包就“丢”了）。 */
const FONT_DB_NAME = 'spw-folia-fonts';
const FONT_DB_VERSION = 1;
const FONT_STORE = 'fonts';

/** 一条落在 IndexedDB 里的记录：字节 + 描述符的副本。 */
interface StoredFontRecord {
    id: string;
    label: string;
    family: string;
    createdAt: number;
    data: ArrayBuffer;
}

const MIME_BY_EXTENSION: Record<string, string> = {
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
};

/** 已经注册到 `document.fonts` 的字族 → 注册结果。并发的重复注册只跑一次。 */
const registered = new Map<string, Promise<boolean>>();

/* ------------------------------------------------------------------------------------------ */
/* 校验                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** 文件的扩展名（小写，含点）；没有扩展名时给空串。 */
const fontExtensionOf = (name: string): string => {
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot).toLowerCase() : '';
};

/** 扩展名是否受支持（按文件名判断，MIME 在 Windows 上不可靠）。 */
export const isSupportedFontFile = (file: Pick<File, 'name'> | null | undefined): boolean => {
    if (!file || typeof file.name !== 'string') return false;
    return (SUPPORTED_FONT_EXTENSIONS as readonly string[]).includes(fontExtensionOf(file.name));
};

/** 非空的中文字体包错误；`null` 表示这份文件可以导入。 */
export const validateFontFile = (file: File | null | undefined): string | null => {
    if (!file) return '没有选择字体文件';
    if (!isSupportedFontFile(file)) {
        return '不支持的字体格式，请选择 .ttf / .otf / .woff / .woff2 文件';
    }
    if (file.size > MAX_UPLOADED_FONT_SIZE) {
        return '字体文件不能超过 50 MB';
    }
    if (file.size === 0) {
        return '字体文件是空的，请换一个文件';
    }
    return null;
};

/* ------------------------------------------------------------------------------------------ */
/* IndexedDB 小包装（只够用，不引依赖）                                                          */
/* ------------------------------------------------------------------------------------------ */

const hasIndexedDb = (): boolean => typeof indexedDB !== 'undefined' && indexedDB !== null;

/** 打开（首次会建）字体库。没有 IndexedDB（极老的 WebView2 / 隐私模式）时 reject。 */
const openFontDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
        reject(new Error('当前环境不支持本地字体存储'));
        return;
    }
    const request = indexedDB.open(FONT_DB_NAME, FONT_DB_VERSION);
    request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(FONT_STORE)) {
            db.createObjectStore(FONT_STORE, { keyPath: 'id' });
        }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开本地字体存储'));
    request.onblocked = () => reject(new Error('本地字体存储被另一个窗口占用'));
});

/** 在一个事务里跑一次请求，成功解 `onsuccess` 的结果，失败/中断都 reject。 */
const withStore = <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => openFontDb().then(db => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
        transaction = db.transaction(FONT_STORE, mode);
    } catch (error) {
        db.close();
        reject(error instanceof Error ? error : new Error('无法访问本地字体存储'));
        return;
    }
    const finish = (fn: () => void) => {
        db.close();
        fn();
    };
    transaction.oncomplete = () => undefined;
    transaction.onerror = () => finish(() => reject(transaction.error ?? new Error('本地字体存储读写失败')));
    transaction.onabort = () => finish(() => reject(transaction.error ?? new Error('本地字体存储操作被取消')));
    try {
        const request = run(transaction.objectStore(FONT_STORE));
        request.onsuccess = () => finish(() => resolve(request.result));
        request.onerror = () => finish(() => reject(request.error ?? new Error('本地字体存储读写失败')));
    } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error('本地字体存储读写失败')));
    }
}));

/* ------------------------------------------------------------------------------------------ */
/* 文件字节：存 / 取 / 删 / 列                                                                */
/* ------------------------------------------------------------------------------------------ */

/** 存一份字体字节。`id` 是主键（同一份文件重复导入会覆盖同一条）。 */
export const saveUploadedFontFile = async (
    id: string,
    blob: Blob,
    meta?: { label?: string; family?: string; createdAt?: number },
): Promise<void> => {
    const data = await blob.arrayBuffer();
    const record: StoredFontRecord = {
        id,
        label: meta?.label ?? id,
        family: meta?.family ?? id,
        createdAt: meta?.createdAt ?? Date.now(),
        data,
    };
    await withStore<IDBValidKey>('readwrite', store => store.put(record));
};

/** 取回一份字体字节；没有这条记录时给 `null`。 */
export const loadUploadedFontFile = async (id: string): Promise<Blob | null> => {
    const record = await withStore<StoredFontRecord | undefined>('readonly', store => store.get(id));
    if (!record?.data) return null;
    const extension = fontExtensionOf(record.label || id);
    return new Blob([record.data], { type: MIME_BY_EXTENSION[extension] ?? 'application/octet-stream' });
};

/** 删掉一份字体字节（不存在也算成功）。 */
export const deleteUploadedFontFile = async (id: string): Promise<void> => {
    await withStore<undefined>('readwrite', store => store.delete(id));
};

/** 库里所有字体包的 id。 */
export const listUploadedFontIds = async (): Promise<string[]> => {
    const keys = await withStore<IDBValidKey[]>('readonly', store => store.getAllKeys());
    return keys.map(key => String(key));
};

/* ------------------------------------------------------------------------------------------ */
/* 注册到 document.fonts                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** 播放页里是否已经有这个字族的面（已注册且加载完）。 */
const hasLoadedFace = (family: string): boolean => {
    if (typeof document === 'undefined' || !document.fonts) return false;
    let found = false;
    document.fonts.forEach(face => {
        if (face.family === family && (face.status === 'loaded' || face.status === 'loading')) found = true;
    });
    return found;
};

/**
 * 把一份已存进 DB 的字体包注册成网页可用的字族。
 * `descriptor.family` 已经在 `document.fonts` 里时直接成功（重复调用无副作用）。
 */
export const registerUploadedFont = async (
    descriptor: Pick<UploadedFontDescriptor, 'id' | 'family'>,
    blob?: Blob | null,
): Promise<boolean> => {
    const family = descriptor.family;
    if (!family) return false;
    if (hasLoadedFace(family)) return true;

    const cached = registered.get(family);
    if (cached) return cached;

    const task = (async (): Promise<boolean> => {
        try {
            if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) {
                return false;
            }
            const source = blob ?? (await loadUploadedFontFile(descriptor.id));
            if (!source) return false;
            const bytes = await source.arrayBuffer();
            if (!bytes.byteLength) return false;
            const face = new FontFace(family, bytes);
            await face.load();
            document.fonts.add(face);
            return true;
        } catch (error) {
            console.warn('[spw-folia] 字体注册失败', family, error);
            return false;
        }
    })();

    registered.set(family, task);
    const ok = await task;
    // 失败的不留缓存，下次（比如数据修好之后）还能重试。
    if (!ok) registered.delete(family);
    return ok;
};

/** 按字族确认可用：先查已注册的面，再回 DB 里翻同名记录补注册。找不到给 `false`。 */
export const ensureFontRegistered = async (family: string): Promise<boolean> => {
    const name = family?.trim();
    if (!name) return false;
    if (name.startsWith(`${UPLOADED_FONT_FAMILY_PREFIX}_`) && hasLoadedFace(name)) return true;
    if (hasLoadedFace(name)) return true;
    const cached = registered.get(name);
    if (cached) return cached;

    try {
        const ids = await listUploadedFontIds();
        for (const id of ids) {
            const descriptor = storeDescriptorFor(id);
            if (!descriptor || descriptor.family !== name) continue;
            const blob = await loadUploadedFontFile(id);
            if (await registerUploadedFont(descriptor, blob)) return true;
        }
    } catch (error) {
        console.warn('[spw-folia] 无法确认字体是否已注册', name, error);
    }
    return false;
};

/* ------------------------------------------------------------------------------------------ */
/* 描述符 <-> 设置树                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** 设置树里当前那批描述符（可能来自插件持久化的快照）。 */
const storeDescriptors = (): UploadedFontDescriptor[] => {
    try {
        return useSettingsStore.getState().uploadedFonts ?? [];
    } catch {
        return [];
    }
};

const storeDescriptorFor = (id: string): UploadedFontDescriptor | null =>
    storeDescriptors().find(font => font.id === id) ?? null;

/** 把一批描述符镜像进设置树（幂等：内容没变就不动 store，免得白白触发一次设置上行）。 */
const mirrorDescriptors = (descriptors: readonly UploadedFontDescriptor[]): void => {
    try {
        const state = useSettingsStore.getState();
        const before = (state.uploadedFonts ?? []).map(font => `${font.id}:${font.family}:${font.label}`).join('|');
        const after = descriptors.map(font => `${font.id}:${font.family}:${font.label}`).join('|');
        if (before === after) return;
        state.setUploadedFonts([...descriptors]);
    } catch (error) {
        console.warn('[spw-folia] 同步导入字体列表失败', error);
    }
};

/* ------------------------------------------------------------------------------------------ */
/* 导入 / 列出 / 删除 / 恢复                                                                   */
/* ------------------------------------------------------------------------------------------ */

/** FNV-1a（32 位）：给文件名 → 稳定的短哈希，用来在 id 里区分同名不同字的文件。 */
const shortHash = (text: string): string => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0').slice(0, 8);
};

/** `我的字体 v2.ttf` → `MyFont_v2` 形状的 slug；中文等被抹掉后为空时退回 `font`。 */
const slugifyFontName = (name: string): string => {
    const withoutExtension = name.slice(0, name.length - fontExtensionOf(name).length);
    const slug = withoutExtension
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 40);
    return slug || 'font';
};

/** 描述符里的显示名：去掉扩展名的文件名。 */
const labelForFile = (name: string): string => {
    const withoutExtension = name.slice(0, name.length - fontExtensionOf(name).length).trim();
    return withoutExtension || name.trim() || '未命名字体';
};

interface BuiltFontIdentity {
    id: string;
    label: string;
    family: string;
    familyName: string;
    createdAt: number;
}

/** 由文件本身算出稳定的 id 与字族：同一份文件重复导入得到同一条记录。 */
const buildFontIdentity = (file: File): BuiltFontIdentity => {
    const slug = slugifyFontName(file.name);
    const hash = shortHash(`${file.name}:${file.size}:${file.lastModified}`);
    const familyName = `${UPLOADED_FONT_FAMILY_PREFIX}_${slug}_${hash}`;
    return {
        id: familyName,
        family: familyName,
        familyName,
        label: labelForFile(file.name),
        createdAt: Date.now(),
    };
};

/**
 * 导入一个字体包：校验 → 读字节 → 落库 → 注册进 `document.fonts` → 写进设置树。
 * 失败一律抛 `Error`，message 是给用户看的中文。
 */
export const importFontFile = async (
    file: File,
): Promise<{ descriptor: UploadedFontDescriptor; familyName: string }> => {
    const invalid = validateFontFile(file);
    if (invalid) throw new Error(invalid);

    const identity = buildFontIdentity(file);
    let blob: Blob;
    try {
        blob = file.slice(0, file.size, MIME_BY_EXTENSION[fontExtensionOf(file.name)] ?? file.type);
        // 先 touched 一下字节，读不出来（磁盘错误 / 权限）在这里就报，不留一条坏记录。
        const bytes = await blob.arrayBuffer();
        if (!bytes.byteLength) throw new Error('字体文件是空的，请换一个文件');
        blob = new Blob([bytes], { type: blob.type });
    } catch (error) {
        throw new Error(error instanceof Error && error.message === '字体文件是空的，请换一个文件'
            ? error.message
            : '无法读取这个字体文件，请重新选择');
    }

    const registeredOk = await (async (): Promise<boolean> => {
        // 先注册再落库：注册失败（文件坏了、WebView 不认这个格式）就不该出现在列表里。
        if (typeof FontFace !== 'function' || typeof document === 'undefined' || !document.fonts) return false;
        try {
            const face = new FontFace(identity.familyName, await blob.arrayBuffer());
            await face.load();
            document.fonts.add(face);
            registered.set(identity.familyName, Promise.resolve(true));
            return true;
        } catch (error) {
            console.warn('[spw-folia] 字体解析失败', identity.familyName, error);
            return false;
        }
    })();

    if (!registeredOk) {
        throw new Error('这个字体文件读不出来，可能已损坏或不受支持');
    }

    try {
        await saveUploadedFontFile(identity.id, blob, {
            label: identity.label,
            family: identity.familyName,
            createdAt: identity.createdAt,
        });
    } catch (error) {
        console.warn('[spw-folia] 字体落库失败', identity.id, error);
        throw new Error('字体已加载，但保存到本地失败，重启后会丢失');
    }

    const descriptor: UploadedFontDescriptor = {
        id: identity.id,
        label: identity.label,
        family: identity.familyName,
        createdAt: identity.createdAt,
    };
    try {
        useSettingsStore.getState().addUploadedFont(descriptor);
    } catch (error) {
        console.warn('[spw-folia] 字体写入设置树失败', error);
    }
    return { descriptor, familyName: identity.familyName };
};

/** `importFontFile` 的别名（面板里按“导入”语义调用）。 */
export const importUploadedFont = importFontFile;

/** 设置树里那批描述符（列表 UI 直接读 store 也行，这里给一个非 React 的出口）。 */
export const listUploadedFonts = async (): Promise<UploadedFontDescriptor[]> => storeDescriptors();

/**
 * 删除一个导入的字体包：从设置树、从 IndexedDB、从 `document.fonts` 三处一起清掉。
 * 已经用这个字族渲染的歌词会回落到内置字体栈（设置树里指向它的 `customFontFamily` 由调用方清）。
 */
export const deleteUploadedFont = async (id: string): Promise<void> => {
    const descriptor = storeDescriptorFor(id);
    try {
        if (descriptor) {
            useSettingsStore.getState().removeUploadedFont(id);
        }
    } catch (error) {
        console.warn('[spw-folia] 字体从设置树移除失败', id, error);
    }
    if (descriptor) {
        registered.delete(descriptor.family);
        try {
            // `document.fonts` 只有 delete()，没有按名字删；把这一条面本身摘掉。
            const faces: FontFace[] = [];
            document.fonts?.forEach(face => {
                if (face.family === descriptor.family) faces.push(face);
            });
            for (const face of faces) document.fonts.delete(face);
        } catch (error) {
            console.warn('[spw-folia] 字体注销失败', descriptor.family, error);
        }
    }
    try {
        await deleteUploadedFontFile(id);
    } catch (error) {
        console.warn('[spw-folia] 字体字节删除失败', id, error);
    }
};

/** 把一批描述符全部重新注册一遍（各自尽力，互不影响）；返回成功注册的个数。 */
export const restoreUploadedFonts = async (
    descriptors: readonly UploadedFontDescriptor[] | null | undefined,
): Promise<number> => {
    let ok = 0;
    for (const descriptor of descriptors ?? []) {
        if (!descriptor?.id || !descriptor.family) continue;
        try {
            const blob = await loadUploadedFontFile(descriptor.id);
            if (await registerUploadedFont(descriptor, blob)) ok += 1;
        } catch (error) {
            // 单个字体坏掉不能拖垮开机流程。
            console.warn('[spw-folia] 恢复字体失败', descriptor.id, error);
        }
    }
    return ok;
};

/**
 * 开机恢复：把设置树里的描述符逐个重新注册，并且把 DB 里存在、设置树里漏掉的记录补回去
 * （插件换机/重装后设置快照可能先到，也可能晚到）。**绝不抛**。
 */
export const restoreAllUploadedFonts = async (): Promise<void> => {
    try {
        const descriptors = storeDescriptors();
        await restoreUploadedFonts(descriptors);

        // DB 里比设置树多出来的记录：补进设置树（设置快照可能还没到）。
        const known = new Set(descriptors.map(font => font.id));
        const ids = await listUploadedFontIds();
        const missing = ids.filter(id => !known.has(id));
        if (missing.length === 0) return;

        const recovered: UploadedFontDescriptor[] = [];
        for (const id of missing) {
            try {
                const record = await withStore<StoredFontRecord | undefined>('readonly', store => store.get(id));
                if (!record?.family) continue;
                const descriptor: UploadedFontDescriptor = {
                    id: record.id,
                    label: record.label || record.family,
                    family: record.family,
                    createdAt: record.createdAt || Date.now(),
                };
                const blob = record.data ? new Blob([record.data]) : null;
                if (await registerUploadedFont(descriptor, blob)) recovered.push(descriptor);
            } catch (error) {
                console.warn('[spw-folia] 补回字体失败', id, error);
            }
        }
        if (recovered.length > 0) mirrorDescriptors([...descriptors, ...recovered]);
    } catch (error) {
        console.warn('[spw-folia] 恢复导入字体失败', error);
    }
};
