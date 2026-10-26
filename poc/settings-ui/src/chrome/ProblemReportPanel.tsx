/* issue #12 增加日志功能 — the 「出现问题」 diagnostics panel behind the player-page chrome.
 *
 * Two halves, exactly as the issue asks:
 *  1. 环境自检: ask the host for its native report (`bridge.requestEnvReport` → `envCheck` →
 *     `envReport`, see HostForm.BuildEnvReport) and merge it with what the page can see itself. Any
 *     missing hard dependency is named individually — "缺少某某环境" — instead of a generic failure.
 *  2. 反馈: with nothing missing, assemble a pre-filled GitHub issue body (environment table + the
 *     page's own state), open it in the browser (`openUrl`), and open the log folder with the log
 *     file selected (`openLogFolder`) so the user can drag the file into the issue.
 *
 * The panel lives in the settings island because that is the only UI this plugin owns inside the
 * player page; the SPW 配置 page carries the same entry point (a `button` preference that calls
 * `FoliaPlugin.onReportProblem`), which is the path that still works when the player window is dead.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ExternalLink, FolderOpen, Loader2, RefreshCw, X } from 'lucide-react';
import { useSettingsStore } from '~/model/settings';
import {
    FEEDBACK_ISSUE_URL,
    getBridge,
    openExternalUrl,
    openLogFolder,
    requestEnvReport,
    type EnvReport,
} from '~/bridge';

/** One row of the report: a check, its verdict, and how to fix it when it failed. */
interface CheckRow {
    id: string;
    label: string;
    ok: boolean;
    detail: string;
    fix?: string;
}

/** A hard dependency is missing (or a soft one is degraded). */
const HARD_MISSING_LABEL = '缺少运行环境';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const bool = (value: unknown): boolean => value === true;

/** WebView2 Evergreen GA floor: `CoreWebView2` instantiation needs ≥ 86. */
const WEBVIEW2_MIN_MAJOR = 86;

/** .NET Framework 4.8 starts at Release 528040 (4.8.1 builds are 533320/533325/533509). */
const DOTNET_48_RELEASE = 528040;

/** The native files that must sit beside the helper. */
const REQUIRED_NATIVE_FILES = [
    'spw-folia-host.exe',
    'spw-folia-host.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
];

