/* 自定义歌词字体的选择器：一个盖在设置窗上的居中模态。
 *
 * 三节：
 *  ① 系统字体——插件把本机字体族以 `systemFonts: string[]` 注入设置树（见 `useSystemFonts`），
 *     这里给一份可搜索的列表；
 *  ② 已导入的字体——用户自己导入的字体包（`state.uploadedFonts`，字节在 IndexedDB 里），可以
 *     选、可以删，也可以当场导入新的；
 *  ③ 恢复默认——把歌词字体交回内置字体栈。
 *
 * 每一行本身就是一个按钮：鼠标划过（或键盘聚焦）时上方预览行立刻换成那个字体，点击即应用。
 *
 * 这个模态画在 `StudioWindow` 里的形式也行、画在外面的形式也行，所以它**不读 `--st-*` 变量**
 * （那些变量只落在设置窗自己的元素上），配色用写死的 Folia 深色。
 *
 * 注入页里它渲染在设置浮层内部（那个容器的 z-index 是 2147483000），因此自身用更大的 z-index
 * 和 `pointer-events: auto` 盖过 StudioWindow（z-140）。v0.4.0 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Loader2, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';
import {
    deleteUploadedFont,
    ensureFontRegistered,
    importFontFile,
    validateFontFile,
} from './uploadedFonts';
import { useSystemFontsState } from './useSystemFonts';
import { useSettingsStore, type UploadedFontDescriptor } from './settings';

/** 一次“选中”：App 把它翻译成 `appearance` 的四个字段（fontStyle/customFontFamily/…）。 */
export interface FontPickerChoice {
    /** 真正写进 `theme.fontFamily` 的字族名。系统字体就是字体族名本身，导入字体是 `SpwFoliaFont_*`。 */
    family: string;
    /** 给人看的名字（列表里那一行）。 */
    label: string;
    source: 'system' | 'uploaded';
    /** 导入字体在设置树 / IndexedDB 里的 id。 */
    id?: string;
    /** 该字体的回落字族表（目前只有上传字体带自定义回落时需要）。 */
    stack?: string[];
}

export interface FontPickerModalProps {
    open: boolean;
    onClose: () => void;
    /** 当前在用的字族（可能是系统字体，也可能是 `SpwFoliaFont_*`）；用于高亮与预览初值。 */
    currentFamily: string | null;
    /** 选中一项时调用（**唯一必需的提交回调**）。 */
    onPick: (choice: FontPickerChoice) => void;
    /** 预览用的那一行文字（`useCurrentLyricText()` 给的就是 `string | null`）；空/不传则用内置样句
     *  `options.fontPreviewSample`。 */
    previewText?: string | null;
    /** 可选的细分回调：`onPick` 之外还想按来源分派时用。 */
    onChooseSystemFont?: (family: string) => void;
    onChooseUploadedFont?: (descriptor: UploadedFontDescriptor) => void;
    /** 可选的“恢复默认”回调；给了才画那一节。 */
    onClear?: () => void;
}

/** 模态自己的层级：在 StudioWindow（z-140）与设置浮层容器（z-index 2147483000）之上。 */
const MODAL_Z_INDEX = 2147483200;

const ROW_BASE = 'group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2 text-left transition-colors';
const ROW_IDLE = 'text-zinc-300 hover:border-white/10 hover:bg-white/[0.06] hover:text-zinc-50';
const ROW_ACTIVE = 'border-white/15 bg-white/[0.09] text-zinc-50';
const SECTION_TITLE = 'px-1 text-[12px] font-semibold uppercase tracking-wide text-zinc-500';

