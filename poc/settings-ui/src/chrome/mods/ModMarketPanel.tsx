/* issue #23 · 模组市场（设置岛里的**平级模态**，不是第 5 个 tab）。
 *
 * ## 为什么是平级模态
 *
 * 上游 `VisPlaygroundSettingsPanel` 的 tab 集合是闭集
 * （`VisPlaygroundEditSection = 'common'|'background'|'visualizer'|'subtitle'|'global'`，
 * `work/folia/…/VisPlaygroundPreviewHotspots.tsx:7`），而且 `vite.config.ts:286-291` 正在用
 * SETTINGS_SURGERY **把 `global` 拿掉** —— 往那个面板上加 tab 会同时踩上游结构与构建期改写两处。
 * 所以照 `FontPickerModal` 的形状：`App.tsx` 持 `open` 状态，本组件自己画遮罩 + 自建窗口。
 *
 * ## 层级（铁律，别改错方向）
 *
 * 岛的容器 `#spw-settings-ui-root` 的 z-index 是 **100**，必须 **< 200**（`docs/lessons.md` §4.1：
 * Folia 把下拉菜单/Sheet/Tooltip 都 `createPortal` 到 `document.body`，它们是岛的**兄弟节点**，
 * 岛只要高于 200 就会把它们全部压在设置窗背后 —— 症状是「下拉点了没反应」）。门禁
 * `packaging/tools/verify-select-layers.mjs:332-336` 守着这条。
 *
 * ⇒ **绝不能靠调大岛的 z-index 来盖住别的东西。** 本模态用的是**岛内部**那组 `214748xxxx`
 * （`app.css` 里 chrome 按钮 / 播放条 / 问题面板共用同一组数），照 `FontPickerModal.tsx:59-60`：
 * `MODAL_Z_INDEX = 2147483200`。它比 StudioWindow（z-140）和设置浮层容器（2147483000）都高，
 * 但整组数都在岛**里面**，所以不会影响岛与上游浮层的关系。
 *
 * ## 数据通道（单写者）
 *
 * - 读：`useInjectedMods()`（注入成员 `mods`，插件拥有）；
 * - 写：`modAction({action:'install'|'uninstall'|'setEnabled'|'openFolder', …})`，平铺信封；
 * - 结果回流：插件推新的设置树 → `settings` 事件 → 市场页自动刷新。**页面不维护第二份清单真相。**
 *
 * ## 联网纪律
 *
 * 只请求 `catalog.json`（有 CORS）。**不 fetch 模组 zip**（无 CORS，`repo-report.md` §7.2），
 * 下载由插件做。preview 图用 `<img src>`（图片不受 CORS 限制）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    Check,
    Download,
    ExternalLink,
    FolderOpen,
    Loader2,
    Package,
    RefreshCw,
    Search,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import { bridgeOn, modAction, newModActionId, openExternalUrl, openModsFolder, type ModProgressMessage } from '~/bridge';
import { useInjectedMods, type InjectedMod } from '~/model/useInjectedMods';
import { MOD_MARKET_BASE, MOD_MARKET_HOST, MOD_MARKET_URL } from './modCatalog';
import {
    filterCatalog,
    formatBytes,
    groupByOrigin,
    MOD_ORIGINS,
    type ModCatalogEntry,
    type ModOrigin,
} from './modCatalog';
import { useModCatalog, type CatalogState } from './useModCatalog';

/** 模态自己的层级：在 StudioWindow（z-140）与设置浮层容器（2147483000）之上，但仍在岛内部。 */
const MODAL_Z_INDEX = 2147483200;

const ROW_IDLE = 'text-zinc-300 hover:border-white/10 hover:bg-white/[0.06] hover:text-zinc-50';
const SECTION_TITLE = 'px-1 text-[12px] font-semibold uppercase tracking-wide text-zinc-500';

/** 分组标题的文案 key（`i18n.ts` 的 `LOCAL_KEYS.options`）。
 *
 * ⚠️ 必须带 `options.` 前缀。v0.5.2 这三条写的是裸键名（`'modMarketOfficial'`），而 `LOCAL_KEYS`
 * 的成员都挂在 `options` 下面，于是 `t()` 找不到、i18next 把键名原样吐回来 —— 界面上就是三个大写
 * 的 `MODMARKETOFFICIAL` / `MODMARKETCOMMUNITY` / `MODMARKETBETA` 分组标题（用户截图里就是这三行）。
 * 这不是「缺翻译」而是**拼错的键**，所以它在两种语言下都会露出来，而其它文案都正常。 */
