/* issue #12 增加日志功能 — the 「出现问题」 diagnostics panel behind the player-page chrome.
 *
 * Four verdicts, because "we could not read it" is not the same as "it is missing":
 *  - pass      the host answered and the dependency is satisfied;
 *  - fail      the host answered and a hard dependency really is absent. This is the only verdict
 *              that counts as 缺少运行环境 and drives the "先按提示补齐" hint;
 *  - unknown   the host did not answer (field absent, empty string, unparsable value, or an older
 *              host). Rendered as 「无法判定」 and never treated as a failure — this is the defect the
 *              Kotlin side (FoliaDiagnostics) is being rewritten for in parallel, so both panels must
 *              agree on the same contract;
 *  - advisory  informational only (soft dependencies such as audio capture / the log pipe). It is
 *              shown but never changes the conclusion.
 *
 * Two halves, exactly as the issue asks:
 *  1. 环境自检: ask the host for its native report (`bridge.requestEnvReport` → `envCheck` →
 *     `envReport`, see HostForm.BuildEnvReport) and merge it with what the page can see itself. A
 *     missing hard dependency is named individually — "缺少某某环境" — instead of a generic failure,
 *     while anything the host could not report stays 「无法判定」.
 *  2. 反馈: assemble a pre-filled GitHub issue body (environment rows + the page's own state), open it
 *     in the browser (`openUrl`), and open the log folder with the log file selected (`openLogFolder`)
 *     so the user can drag the file into the issue. Both actions stay available whatever the verdicts
 *     are — a user with an unreadable report still needs to file it.
 *
 * The panel lives in the settings island because that is the only UI this plugin owns inside the
 * player page; the SPW 配置 page carries the same entry point (a `button` preference that calls
 * `FoliaPlugin.onReportProblem`), which is the path that still works when the player window is dead.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CircleHelp, ExternalLink, FolderOpen, Loader2, RefreshCw, X } from 'lucide-react';
import { useSettingsStore } from '~/model/settings';
import {
    FEEDBACK_ISSUE_URL,
    getBridge,
    openExternalUrl,
    openLogFolder,
    requestEnvReport,
    type EnvReport,
} from '~/bridge';

/** Verdict of one check. Only `fail` means a hard dependency is missing; `unknown` means the host
 *  could not answer, and `advisory` is informational. Never fold `unknown` into `fail`. */
type Verdict = 'pass' | 'fail' | 'unknown' | 'advisory';

/** One row of the report: a label, its verdict, what was observed, and how to fix a real failure. */
interface CheckRow {
    id: string;
    label: string;
    verdict: Verdict;
    detail: string;
    /** Raw observation kept for the issue body (version strings, file lists); never shown as a fix. */
    evidence?: string;
    fix?: string;
}

/** The part of a row a judgement function decides on. */
type Judgement = Pick<CheckRow, 'verdict' | 'detail' | 'evidence' | 'fix'>;

/** A hard dependency is missing. */
const HARD_MISSING_LABEL = '缺少运行环境';

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `EnvReport` describes what the host is *expected* to send. The C# side is being migrated in
 *  parallel (it gains `windowsBuild`), so read the payload through one widened view instead of
 *  editing the bridge types from this file's write scope. Every value below is `unknown` and goes
 *  through the guards, which is exactly what a defensive read needs. */
const payload = (report: EnvReport): Record<string, unknown> => report as unknown as Record<string, unknown>;

/** Tri-state for a payload flag: the host said true, said false, or said nothing at all. Only an
 *  explicit `false` may become a failure — a missing field must fall through to `unknown`. */
type Tri = 'true' | 'false' | 'absent';

const flag = (value: unknown): Tri => {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    return 'absent';
};

/** First component of a dotted version string. `'0.0.0.0'` (WebView2's "not installed" answer)
 *  yields 0, while anything unparsable yields null so the caller can say 「无法判定」 instead. */