/** Turns the host report into check rows, naming every missing piece. */
export const buildChecks = (report: EnvReport | null): CheckRow[] => {
    const rows: CheckRow[] = [];
    if (!report) {
        rows.push({
            id: 'host',
            label: '辅助进程（spw-folia-host.exe）',
            ok: false,
            detail: '没有收到辅助进程的环境报告',
            fix: '关闭后重新打开 Folia；若仍无响应，查看日志里的 host process exited code',
        });
        return rows;
    }

    const webview = str(report.webView2);
    const webviewMajor = Number(webview.split('.')[0]);
    const webviewOk = Number.isFinite(webviewMajor) && webviewMajor >= WEBVIEW2_MIN_MAJOR;
    rows.push({
        id: 'webview2',
        label: `WebView2 Runtime（≥ ${WEBVIEW2_MIN_MAJOR}）`,
        ok: webviewOk,
        detail: webview || '未检测到',
        ...(webviewOk ? {} : { fix: '安装 WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/consumer/' }),
    });

    const dotnet = Number(report.dotnet);
    const dotnetOk = Number.isFinite(dotnet) && dotnet >= DOTNET_48_RELEASE;
    rows.push({
        id: 'dotnet',
        label: '.NET Framework 4.8',
        ok: dotnetOk,
        detail: str(report.dotnet) ? `Release=${str(report.dotnet)}` : '未检测到',
        ...(dotnetOk ? {} : { fix: '安装 .NET Framework 4.8：https://dotnet.microsoft.com/download/dotnet-framework/net48' }),
    });

    const native = report.nativeFiles ?? {};
    const missingNative = Array.isArray(native.missing) ? native.missing : [];
    const nativeOk = missingNative.length === 0 && Array.isArray(native.present) && native.present.length > 0;
    rows.push({
        id: 'native',
        label: '辅助进程原生文件',
        ok: nativeOk,
        detail: nativeOk
            ? `${str(native.dir)}（${(native.present ?? []).length}/${REQUIRED_NATIVE_FILES.length} 个）`
            : `缺少 ${missingNative.join('、') || REQUIRED_NATIVE_FILES.join('、')}`,
        ...(nativeOk ? {} : { fix: '插件安装不完整（或被杀毒软件删除），重新安装 spw-folia' }),
    });

    rows.push({
        id: 'bundle',
        label: 'Folia 页面资源',
        ok: bool(report.bundleIndex),
        detail: bool(report.bundleIndex) ? str(report.bundle) : `缺少 index.html：${str(report.bundle) || '未知目录'}`,
        ...(bool(report.bundleIndex) ? {} : { fix: '插件安装不完整，重新安装 spw-folia' }),
    });

    rows.push({
        id: 'settings',
        label: '设置界面资源',
        ok: bool(report.settingsEntry),
        detail: bool(report.settingsEntry) ? str(report.settingsDir) : `缺少 settings-ui.js：${str(report.settingsDir) || '未知目录'}`,
        ...(bool(report.settingsEntry) ? {} : { fix: '插件安装不完整，重新安装 spw-folia' }),
    });

    rows.push({
        id: 'os',
        label: '64 位 Windows',
        ok: bool(report.os64) && bool(report.process64),
        detail: `${str(report.os) || '未知版本'}${bool(report.os64) ? '' : '（非 64 位）'}${bool(report.process64) ? '' : '（辅助进程非 64 位）'}`,
        ...(bool(report.os64) && bool(report.process64) ? {} : { fix: '需要 64 位 Windows 10 1809 或更新版本' }),
    });

    // Soft dependency: a remote session renders badly but does not stop the plugin. Reported as a
    // warning row rather than as a missing environment.
    const audio = str(report.audio);
    rows.push({
        id: 'audio',
        label: '音频采集（WASAPI 回环）',
        ok: audio.length > 0 && !/fail|unavailable|silent/i.test(audio),
        detail: audio || '未知',
    });

    const dropped = Number(report.droppedLogLines ?? 0);
    rows.push({
        id: 'logging',
        label: '日志管道',
        ok: !(dropped > 0),
        detail: dropped > 0 ? `${dropped} 行日志因管道阻塞被丢弃` : '正常',
        ...(dropped > 0 ? { fix: '这是宿主在 stdout 阻塞时的保护行为；把日志一起反馈即可' } : {}),
    });

    return rows;
};

/** The pre-filled issue body: what the user sees + the whole native report + page state. */
export const buildIssueBody = (report: EnvReport | null, checks: CheckRow[]): string => {
    const lines: string[] = [];
    lines.push('### 问题描述');
    lines.push('');
    lines.push('<!-- 请描述你看到的现象、复现步骤，以及期望的结果 -->');
    lines.push('');
    lines.push('### 运行环境（自动生成）');
    lines.push('');
    lines.push('```');
    checks.forEach(row => {
        lines.push(`${row.ok ? '[x]' : '[ ]'} ${row.label}: ${row.detail}`);
    });
    if (report) {
        lines.push('');
        lines.push(`host=${str(report.hostVersion)} pid=${report.pid ?? '?'} protocol=${str(report.protocol)}`);
        lines.push(`dpi=${report.dpi ?? '?'} awareness=${str(report.dpiAwareness)} screen=${str(report.screen)}`);
        lines.push(`transparent=${bool(report.transparent)} fps=${report.fps ?? '?'} states=${report.statesReceived ?? '?'} frames=${report.framesPosted ?? '?'}`);
        lines.push(`log=${str(report.logPath)}`);
    }
    lines.push('```');
    lines.push('');
    lines.push('### 页面状态');
    lines.push('');
    lines.push('```');
    const bridge = getBridge();
    const config = (window as unknown as { __SPW_FOLIA_LAST_CONFIG__?: Record<string, unknown> }).__SPW_FOLIA_LAST_CONFIG__;
    lines.push(`href=${window.location.href}`);
    lines.push(`viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`);
    lines.push(`config: ${config ? JSON.stringify({ song: config.song, visualizerMode: config.visualizerMode, transparent: (config.background as { transparent?: boolean } | undefined)?.transparent }) : 'none'}`);
    lines.push(`inputs: ${JSON.stringify({
        hasState: !!bridge.inputs?.state,
        hasLyrics: !!bridge.inputs?.lyrics,
        hasTrack: !!bridge.inputs?.track,
        queue: bridge.inputs?.queue?.items?.length ?? 0,
    })}`);
    lines.push('```');
    lines.push('');
    lines.push('### 日志');
    lines.push('');
    lines.push('完整日志文件已在该插件的安装目录；请在提交前把它们拖入本 issue。');
    return lines.join('\n');
};