const ORIGIN_LABEL_KEYS: Record<ModOrigin, string> = {
    official: 'options.modMarketOfficial',
    community: 'options.modMarketCommunity',
    beta: 'options.modMarketBeta',
};

export interface ModMarketPanelProps {
    open: boolean;
    onClose: () => void;
    /**
     * v0.5.3: 这个面板**就是整个窗口**（市场专用小窗），不是播放页上的一层模态。
     *
     * 两种形态的差别不是外观偏好，是**有没有别的东西在后面**：
     *  - 设置岛里的模态（默认）：整屏遮罩 `bg-black/60` + `p-4` + 居中，用遮罩把播放页压暗；
     *  - 独立小窗（本 prop 为 true）：没有播放页可压，遮罩只会变成一圈**黑边**（用户报的就是这个），
     *    所以去掉遮罩与内边距，让面板铺满窗口、自己当窗口内容。
     *
     * 用 prop 而不是让调用方改 CSS：遮罩和层级是面板自己的结构，外部只能靠 `!important` 去掰，
     * 那会在下次改版时静默失效。
     */
    standalone?: boolean;
}

/** 从一个 http(s) 地址里取出裸主机名，取不到就原样回显（提示里不能因此空掉）。 */
const hostOf = (url: string): string => {
    try {
        return new URL(url).host || url;
    } catch {
        return url;
    }
};

/** 一条已装模组在「已装」小节里的行。 */
const InstalledRow: React.FC<{
    mod: InjectedMod;
    t: (key: string) => string;
    onAction: (action: 'uninstall' | 'setEnabled', mod: InjectedMod, enabled?: boolean) => void;
}> = ({ mod, t, onAction }) => (
    <div
        className={`flex items-center gap-2 rounded-xl border border-transparent px-3 py-2 ${ROW_IDLE}`}
        data-spw-installed-mod={mod.id}
    >
        <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-zinc-100">{mod.name}</span>
            <span className="block truncate text-[11px] text-zinc-500">
                {[mod.version, mod.author].filter(Boolean).join(' · ') || mod.id}
            </span>
            {mod.error ? (
                <span className="mt-0.5 block truncate text-[11px] text-amber-300/90" data-spw-mod-error="true">
                    {mod.error}
                </span>
            ) : null}
        </span>
        <button
            type="button"
            role="switch"
            aria-checked={mod.enabled ? 'true' : 'false'}
            aria-label={mod.enabled ? t('options.modMarketDisable') : t('options.modMarketEnable')}
            title={mod.enabled ? t('options.modMarketDisable') : t('options.modMarketEnable')}
            data-spw-mod-toggle={mod.id}
            onClick={() => onAction('setEnabled', mod, !mod.enabled)}
            className={`h-6 shrink-0 rounded-full px-2 text-[11px] transition-colors ${mod.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-zinc-400'}`}
        >
            {mod.enabled ? t('options.modMarketEnabled') : t('options.modMarketDisabled')}
        </button>
        <button
            type="button"
            aria-label={t('options.modMarketUninstall')}
            title={t('options.modMarketUninstall')}
            data-spw-mod-uninstall={mod.id}
            onClick={() => onAction('uninstall', mod)}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-red-300"
        >
            <Trash2 size={14} />
        </button>
    </div>
);

/**
 * 一条安装进度在卡片上画成的条（issue #23 第二轮）。
 *
 * 三种形态，区别是**分母到底存不存在**：
 *   - `total > 0` → 真进度条（宽度 = 百分比）；
 *   - `total <= 0` → 不定长条（`animate-pulse`），因为服务器没给 `Content-Length`，或这一阶段
 *     本来就没有可数的总量（解包）；
 *   - `phase === 'done'` → 不画（调用方在拿到已装清单后就把这一条清掉了，这里只是兜底）。
 *
 * 文案跟着 `phase` 走，而不是笼统的「下载中」：用户看到的「校验中」能解释为什么文件已经在磁盘上
 * 了却还没出现在「已安装」里。
 */
const PHASE_LABEL_KEYS: Record<Exclude<ModProgressMessage['phase'], 'done'>, string> = {
    download: 'modMarketPhaseDownload',
    verify: 'modMarketPhaseVerify',
    unpack: 'modMarketPhaseUnpack',
};