const majorOf = (version: string): number | null => {
    const first = version.trim().split('.')[0] ?? '';
    if (!/^\d+$/.test(first)) return null;
    const major = Number(first);
    return Number.isFinite(major) ? major : null;
};

/** Parse a numeric release/build string; empty or non-numeric is "no answer", never zero. */
const numberOrNull = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

/** WebView2 Evergreen GA floor: `CoreWebView2` instantiation needs ≥ 86. */
const WEBVIEW2_MIN_MAJOR = 86;

/** .NET Framework 4.8 starts at Release 528040 (4.8.1 builds are 533320/533325/533509). */
const DOTNET_48_RELEASE = 528040;

/** Windows 10 1809 is build 17763; the host's WinForms/WebView2 stack needs 1809 or newer. */
const WINDOWS_MIN_BUILD = 17763;

/** The native files that must sit beside the helper (same list as HostForm.NativeFilesJson). */
const REQUIRED_NATIVE_FILES = [
    'spw-folia-host.exe',
    'spw-folia-host.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
];

/** 「无法判定」 repair hint shared by the checks the host is supposed to answer. */
const REOPEN_HINT = '重新打开 Folia 让宿主重新检测；仍为空请把日志附在反馈里';

/* ---------------------------------------------------------------------------------------------
 * One judgement function per row. They are pure and total: a value they cannot read is `unknown`,
 * never `fail`, which is the property the whole rewrite is about.
 * ------------------------------------------------------------------------------------------- */

/** WebView2. Empty/unparsable → unknown; a real-but-old major, or `'0.0.0.0'` → fail. */
const judgeWebView2 = (rawVersion: string): Judgement => {
    const major = majorOf(rawVersion);
    if (major === null) {
        return {
            verdict: 'unknown',
            detail: rawVersion ? `版本号无法解析：${rawVersion}` : '宿主未返回 WebView2 版本',
            fix: REOPEN_HINT,
        };
    }
    if (major >= WEBVIEW2_MIN_MAJOR) {
        return { verdict: 'pass', detail: rawVersion, evidence: `webView2=${rawVersion}` };
    }
    /* `0.0.0.0` is the runtime's own "not installed" answer, not a version below the floor. */
    return {
        verdict: 'fail',
        detail: major === 0 ? `${rawVersion}（未安装）` : `${rawVersion}（主版本 ${major}，需要 ≥ ${WEBVIEW2_MIN_MAJOR}）`,
        fix: '安装 WebView2 Runtime：https://developer.microsoft.com/microsoft-edge/webview2/consumer/',
    };
};

/** .NET Framework. Empty/non-numeric → unknown (the old code read `Number(null) === 0` as a fail). */
const judgeDotNet = (rawRelease: string): Judgement => {
    const release = numberOrNull(rawRelease);
    if (release === null) {
        return {
            verdict: 'unknown',
            detail: rawRelease ? `无法解析 Release 号：${rawRelease}` : '宿主未返回 .NET Release 号',
            fix: REOPEN_HINT,
        };
    }
    if (release >= DOTNET_48_RELEASE) {
        return { verdict: 'pass', detail: `Release=${release}`, evidence: `dotnet=${release}` };
    }
    return {
        verdict: 'fail',
        detail: `Release=${release}，需要 ≥ ${DOTNET_48_RELEASE}（.NET Framework 4.8）`,
        fix: '安装 .NET Framework 4.8：https://dotnet.microsoft.com/download/dotnet-framework/net48',
    };
};

