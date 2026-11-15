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
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
    AlertTriangle,
    Check,
    Download,
    FolderOpen,
    Loader2,
    Package,
    RefreshCw,
    Search,
    ShieldCheck,
    Trash2,
    X,
} from 'lucide-react';
import { modAction, openModsFolder } from '~/bridge';
import { useInjectedMods, type InjectedMod } from '~/model/useInjectedMods';
import { MOD_MARKET_BASE } from './modCatalog';
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

/** 分组标题的文案 key（`i18n.ts` 的 `LOCAL_KEYS.options`）。 */
const ORIGIN_LABEL_KEYS: Record<ModOrigin, string> = {
    official: 'modMarketOfficial',
    community: 'modMarketCommunity',
    beta: 'modMarketBeta',
};

export interface ModMarketPanelProps {
    open: boolean;
    onClose: () => void;
}

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
 * 市场里的一条卡片。**已装**时高亮并换成「卸载 / 启用-禁用」，未装时给「安装」（前提是
 * `canInstall`：缺 `download.sha256` 的条目不显示安装按钮 —— 我们要求校验）。
 */
const MarketCard: React.FC<{
    entry: ModCatalogEntry;
    installed: InjectedMod | null;
    t: (key: string) => string;
    onInstall: (entry: ModCatalogEntry) => void;
    onUninstall: (mod: InjectedMod) => void;
    onToggle: (mod: InjectedMod) => void;
}> = ({ entry, installed, t, onInstall, onUninstall, onToggle }) => {
    const size = formatBytes(entry.downloadSize);
    return (
        <div
            className={`flex flex-col overflow-hidden rounded-xl border transition-colors ${installed ? 'border-white/15 bg-white/[0.07]' : 'border-white/10 bg-white/[0.03]'}`}
            data-spw-market-card={entry.id}
            data-installed={installed ? 'true' : 'false'}
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
                <div className="mt-auto flex items-center gap-1.5 pt-1">
                    <span
                        className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-zinc-400"
                        title={t('options.modMarketPermissions')}
                    >
                        <ShieldCheck size={10} aria-hidden="true" />
                        {entry.permissions.length}
                    </span>
                    <div className="flex-1" />
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

export const ModMarketPanel: React.FC<ModMarketPanelProps> = ({ open, onClose }) => {
    const { t } = useTranslation();
    const mods = useInjectedMods();
    const catalogState = useModCatalog(open);
    const [query, setQuery] = useState('');
    const [pending, setPending] = useState<string | null>(null);

    // 每次打开回到干净状态：搜索词与「正在安装哪一个」都不该留到下一次。
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setPending(null);
    }, [open]);

    const installedById = useMemo(() => {
        const map = new Map<string, InjectedMod>();
        for (const mod of mods) map.set(mod.id, mod);
        return map;
    }, [mods]);

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
        setPending(entry.id);
        modAction({
            action: 'install',
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
        window.setTimeout(() => setPending(current => (current === entry.id ? null : current)), 30_000);
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
            className="font-sans fixed inset-0 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            style={{ zIndex: MODAL_Z_INDEX, pointerEvents: 'auto' }}
            data-spw-mod-market="true"
            data-spw-mod-market-status={catalogState.status}
            role="dialog"
            aria-modal="true"
            aria-label={t('options.modMarketTitle')}
            onMouseDown={event => {
                // 只有从遮罩本身按下的关闭才算（拖拽出面板的松开不算），与 FontPickerModal 一致。
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className="flex max-h-[min(760px,88vh)] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1a1a1d] text-zinc-200 shadow-[0_32px_90px_rgba(0,0,0,0.6)]"
                data-spw-mod-market-card="true"
                onMouseDown={event => event.stopPropagation()}
            >
                <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold text-zinc-100">{t('options.modMarketTitle')}</h2>
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">
                        {t('options.modMarketBetaBadge')}
                    </span>
                    <div className="flex-1" />
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
                                                t={t}
                                                onInstall={onInstall}
                                                onUninstall={onUninstall}
                                                onToggle={onToggle}
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
        <span className="inline-flex items-center gap-1 text-[12px] text-zinc-500" data-spw-catalog-status="ready">
            <Check size={12} className="text-emerald-400" aria-hidden="true" />
            {state.fromCache ? t('options.modMarketFromCache') : t('options.modMarketReady')}
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