const ProgressBar: React.FC<{ progress: ModProgressMessage; t: (key: string, options?: Record<string, unknown>) => string }> = ({ progress, t }) => {
    if (progress.phase === 'done') return null;
    const determinate = progress.total > 0;
    const percent = determinate
        ? Math.max(0, Math.min(100, Math.round((progress.received / progress.total) * 100)))
        : 0;
    return (
        <div className="mt-1.5" data-spw-market-progress-phase={progress.phase}>
            <div className="mb-1 flex items-center gap-1.5 text-[10px] text-zinc-400">
                <Loader2 size={10} className="animate-spin" aria-hidden="true" />
                <span>{t(PHASE_LABEL_KEYS[progress.phase])}</span>
                {determinate ? <span className="text-zinc-500">{percent}%</span> : null}
            </div>
            <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
                <div
                    className={`h-full rounded-full bg-emerald-400 ${determinate ? 'transition-[width] duration-200' : 'animate-pulse'}`}
                    style={{ width: determinate ? `${percent}%` : '100%' }}
                    data-spw-market-progress-width={determinate ? String(percent) : 'indeterminate'}
                />
            </div>
        </div>
    );
};

/**
 * 市场里的一条卡片。**已装**时高亮并换成「卸载 / 启用-禁用」，未装时给「安装」（前提是
 * `canInstall`：缺 `download.sha256` 的条目不显示安装按钮 —— 我们要求校验）。
 *
 * issue #23 第二轮：**整张卡可点，点开该模组的网站**（用户要求「点击商店里的模组自动跳转到该
 * 模组的网站」）。卡片本体因此必须能区分「点在卡上」与「点在卡里的按钮上」：
 *   - 用 `closest('button, a, input, [role="switch"]')` 判断，命中就放行给按钮自己的 handler；
 *   - 卡片保持 `div` + `role="group"`（不是 `role="button"`）：里面有 `<button>`，嵌套交互元素是
 *     无效结构，而且会让安装按钮的点击语义变模糊；
 *   - `cursor` 用**内联 style** 而不是 Tailwind 的 `cursor-pointer` 类：`verify-click-zones.mjs`
 *     按 `classList` 里出现 `cursor-pointer` 找「歌词竖排挂件」，多一个候选会破坏那个门禁。
 * 另外给一个显式的 `<button>`（外链图标），键盘用户不必去猜「卡片能点」。
 */