/** Native files beside the helper. Only a non-empty `missing` list is a failure. */
const judgeNative = (files: EnvReport['nativeFiles']): Judgement => {
    if (!files || typeof files !== 'object') {
        return { verdict: 'unknown', detail: '宿主未返回原生文件清单', fix: REOPEN_HINT };
    }
    const present = (Array.isArray(files.present) ? files.present : []).filter((name): name is string => typeof name === 'string');
    const missing = (Array.isArray(files.missing) ? files.missing : []).filter((name): name is string => typeof name === 'string');
    const where = str(files.dir) ? `（${str(files.dir)}）` : '';
    if (missing.length > 0) {
        return {
            verdict: 'fail',
            detail: `缺少 ${missing.join('、')}${where}`,
            fix: '插件安装不完整（或被杀毒软件删除），重新安装 spw-folia',
        };
    }
    if (present.length >= REQUIRED_NATIVE_FILES.length) {
        return {
            verdict: 'pass',
            detail: `${REQUIRED_NATIVE_FILES.length}/${REQUIRED_NATIVE_FILES.length} 个原生文件在位${where}`,
            evidence: `present=${present.join(', ')}`,
        };
    }
    /* The host always sends both arrays; an empty pair means it did not enumerate them. Report the
     * partial answer honestly instead of claiming the remaining files are missing. */
    if (present.length === 0) {
        return { verdict: 'unknown', detail: `宿主返回的文件清单为空${where}`, fix: REOPEN_HINT };
    }
    return {
        verdict: 'unknown',
        detail: `只确认了 ${present.length}/${REQUIRED_NATIVE_FILES.length} 个文件在位${where}，其余未核对`,
        evidence: `present=${present.join(', ')}`,
    };
};

/** bundle `index.html` / settings `settings-ui.js`: true → pass, false → fail, absent → unknown. */
const judgeAsset = (exists: Tri, what: string, dir: string): Judgement => {
    const where = dir ? `：${dir}` : '';
    if (exists === 'true') return { verdict: 'pass', detail: dir || '已确认存在' };
    if (exists === 'false') {
        return {
            verdict: 'fail',
            detail: `缺少 ${what}${where || '（目录未知）'}`,
            fix: '插件安装不完整，重新安装 spw-folia',
        };
    }
    return { verdict: 'unknown', detail: `宿主未返回「${what}」的存在性${where}`, fix: REOPEN_HINT };
};

interface OsFacts {
    os: string;
    os64: Tri;
    process64: Tri;
    /** Build number (≥ 17763 required), or null when neither the field nor the `os` string has it. */
    build: number | null;
}

/** 64-bit Windows 10 1809+. Fails only on an explicit `false` flag or a measured old build. */
const judgeOs = ({ os, os64, process64, build }: OsFacts): Judgement => {
    const version = os || (build !== null ? `build ${build}` : '未知版本');

    const not64: string[] = [];
    if (os64 === 'false') not64.push('系统非 64 位');
    if (process64 === 'false') not64.push('辅助进程非 64 位');
    if (not64.length > 0) {
        return { verdict: 'fail', detail: `${version}（${not64.join('；')}）`, fix: '需要 64 位 Windows 10 1809 或更新版本' };
    }

    if (build !== null && build < WINDOWS_MIN_BUILD) {
        return {
            verdict: 'fail',
            detail: `${version}（实测 build ${build}，需要 ≥ ${WINDOWS_MIN_BUILD}，即 Windows 10 1809）`,
            fix: '升级到 Windows 10 1809 或更新版本',
        };
    }

    /* Nothing failed — but if the host stayed silent on a field we cannot claim the row passes. */
    const unanswered: string[] = [];
    if (os64 === 'absent') unanswered.push('系统位数');
    if (process64 === 'absent') unanswered.push('辅助进程位数');
    if (build === null) unanswered.push('系统 build 号');
    if (unanswered.length > 0) {
        return { verdict: 'unknown', detail: `${version}（宿主未返回${unanswered.join('、')}）`, fix: REOPEN_HINT };
    }

    return {
        verdict: 'pass',
        detail: `${version}（64 位，build ${build} ≥ ${WINDOWS_MIN_BUILD}）`,
        evidence: `os64=${os64} process64=${process64} build=${build}`,
    };
};