/** The GitHub issue form URL with title/body pre-filled (capped so browsers do not truncate it). */
export const issueUrl = (body: string): string => {
    const capped = body.length > 6000 ? `${body.slice(0, 6000)}\n\n(完整内容见附件日志)` : body;
    return `${FEEDBACK_ISSUE_URL}?title=${encodeURIComponent('问题反馈：')}&body=${encodeURIComponent(capped)}`;
};

interface ProblemReportPanelProps {
    open: boolean;
    onClose: () => void;
}

/**
 * The panel itself. Kept deliberately small: a run button, the check list, and the two feedback
 * actions. It is mounted by `App` next to the player-background panel.
 */
const ProblemReportPanel = ({ open, onClose }: ProblemReportPanelProps) => {
    const [loading, setLoading] = useState(false);
    const [report, setReport] = useState<EnvReport | null>(null);
    const [checks, setChecks] = useState<CheckRow[]>([]);
    const [ranOnce, setRanOnce] = useState(false);
    const [transparent, setTransparent] = useState(false);

    const run = async (): Promise<void> => {
        setLoading(true);
        const next = await requestEnvReport();
        setReport(next);
        setChecks(buildChecks(next));
        setRanOnce(true);
        setLoading(false);
    };

    useEffect(() => {
        if (!open || ranOnce || loading) return;
        void run();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, ranOnce, loading]);

    /* The colour-key player window drops backdrop-filter layers, so the panel goes flat while the
     * player page is transparent (same rule the chrome buttons follow). */
    useEffect(() => {
        if (!open) return;
        setTransparent(useSettingsStore.getState().transparentPlayerBackground === true);
        return useSettingsStore.subscribe(state => setTransparent(state.transparentPlayerBackground === true));
    }, [open]);

    if (!open) return null;

    const missing = checks.filter(row => !row.ok && row.fix);
    const healthy = ranOnce && missing.length === 0;
    const body = buildIssueBody(report, checks);

    return (
        <div
            className="spw-problem-report"
            data-spw-chrome="problem-report-panel"
            data-open="true"
            data-flat={transparent ? 'true' : 'false'}
        >
            <div className="spw-problem-report__header">
                <span className="spw-problem-report__title">出现问题</span>
                <button type="button" className="spw-problem-report__icon" onClick={onClose} aria-label="关闭">
                    <X size={16} />
                </button>
            </div>

            <div className="spw-problem-report__body">
                {loading && (
                    <div className="spw-problem-report__row">
                        <Loader2 size={16} className="spw-problem-report__spin" />
                        <span>正在检查运行环境…</span>
                    </div>
                )}
                {!loading && checks.map(row => (
                    <div key={row.id} className="spw-problem-report__row" data-ok={row.ok ? 'true' : 'false'}>
                        {row.ok ? <Check size={16} color="#7fd08a" /> : <AlertTriangle size={16} color="#e0a34a" />}
                        <span className="spw-problem-report__label">{row.label}</span>
                        <span className="spw-problem-report__detail">{row.detail}</span>
                        {row.fix && <span className="spw-problem-report__fix">{row.fix}</span>}
                    </div>
                ))}
                {ranOnce && !healthy && missing.length > 0 && (
                    <div className="spw-problem-report__hint">{HARD_MISSING_LABEL}：先按上面的提示补齐，再重新检查。</div>
                )}
                {healthy && (
                    <div className="spw-problem-report__hint spw-problem-report__hint--ok">
                        环境齐全。反馈页面会自动带上这份环境信息，日志文件夹也会同时打开。
                    </div>
                )}
            </div>

            <div className="spw-problem-report__actions">
                <button type="button" className="spw-problem-report__action" onClick={() => void run()} disabled={loading}>
                    <RefreshCw size={15} /> 重新检查
                </button>
                <button
                    type="button"
                    className="spw-problem-report__action"
                    onClick={() => openLogFolder(report?.logPath ?? null)}
                >
                    <FolderOpen size={15} /> 打开日志文件夹
                </button>
                <button
                    type="button"
                    className="spw-problem-report__action spw-problem-report__action--primary"
                    onClick={() => openExternalUrl(issueUrl(body))}
                >
                    <ExternalLink size={15} /> 打开反馈页面
                </button>
            </div>
        </div>
    );
};

export default ProblemReportPanel;