const MarketCard: React.FC<{
    entry: ModCatalogEntry;
    installed: InjectedMod | null;
    progress: ModProgressMessage | null;
    t: (key: string, options?: Record<string, unknown>) => string;
    onInstall: (entry: ModCatalogEntry) => void;
    onUninstall: (mod: InjectedMod) => void;
    onToggle: (mod: InjectedMod) => void;
    onOpenSite: (entry: ModCatalogEntry) => void;
}> = ({ entry, installed, progress, t, onInstall, onUninstall, onToggle, onOpenSite }) => {
    const size = formatBytes(entry.downloadSize);
    return (
        <div
            className={`flex flex-col overflow-hidden rounded-xl border transition-colors ${installed ? 'border-white/15 bg-white/[0.07]' : 'border-white/10 bg-white/[0.03] hover:border-white/20'}`}
            data-spw-market-card={entry.id}
            data-installed={installed ? 'true' : 'false'}
            role="group"
            aria-label={entry.name}
            style={{ cursor: 'pointer' }}
            onClick={event => {
                const target = event.target as HTMLElement | null;
                // 卡内的按钮/输入自己处理点击：安装、卸载、启用、外链都不该同时打开网站。
                if (target && target.closest('button, a, input, select, textarea, [role="switch"]')) return;
                onOpenSite(entry);
            }}
        >
            <div className="relative aspect-[16/9] w-full overflow-hidden bg-black/40">
                {entry.previewUrl ? (
                    <img
                        src={entry.previewUrl}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        decoding="async"
                        draggable={false}
                        className="h-full w-full object-cover"
                        data-spw-market-preview={entry.id}
                    />
                ) : (
                    <span className="grid h-full w-full place-items-center text-zinc-600">
                        <Package size={26} aria-hidden="true" />
                    </span>
                )}
                {installed ? (
                    <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-emerald-500/85 px-2 py-0.5 text-[11px] font-medium text-black">
                        <Check size={11} aria-hidden="true" />
                        {t('options.modMarketInstalled')}
                    </span>
                ) : null}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 px-3 py-2.5">
                <div className="flex items-baseline gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-100" title={entry.name}>
                        {entry.name}
                    </span>
                    {entry.version ? <span className="shrink-0 text-[11px] text-zinc-500">{entry.version}</span> : null}
                </div>
                <div className="truncate text-[11px] text-zinc-500">
                    {[entry.author || null, entry.foliaRange ? `Folia ${entry.foliaRange}` : null, size]
                        .filter(Boolean)
                        .join(' · ')}
                </div>
                {entry.description ? (
                    <p className="line-clamp-2 text-[11px] leading-snug text-zinc-400">{entry.description}</p>
                ) : null}
                {progress ? <ProgressBar progress={progress} t={t} /> : null}
                <div className="mt-auto flex items-center gap-1.5 pt-1">
                    <span
                        className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-zinc-400"
                        title={t('options.modMarketPermissions')}
                    >
                        <ShieldCheck size={10} aria-hidden="true" />
                        {entry.permissions.length}
                    </span>
                    <div className="flex-1" />
                    {/* 显式的外链入口：卡片本体也能点，但「能点」这件事不该只靠光标形状表达。
                     *  stopPropagation 是必需的 —— 否则会同时走卡片自己的 onClick，开两次浏览器。 */}
                    <button
                        type="button"
                        data-spw-market-open-site={entry.id}
                        aria-label={t('options.modMarketOpenSite')}
                        title={t('options.modMarketOpenSite')}
                        onClick={event => {
                            event.stopPropagation();
                            onOpenSite(entry);
                        }}
                        className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.06] text-zinc-400 transition-colors hover:bg-white/[0.14] hover:text-zinc-100"
                    >
                        <ExternalLink size={13} aria-hidden="true" />
                    </button>
                    {installed ? (
                        <>
                            <button
                                type="button"
                                data-spw-market-toggle={entry.id}
                                onClick={() => onToggle(installed)}
                                className={`h-7 rounded-lg px-2 text-[11px] transition-colors ${installed.enabled ? 'bg-white/10 text-zinc-200 hover:bg-white/[0.16]' : 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30'}`}
                            >
                                {installed.enabled ? t('options.modMarketDisable') : t('options.modMarketEnable')}
                            </button>
                            <button
                                type="button"
                                data-spw-market-uninstall={entry.id}
                                onClick={() => onUninstall(installed)}
                                className="grid h-7 w-7 place-items-center rounded-lg bg-white/[0.06] text-zinc-400 transition-colors hover:bg-red-500/15 hover:text-red-300"
                                aria-label={t('options.modMarketUninstall')}
                                title={t('options.modMarketUninstall')}
                            >
                                <Trash2 size={13} aria-hidden="true" />
                            </button>
                        </>
                    ) : entry.canInstall ? (
                        <button
                            type="button"
                            data-spw-market-install={entry.id}
                            onClick={() => onInstall(entry)}
                            className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-500/20 px-2 text-[11px] text-emerald-300 transition-colors hover:bg-emerald-500/30"
                        >
                            <Download size={12} aria-hidden="true" />
                            {t('options.modMarketInstall')}
                        </button>
                    ) : (
                        /* 缺校验信息 ⇒ 不给安装按钮（绝不装一个不校验的包）。 */
                        <span
                            className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/[0.04] px-2 text-[11px] text-zinc-500"
                            data-spw-market-unverifiable={entry.id}
                            title={t('options.modMarketUnverifiable')}
                        >
                            <AlertTriangle size={11} aria-hidden="true" />
                            {t('options.modMarketUnverifiableShort')}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

export const ModMarketPanel: React.FC<ModMarketPanelProps> = ({ open, onClose, standalone = false }) => {
    const { t } = useTranslation();
    const mods = useInjectedMods();
    const catalogState = useModCatalog(open);
    const [query, setQuery] = useState('');
    const [pending, setPending] = useState<string | null>(null);
    /** 当前这次安装的 `actionId`：进度消息按它认领，避免把上一次的残留画到这一张卡上。 */
    const pendingActionId = useRef<string | null>(null);
    /** 每张卡片的进度（`modId` → 最近一条）。`done` 到达或清单里出现该模组时删掉。 */
    const [progress, setProgress] = useState<Record<string, ModProgressMessage>>({});
    /** 「已在浏览器中打开」那条提示；4 秒后自动消失。 */
    const [notice, setNotice] = useState<string | null>(null);
    const noticeTimer = useRef<number | null>(null);

    const showNotice = useCallback((text: string) => {
        setNotice(text);
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
        noticeTimer.current = window.setTimeout(() => {
            noticeTimer.current = null;
            setNotice(null);
        }, 4000);
    }, []);

    // 每次打开回到干净状态：搜索词、「正在安装哪一个」、进度与提示都不该留到下一次。
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setPending(null);
        setProgress({});
        setNotice(null);
        pendingActionId.current = null;
        if (noticeTimer.current !== null) {
            window.clearTimeout(noticeTimer.current);
            noticeTimer.current = null;
        }
    }, [open]);

    /* issue #23 第二轮：安装进度（插件节流后经宿主转发）。
     *
     * 只认自己发出去的那一个 `actionId`：面板同一时刻只装一个，但旧消息（上一次失败的残留、
     * 另一个窗口的安装）不能把进度画到这张卡上。老版本插件不会发这条消息，那时卡片只有
     * `pending` 的不定长条（见 `MarketCard` 的 progress 兜底）。 */
    useEffect(() => {
        if (!open) return undefined;
        const off = bridgeOn<ModProgressMessage>('modProgress', payload => {
            if (!payload || typeof payload !== 'object') return;
            const expected = pendingActionId.current;
            if (expected !== null && payload.actionId && payload.actionId !== expected) return;
            const modId = payload.modId;
            if (!modId) return;
            if (payload.phase === 'done') {
                setProgress(current => {
                    if (!(modId in current)) return current;
                    const next = { ...current };
                    delete next[modId];
                    return next;
                });
                return;
            }
            setProgress(current => ({ ...current, [modId]: payload }));
        });
        return off;
    }, [open]);

    useEffect(() => () => {
        if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    }, []);

    const installedById = useMemo(() => {
        const map = new Map<string, InjectedMod>();
        for (const mod of mods) map.set(mod.id, mod);
        return map;
    }, [mods]);

    /* 安装成功的信号是**清单里出现了这个 id**（插件重推设置树），不是 `done`：`done` 在失败时也发。
     * 出现即收掉进度条 —— 卡片这时已经切成「已装」，再挂一条进度条会自相矛盾。 */
    useEffect(() => {
        setProgress(current => {
            let changed = false;
            const next: Record<string, ModProgressMessage> = {};
            for (const [modId, value] of Object.entries(current)) {
                if (installedById.has(modId)) {
                    changed = true;
                    continue;
                }
                next[modId] = value;
            }
            return changed ? next : current;
        });
    }, [installedById]);

    const entries = catalogState.catalog?.entries ?? [];
    const filtered = useMemo(() => filterCatalog(entries, query), [entries, query]);
    const groups = useMemo(() => groupByOrigin(filtered), [filtered]);
    /* 已装清单的搜索：与 catalog 搜索同一套匹配规则，但输入是**已装**那份（离线时它照样能用）。 */
    const installedList = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        if (needle === '') return mods;
        return mods.filter(mod =>
            mod.id.toLocaleLowerCase().includes(needle)
            || mod.name.toLocaleLowerCase().includes(needle)
            || mod.author.toLocaleLowerCase().includes(needle));
    }, [mods, query]);

    const onInstall = (entry: ModCatalogEntry): void => {
        if (!entry.canInstall || !entry.downloadUrl || !entry.downloadSha256 || !entry.downloadFileName) return;
        // `actionId` 自己生成并留着：进度消息按它配对（见上面的 modProgress 订阅）。
        const actionId = newModActionId();
        pendingActionId.current = actionId;
        setPending(entry.id);
        setProgress(current => {
            if (!(entry.id in current)) return current;
            const next = { ...current };
            delete next[entry.id];
            return next;
        });
        modAction({
            action: 'install',
            actionId,
            modId: entry.id,
            download: {
                url: entry.downloadUrl,
                sha256: entry.downloadSha256,
                fileName: entry.downloadFileName,
            },
            /* catalog 原文一并给插件：它要用 name/version/author 兜底、并留日志。
             * 体积很小（一条几百字节），不走文件。 */
            mod: {
                id: entry.id,
                name: entry.name,
                version: entry.version,
                author: entry.author,
                origin: entry.origin,
                permissions: entry.permissions,
            },
        });
        // 结果由插件推新的设置树回来（页面不自己改清单）；这里只把按钮从「安装」切到等待态。
        // 90 s 而不是 30 s：插件给整次下载的预算是 60 s（`FoliaModDownloads.DEADLINE_MS`），
        // 加上校验与解包，30 s 会在一个慢网络下把进度条提前收掉。
        window.setTimeout(() => setPending(current => (current === entry.id ? null : current)), 90_000);
    };

    /**
     * 打开一个模组的网站（issue #23 第二轮）。
     *
     * 目标优先用 catalog 的 `source`（社区/Beta 条目才有的 GitHub 仓库），否则用市场自己的锚点
     * `根 + #mod-<id>` —— 那个锚点在站点首页里是真实存在的（`id="mod-<id>"`）。
     *
     * 宿主只接受 http(s)（`HostForm.OpenExternalUrl`），而 `openExternalUrl` 是**单向**的、没有
     * ack，所以这条提示是「已经请求宿主打开」，不是「浏览器确实起来了」。在 dev.html 里根本没有
     * 宿主，提示照样会出现 —— 那是开发壳的已知差异，写在这里免得下次有人当 bug 查。
     */
    const onOpenSite = (entry: ModCatalogEntry): void => {
        const url = entry.sourceUrl ?? entry.marketUrl;
        openExternalUrl(url);
        showNotice(t('options.modMarketSiteOpened', { host: hostOf(url) }));
    };

    const onUninstall = (mod: InjectedMod): void => {
        modAction({ action: 'uninstall', modId: mod.id });
    };

    const onToggle = (mod: InjectedMod): void => {
        modAction({ action: 'setEnabled', modId: mod.id, enabled: !mod.enabled });
    };

    if (!open) return null;

    return (
        <div
            className={
                standalone
                    // 独立小窗：铺满窗口、无遮罩、无内边距 —— 没有播放页要压暗，遮罩只会变成一圈黑边。
                    ? 'font-sans fixed inset-0 flex items-stretch justify-center'
                    : 'font-sans fixed inset-0 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm'
            }
            style={{ zIndex: MODAL_Z_INDEX, pointerEvents: 'auto' }}
            data-spw-mod-market="true"
            data-spw-mod-market-status={catalogState.status}
            data-spw-mod-market-standalone={standalone ? 'true' : 'false'}
            role="dialog"
            aria-modal="true"
            aria-label={t('options.modMarketTitle')}
            onMouseDown={event => {
                // 只有从遮罩本身按下的关闭才算（拖拽出面板的松开不算），与 FontPickerModal 一致。
                // 独立小窗里没有遮罩，所以这条分支自然不成立 —— 关窗靠标题栏的 × 与页脚的按钮。
                if (!standalone && event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className={
                    standalone
                        // 面板自己就是窗口：占满、不要圆角与投影（它们只在「浮在别的东西上面」时才成立）。
                        ? 'flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-[#1a1a1d] text-zinc-200'
                        : 'flex max-h-[min(760px,88vh)] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1a1a1d] text-zinc-200 shadow-[0_32px_90px_rgba(0,0,0,0.6)]'
                }
                data-spw-mod-market-card="true"
                onMouseDown={event => event.stopPropagation()}
            >
                <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold text-zinc-100">{t('options.modMarketTitle')}</h2>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                        {t('options.modMarketBetaBadge')}
                    </span>
                    <div className="flex-1" />
                    {/* issue #23 第二轮：市场官网地址，放在「打开模组文件夹」左边（用户指定位置）。
                     *  标签是「模组网站」四个字而不是域名（用户：官网按钮不要显示一串网站，直接写
                     *  「模组网站」）—— 一串域名对用户没有信息量，还会挤掉右边两个按钮的位置。
                     *  域名仍然在 `title` 里，鼠标停上去能看到去哪。
                     *  地址由 `modCatalog.ts` 的 `MOD_MARKET_URL` 派生 —— 市场域名全仓只能在那里出现
                     *  （`verify-mod-market.mjs` 的静态检查按这个前提工作，它扫的是**文件文本**，
                     *  所以连注释里都不要写出那个域名）。 */}
                    <button
                        type="button"
                        data-spw-mod-market-open-site="true"
                        onClick={() => {
                            openExternalUrl(MOD_MARKET_URL);
                            showNotice(t('options.modMarketSiteOpened', { host: MOD_MARKET_HOST }));
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-2.5 text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.14] hover:text-zinc-50"
                        title={`${t('options.modMarketOpenSiteHint')}（${MOD_MARKET_HOST}）`}
                        aria-label={t('options.modMarketOpenSiteHint')}
                    >
                        <ExternalLink size={13} aria-hidden="true" />
                        <span>{t('options.modMarketSiteButton')}</span>
                    </button>
                    <button
                        type="button"
                        data-spw-mod-market-opens-folder="true"
                        onClick={() => openModsFolder()}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2.5 text-[12px] text-zinc-100 transition-colors hover:bg-white/[0.16]"
                        title={t('options.modMarketOpenFolder')}
                    >
                        <FolderOpen size={13} aria-hidden="true" />
                        {t('options.modMarketOpenFolder')}
                    </button>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('ui.close')}
                        data-spw-mod-market-close="true"
                        className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
                    >
                        <X size={16} aria-hidden="true" />
                    </button>
                </header>

                <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-5 py-2.5">
                    <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2">
                        <Search size={13} className="shrink-0 text-zinc-500" aria-hidden="true" />
                        <input
                            type="search"
                            value={query}
                            onChange={event => setQuery(event.target.value)}
                            placeholder={t('options.modMarketSearch')}
                            aria-label={t('options.modMarketSearch')}
                            data-spw-mod-market-search="true"
                            className="h-7 w-[220px] bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
                        />
                    </div>
                    <div className="flex-1" />
                    <CatalogBadge state={catalogState} t={t} onRetry={catalogState.refresh} />
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {/* 已装（永远是第一组，且**不依赖 catalog**：离线时它是唯一还能用的部分）。 */}
                    <section className="mb-4" data-spw-installed-list="true">
                        <div className="mb-2 flex items-center gap-2">
                            <h3 className={SECTION_TITLE}>{t('options.modMarketInstalledSection')}</h3>
                            <span className="text-[12px] text-zinc-600">{installedList.length}</span>
                        </div>
                        {installedList.length === 0 ? (
                            <p className="px-1 py-2 text-[13px] text-zinc-500" data-spw-installed-empty="true">
                                {t('options.modMarketInstalledEmpty')}
                            </p>
                        ) : (
                            <div className="flex flex-col gap-0.5">
                                {installedList.map(mod => (
                                    <InstalledRow key={mod.id} mod={mod} t={t} onAction={(action, target, enabled) => {
                                        if (action === 'uninstall') onUninstall(target);
                                        else modAction({ action: 'setEnabled', modId: target.id, enabled: enabled === true });
                                    }} />
                                ))}
                            </div>
                        )}
                    </section>

                    {/* catalog 的三组。除了 `ready`，其它三态各自有明确的说明（离线 ≠ 空）。 */}
                    {catalogState.status === 'ready' && catalogState.catalog ? (
                        MOD_ORIGINS.map(origin => {
                            const list = groups[origin];
                            if (list.length === 0) return null;
                            return (
                                <section key={origin} className="mb-4" data-spw-market-group={origin}>
                                    <div className="mb-2 flex items-center gap-2">
                                        <h3 className={SECTION_TITLE}>{t(ORIGIN_LABEL_KEYS[origin])}</h3>
                                        <span className="text-[12px] text-zinc-600">{list.length}</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                        {list.map(entry => (
                                            <MarketCard
                                                key={entry.id}
                                                entry={entry}
                                                installed={installedById.get(entry.id) ?? null}
                                                progress={progress[entry.id] ?? null}
                                                t={t}
                                                onInstall={onInstall}
                                                onUninstall={onUninstall}
                                                onToggle={onToggle}
                                                onOpenSite={onOpenSite}
                                            />
                                        ))}
                                    </div>
                                </section>
                            );
                        })
                    ) : (
                        <CatalogNotice state={catalogState} t={t} />
                    )}

                    {pending ? (
                        <p className="px-1 py-2 text-[12px] text-amber-300/90" data-spw-mod-installing="true">
                            <Loader2 size={12} className="mr-1 inline animate-spin" aria-hidden="true" />
                            {t('options.modMarketInstalling')}
                        </p>
                    ) : null}
                </div>

                {/* issue #23 第二轮：「已在浏览器中打开」的提示。
                 *  放在页脚**之上**、滚动区**之外**：它是一条 4 秒的瞬时状态，跟着内容滚走就等于没提
                 *  醒。`role="status"` + `aria-live="polite"` 让读屏也听得到。
                 *  `openExternalUrl` 是单向的（宿主没有 ack），所以文案说的是「已打开」而不是「成功」。 */}
                {notice ? (
                    <p
                        data-spw-market-notice="true"
                        role="status"
                        aria-live="polite"
                        className="flex shrink-0 items-center gap-1.5 border-t border-white/10 px-5 py-2 text-[11px] text-emerald-300/90"
                    >
                        <ExternalLink size={11} aria-hidden="true" />
                        {notice}
                    </p>
                ) : null}

                <footer className="flex shrink-0 items-center gap-2 border-t border-white/10 px-5 py-3">
                    <span className="text-[11px] text-zinc-500">{t('options.modMarketFooter')}</span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-8 rounded-lg bg-white/10 px-3 text-[13px] text-zinc-100 transition-colors hover:bg-white/[0.16]"
                    >
                        {t('ui.close')}
                    </button>
                </footer>
            </div>
        </div>
    );
};

/** 右上角那颗状态徽标：就绪 / 加载中 / 离线（可重试）/ 空。 */
const CatalogBadge: React.FC<{
    state: CatalogState;
    t: (key: string) => string;
    onRetry: () => void;
}> = ({ state, t, onRetry }) => {
    if (state.status === 'loading') {
        return (
            <span className="inline-flex items-center gap-1 text-[12px] text-zinc-500" data-spw-catalog-status="loading">
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                {t('options.modMarketLoading')}
            </span>
        );
    }
    if (state.status === 'offline') {
        return (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-amber-300/90" data-spw-catalog-status="offline">
                <AlertTriangle size={12} aria-hidden="true" />
                {t('options.modMarketOffline')}
                {state.reason ? <span className="text-zinc-600">({state.reason})</span> : null}
                <button
                    type="button"
                    onClick={onRetry}
                    data-spw-catalog-retry="true"
                    className="ml-1 inline-flex h-6 items-center gap-1 rounded-md bg-white/10 px-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-white/[0.16]"
                >
                    <RefreshCw size={10} aria-hidden="true" />
                    {t('options.modMarketRetry')}
                </button>
            </span>
        );
    }
    if (state.status === 'empty') {
        return <span className="text-[12px] text-zinc-500" data-spw-catalog-status="empty">{t('options.modMarketEmpty')}</span>;
    }
    return (
        <span className="inline-flex items-center gap-1 text-[12px] text-zinc-500" data-spw-catalog-status="ready" data-spw-catalog-from-cache={state.fromCache ? 'true' : 'false'}>
            {state.refreshing ? (
                <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            ) : (
                <Check size={12} className="text-emerald-400" aria-hidden="true" />
            )}
            {/* 三句话，三种事实：正在后台更新 / 这份来自磁盘缓存 / 刚刚从网络取到。
             *  缓存命中时**不**显示「正在读取市场…」——首帧已经有卡片了，再转圈就是把已经完成的事
             *  说成还没完成。 */}
            {state.refreshing
                ? t('options.modMarketRefreshing')
                : state.fromCache
                    ? t('options.modMarketFromCache')
                    : t('options.modMarketReady')}
        </span>
    );
};

/** 非 ready 三态在大块空白处的那段说明（离线时必须说清「这不是没有模组」）。 */
const CatalogNotice: React.FC<{ state: CatalogState; t: (key: string) => string }> = ({ state, t }) => {
    if (state.status === 'loading') {
        return (
            <p className="px-1 py-8 text-center text-[13px] text-zinc-500" data-spw-catalog-notice="loading">
                {t('options.modMarketLoadingHint')}
            </p>
        );
    }
    if (state.status === 'empty') {
        return (
            <p className="px-1 py-8 text-center text-[13px] text-zinc-500" data-spw-catalog-notice="empty">
                {t('options.modMarketEmptyHint')}
            </p>
        );
    }
    return (
        <p className="px-1 py-8 text-center text-[13px] text-amber-300/80" data-spw-catalog-notice="offline">
            {t('options.modMarketOfflineHint')}
            {state.reason ? <span className="mt-1 block text-[12px] text-zinc-500">{state.reason}</span> : null}
        </p>
    );
};

export { MOD_MARKET_BASE };
export default ModMarketPanel;