/** Soft dependency: a remote session may render badly but never stops the plugin. */
const judgeAudio = (audio: string): Judgement => {
    if (!audio) return { verdict: 'advisory', detail: '宿主未返回音频采集状态（按默认设置播放）' };
    if (/fail|unavailable|silent/i.test(audio)) {
        return { verdict: 'advisory', detail: `${audio}（远程会话下可能无法采集，不影响播放）` };
    }
    return { verdict: 'pass', detail: audio, evidence: `audio=${audio}` };
};

/** Soft dependency: dropped lines are the host's protection against a blocked stdout pipe. */
const judgeLogging = (dropped: string): Judgement => {
    const lines = numberOrNull(dropped);
    if (lines === null) return { verdict: 'advisory', detail: '宿主未返回日志丢弃计数' };
    if (lines > 0) {
        return {
            verdict: 'advisory',
            detail: `${lines} 行日志因管道阻塞被丢弃`,
            fix: '这是宿主在 stdout 阻塞时的保护行为；把日志一起反馈即可',
        };
    }
    return { verdict: 'pass', detail: '正常' };
};

/** Turns the host report into check rows. `unknown` rows stay `unknown` — never `fail`. */
export const buildChecks = (report: EnvReport | null): CheckRow[] => {
    if (!report) {
        /* No report at all: the helper never answered, so every other row is unanswerable too and
         * judging them here would be guessing. One row, one verdict. */
        return [{
            id: 'host',
            label: '辅助进程（spw-folia-host.exe）',
            verdict: 'fail',
            detail: '没有收到辅助进程的环境报告',
            fix: '关闭后重新打开 Folia；若仍无响应，查看日志里的 host process exited code',
        }];
    }

    const raw = payload(report);
    const rows: CheckRow[] = [];

    rows.push({
        id: 'host',
        label: '辅助进程（spw-folia-host.exe）',
        verdict: 'pass',
        detail: `host ${str(raw.hostVersion) || '未知版本'} pid=${typeof raw.pid === 'number' ? raw.pid : '?'} protocol=${str(raw.protocol) || '?'}`,
        evidence: str(raw.logPath) ? `log=${str(raw.logPath)}` : undefined,
    });

    rows.push({
        id: 'webview2',
        label: `WebView2 Runtime（≥ ${WEBVIEW2_MIN_MAJOR}）`,
        ...judgeWebView2(str(raw.webView2)),
    });

    rows.push({
        id: 'dotnet',
        label: '.NET Framework 4.8',
        ...judgeDotNet(str(raw.dotnet)),
    });

    rows.push({
        id: 'native',
        label: '辅助进程原生文件',
        ...judgeNative(report.nativeFiles ?? null),
    });

    rows.push({
        id: 'bundle',
        label: 'Folia 页面资源',
        ...judgeAsset(flag(raw.bundleIndex), 'index.html', str(raw.bundle)),
    });

    rows.push({
        id: 'settings',
        label: '设置界面资源',
        ...judgeAsset(flag(raw.settingsEntry), 'settings-ui.js', str(raw.settingsDir)),
    });

    /* Prefer the host's numeric field (`Environment.OSVersion.Version.Build`). Older hosts only send
     * the `os` string — `Environment.OSVersion.VersionString` look like
     * "Microsoft Windows NT 10.0.19045.0" — so fall back to its third segment. One root cause of the
     * old bug was every missing value landing in the failure path; here a null build is `unknown`. */
    const osString = str(raw.os);
    const buildFromField = typeof raw.windowsBuild === 'number' && Number.isFinite(raw.windowsBuild) ? raw.windowsBuild : null;
    const buildFromString = numberOrNull(osString.trim().split('.')[2] ?? '');
    rows.push({
        id: 'os',
        label: `64 位 Windows 10 1809+（build ≥ ${WINDOWS_MIN_BUILD}）`,
        ...judgeOs({
            os: osString,
            os64: flag(raw.os64),
            process64: flag(raw.process64),
            build: buildFromField ?? buildFromString,
        }),
    });

    rows.push({
        id: 'audio',
        label: '音频采集（WASAPI 回环）',
        ...judgeAudio(str(raw.audio)),
    });

    rows.push({
        id: 'logging',
        label: '日志管道',
        ...judgeLogging(typeof raw.droppedLogLines === 'number' ? String(raw.droppedLogLines) : ''),
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
    /* One line per row as `<verdict> <label>: <detail>` so a triage pass can grep `unknown`/`fail`
     * without the old [x]/[ ] ambiguity between "missing" and "not readable". */
    checks.forEach(row => {
        lines.push(`${row.verdict} ${row.label}: ${row.detail}`);
        if (row.evidence) lines.push(`  evidence: ${row.evidence}`);
    });
    if (report) {
        lines.push('');
        lines.push(`host=${str(report.hostVersion)} pid=${report.pid ?? '?'} protocol=${str(report.protocol)}`);
        lines.push(`dpi=${report.dpi ?? '?'} awareness=${str(report.dpiAwareness)} screen=${str(report.screen)}`);
        lines.push(`transparent=${report.transparent === true} fps=${report.fps ?? '?'} states=${report.statesReceived ?? '?'} frames=${report.framesPosted ?? '?'}`);
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

/* Icon colours: green = satisfied, amber = really missing, grey = could not judge / informational.
 * Kept in TSX because the panel stylesheet is out of this task's write scope. */
const COLOR_PASS = '#7fd08a';
const COLOR_FAIL = '#e0a34a';
const COLOR_UNKNOWN = 'rgba(244, 244, 245, 0.5)';

/** pass → green check, fail → amber warning, unknown → grey question mark, advisory → grey alert. */
const VerdictIcon = ({ verdict }: { verdict: Verdict }) => {
    if (verdict === 'pass') return <Check size={16} color={COLOR_PASS} />;
    if (verdict === 'fail') return <AlertTriangle size={16} color={COLOR_FAIL} />;
    if (verdict === 'unknown') return <CircleHelp size={16} color={COLOR_UNKNOWN} />;
    return <AlertTriangle size={16} color={COLOR_UNKNOWN} />;
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

    /* Only a real miss drives the "补齐" hint; unreadable rows get their own, deliberately reassuring
     * hint so 「无法判定」 is not presented to the user as a broken environment. */
    const missing = checks.filter(row => row.verdict === 'fail');
    const unverified = checks.filter(row => row.verdict === 'unknown');
    const healthy = ranOnce && missing.length === 0 && unverified.length === 0;
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
                    <div
                        key={row.id}
                        className="spw-problem-report__row"
                        data-verdict={row.verdict}
                        /* app.css only knows `data-ok='false'` (amber tint) and is outside this change's
                         * write scope, so reserve the tint for a real failure: an unreadable row must
                         * not look broken. `data-verdict` is there for the stylesheet's next pass. */
                        data-ok={row.verdict === 'fail' ? 'false' : 'true'}
                    >
                        <VerdictIcon verdict={row.verdict} />
                        <span className="spw-problem-report__label">{row.label}</span>
                        <span className="spw-problem-report__detail">{row.detail}</span>
                        {row.evidence && <span className="spw-problem-report__detail">{row.evidence}</span>}
                        {row.fix && <span className="spw-problem-report__fix">{row.fix}</span>}
                    </div>
                ))}
                {missing.length > 0 && (
                    <div className="spw-problem-report__hint">{HARD_MISSING_LABEL}：先按上面的提示补齐，再重新检查。</div>
                )}
                {missing.length === 0 && unverified.length > 0 && (
                    <div className="spw-problem-report__hint">
                        有 {unverified.length} 项无法判定（原因见上），这不代表环境有问题，可先打开反馈页并附日志。
                    </div>
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
                {/* Always enabled: reporting a problem must not depend on the panel being healthy. */}
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