export const FontPickerModal: React.FC<FontPickerModalProps> = ({
    open,
    onClose,
    currentFamily,
    onPick,
    previewText,
    onChooseSystemFont,
    onChooseUploadedFont,
    onClear,
}) => {
    const { t } = useTranslation();
    const { fonts: systemFonts, ready } = useSystemFontsState();
    const uploadedFonts = useSettingsStore(state => state.uploadedFonts) as UploadedFontDescriptor[];

    const [query, setQuery] = useState('');
    /** 划过的那一行：预览行跟着它换字体（点击前就能看到效果）。 */
    const [hovered, setHovered] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // 每次打开都回到干净状态：搜索词、错误、悬停都不该留到下一次。
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setError(null);
        setHovered(null);
        setImporting(false);
    }, [open]);

    // Escape 关窗。监听挂在 window 上（捕获段），免得被设置窗自己的按键处理吃掉。
    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [open, onClose]);

    const filteredSystemFonts = useMemo(() => {
        const needle = query.trim().toLocaleLowerCase();
        if (!needle) return systemFonts;
        return systemFonts.filter(family => family.toLocaleLowerCase().includes(needle));
    }, [systemFonts, query]);

    const uploadedById = useMemo(() => {
        const map = new Map<string, UploadedFontDescriptor>();
        for (const descriptor of uploadedFonts ?? []) map.set(descriptor.family, descriptor);
        return map;
    }, [uploadedFonts]);

    const commitSystemFont = useCallback((family: string) => {
        onPick({ family, label: family, source: 'system' });
        onChooseSystemFont?.(family);
        onClose();
    }, [onPick, onChooseSystemFont, onClose]);

    const commitUploadedFont = useCallback((descriptor: UploadedFontDescriptor) => {
        onPick({ family: descriptor.family, label: descriptor.label, source: 'uploaded', id: descriptor.id });
        onChooseUploadedFont?.(descriptor);
        onClose();
    }, [onPick, onChooseUploadedFont, onClose]);

    /** 划过一行：预览立刻切换；导入的字体若还没注册成功，这里再补一次（尽力而为）。 */
    const preview = useCallback((family: string) => {
        setHovered(family);
        if (!uploadedById.has(family)) return;
        void ensureFontRegistered(family).catch(() => undefined);
    }, [uploadedById]);

    const handleImportFile = useCallback(async (file: File | null | undefined) => {
        if (!file) return;
        const invalid = validateFontFile(file);
        if (invalid) {
            setError(invalid);
            return;
        }
        setError(null);
        setImporting(true);
        try {
            const { descriptor } = await importFontFile(file);
            commitUploadedFont(descriptor);
        } catch (caught) {
            const message = caught instanceof Error && caught.message ? caught.message : t('options.fontImportFailed');
            setError(message);
        } finally {
            setImporting(false);
            // 允许再次选择同一个文件（否则 change 不再触发）。
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }, [commitUploadedFont, t]);

    const handleRemove = useCallback(async (descriptor: UploadedFontDescriptor) => {
        setError(null);
        try {
            await deleteUploadedFont(descriptor.id);
        } catch {
            setError(t('options.fontImportFailed'));
        }
    }, [t]);

    const handleClear = useCallback(() => {
        onClear?.();
        onClose();
    }, [onClear, onClose]);

    if (!open) return null;

    const sample = previewText && previewText.trim() ? previewText : t('options.fontPreviewSample');
    const previewFamily = hovered ?? currentFamily ?? null;
    const showEmptySystemState = ready && filteredSystemFonts.length === 0;

    return (
        <div
            className="fixed inset-0 z-[2147483200] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
            style={{ zIndex: MODAL_Z_INDEX, pointerEvents: 'auto' }}
            data-spw-font-picker="true"
            role="dialog"
            aria-modal="true"
            aria-label={t('options.chooseSystemFont')}
            onMouseDown={event => {
                // 只有从遮罩本身按下的关闭才算（拖拽出面板的松开不算）。
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className="flex max-h-[min(720px,86vh)] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#1a1a1d] text-zinc-200 shadow-[0_32px_90px_rgba(0,0,0,0.6)]"
                onMouseDown={event => event.stopPropagation()}
            >
                <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-5 py-3.5">
                    <h2 className="text-[15px] font-semibold text-zinc-100">{t('options.chooseSystemFont')}</h2>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label={t('ui.close')}
                        className="grid h-8 w-8 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100"
                    >
                        <X size={16} />
                    </button>
                </header>

                {/* ① 预览：跟着划过/选中的那一行实时换字体。 */}
                <div className="shrink-0 border-b border-white/10 px-5 py-4">
                    <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-zinc-500">
                        {t('options.fontPreview')}
                    </div>
                    <div
                        className="truncate text-[28px] leading-[1.35] text-zinc-50"
                        style={{ fontFamily: previewFamily ?? undefined }}
                        data-spw-font-picker-preview="true"
                    >
                        {sample}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-zinc-500">
                        {previewFamily ?? t('options.systemFontEmpty')}
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                    {/* ② 系统字体（可搜索）。 */}
                    <section className="mb-4">
                        <div className="mb-2 flex items-center gap-2">
                            <h3 className={SECTION_TITLE}>{t('options.systemFontList')}</h3>
                            <div className="flex-1" />
                            <div className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2">
                                <Search size={13} className="shrink-0 text-zinc-500" />
                                <input
                                    type="search"
                                    value={query}
                                    onChange={event => setQuery(event.target.value)}
                                    placeholder={t('options.systemFontSearch')}
                                    aria-label={t('options.systemFontSearch')}
                                    className="h-7 w-[180px] bg-transparent text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500"
                                />
                            </div>
                        </div>

                        {!ready && systemFonts.length === 0 && (
                            <p className="px-1 py-3 text-[13px] text-zinc-500">{t('options.systemFontLoading')}</p>
                        )}
                        {showEmptySystemState && (
                            <p className="px-1 py-3 text-[13px] text-zinc-500">
                                {query.trim() ? t('options.systemFontEmpty') : t('options.chooseSystemFontEmpty')}
                            </p>
                        )}

                        <div className="grid max-h-[240px] grid-cols-1 gap-0.5 overflow-y-auto sm:grid-cols-2">
                            {filteredSystemFonts.map(family => {
                                const active = family === currentFamily && !uploadedById.has(family);
                                return (
                                    <button
                                        key={family}
                                        type="button"
                                        data-spw-font-picker-row="system"
                                        data-family={family}
                                        aria-pressed={active}
                                        onMouseEnter={() => preview(family)}
                                        onFocus={() => preview(family)}
                                        onClick={() => commitSystemFont(family)}
                                        className={`${ROW_BASE} ${active ? ROW_ACTIVE : ROW_IDLE}`}
                                    >
                                        <span className="min-w-0 flex-1 truncate">
                                            <span className="block truncate text-[14px]" style={{ fontFamily: family }}>
                                                {t('options.fontPreviewSample')}
                                            </span>
                                            <span className="block truncate text-[12px] text-zinc-500">{family}</span>
                                        </span>
                                        {active && <Check size={15} className="shrink-0 text-emerald-400" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>

                    {/* ③ 已导入的字体包。 */}
                    <section className="mb-4">
                        <div className="mb-2 flex items-center gap-2">
                            <h3 className={SECTION_TITLE}>{t('options.uploadedFontList')}</h3>
                            <div className="flex-1" />
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".woff2,.woff,.ttf,.otf"
                                className="hidden"
                                onChange={event => {
                                    const file = event.target.files?.[0] ?? null;
                                    void handleImportFile(file);
                                }}
                            />
                            <button
                                type="button"
                                disabled={importing}
                                onClick={() => fileInputRef.current?.click()}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-[13px] text-zinc-100 transition-colors hover:bg-white/[0.16] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {importing ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                                {t('options.importFontPack')}
                            </button>
                        </div>
                        <p className="mb-2 px-1 text-[12px] text-zinc-500">{t('options.importFontPackDesc')}</p>

                        {error && (
                            <p className="mb-2 rounded-lg bg-red-500/10 px-2.5 py-2 text-[12px] text-red-300" role="alert">
                                {error}
                            </p>
                        )}

                        {(uploadedFonts ?? []).length === 0 ? (
                            <p className="px-1 py-2 text-[13px] text-zinc-500">{t('options.uploadedFontEmpty')}</p>
                        ) : (
                            <div className="flex flex-col gap-0.5">
                                {(uploadedFonts ?? []).map(descriptor => {
                                    const active = descriptor.family === currentFamily;
                                    return (
                                        <div
                                            key={descriptor.id}
                                            className={`${ROW_BASE} ${active ? ROW_ACTIVE : ROW_IDLE} pr-1.5`}
                                            onMouseEnter={() => preview(descriptor.family)}
                                        >
                                            <button
                                                type="button"
                                                data-spw-font-picker-row="uploaded"
                                                data-family={descriptor.family}
                                                aria-pressed={active}
                                                onFocus={() => preview(descriptor.family)}
                                                onClick={() => commitUploadedFont(descriptor)}
                                                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                            >
                                                <span className="min-w-0 flex-1 truncate">
                                                    <span
                                                        className="block truncate text-[14px]"
                                                        style={{ fontFamily: descriptor.family }}
                                                    >
                                                        {t('options.fontPreviewSample')}
                                                    </span>
                                                    <span className="block truncate text-[12px] text-zinc-500">
                                                        {descriptor.label}
                                                    </span>
                                                </span>
                                                {active && <Check size={15} className="shrink-0 text-emerald-400" />}
                                            </button>
                                            <button
                                                type="button"
                                                aria-label={`${t('options.fontRemove')} ${descriptor.label}`}
                                                title={t('options.fontRemove')}
                                                onClick={() => void handleRemove(descriptor)}
                                                className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-white/10 hover:text-red-300"
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </section>

                    {/* ④ 恢复默认（只有调用方给了 onClear 才画）。 */}
                    {onClear && (
                        <section>
                            <button
                                type="button"
                                data-spw-font-picker-row="reset"
                                onClick={handleClear}
                                className={`${ROW_BASE} ${ROW_IDLE}`}
                            >
                                <RotateCcw size={15} className="shrink-0" />
                                <span className="flex-1 truncate text-[14px]">{t('options.clearSystemFont')}</span>
                                {currentFamily === null && <Check size={15} className="shrink-0 text-emerald-400" />}
                            </button>
                        </section>
                    )}
                </div>

                <footer className="flex shrink-0 items-center gap-2 border-t border-white/10 px-5 py-3">
                    <span className="text-[12px] text-zinc-500">
                        {currentFamily ? `${t('options.currentFont')} · ${currentFamily}` : t('options.currentFont')}
                    </span>
                    <div className="flex-1" />
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-8 rounded-lg bg-white/10 px-3 text-[13px] text-zinc-100 transition-colors hover:bg-white/[0.16]"
                    >
                        {t('ui.cancel')}
                    </button>
                </footer>
            </div>
        </div>
    );
};

export default FontPickerModal;
