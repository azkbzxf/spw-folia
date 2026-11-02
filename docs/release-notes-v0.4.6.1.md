# spw-folia v0.4.6.1 — 「出现问题」不再乱报错：判定改成四态，每一项都可复核

> **未发布**：本版本仅本地构建与测试，从未上传 GitHub Releases；其改动随后续版本一并交付。最后发布的版本是 v0.4.6。

v0.4.6.1 修的是**诊断工具本身**。功能（15 种样式、播放控制、透明背景、托盘入口）与 v0.4.6 完全一致。

## 问题

在完全正常的 Windows 11（build 26300）上点「模组管理 → 配置 → 支持与反馈 → 出现问题」，会弹出
红色 toast：

```
缺少运行环境：Windows 10 x64（1809+）（Windows 11 10.0 amd64）→ 需要 64 位 Windows 10 1809 (17763) 或更新版本
```

用户机器没有任何问题，**这个检查在任何机器上都不可能通过**。

### 根因

`FoliaDiagnostics.osCheck()` 从 `System.getProperty("os.version")` 取构建号，用
`Regex("(\\d+)\\.(\\d+)\\.(\\d+)")` 解析。但 **HotSpot 在 Windows 上把 `os.version` 报成 `"10.0"`**
——两段、没有构建号（构建号在注册表 `CurrentVersion\CurrentBuildNumber`）。正则永不命中 →
`build = null` → `is64 && build != null && build >= 17763` 恒为 false。

更要命的是第二层：判定式把「**读不到**」和「**版本太低**」压进了同一个 `false`，于是「读不到」被
表述成「你的系统太老，去升级」。

同源的错误还有三处：

| # | 旧实现 | 后果 |
| --- | --- | --- |
| 2 | `.NET Release` 无条件剥掉 `0x` 再按十六进制解析 | 十进制 `528040` 被算成 `0x528040`（5406784），反之亦然 |
| 3 | `reg.exe` 失败与被查询值不存在都返回 `null` | 「未安装」被套在「读不到」上 |
| 4 | 注册表名匹配用 `line.contains(name)` | `Release` 会匹配到更长的值名 |
| 5 | `isPermissionGranted` 是接口默认方法、恒返回 `false` | 「宿主不支持查询」被报成「缺少权限」 |
| 6 | 5 个缺失项连发 5 条错误 toast，其中可能有误报 | 真正的错误被淹掉，用户学会忽略它 |

## 方案

**判定从二态（`ok: Boolean`）改成四态**，并把规则收敛成一句话：

> **只有证据能产生「缺失」。拿不到证据只产生「无法判定」，而「无法判定」绝不表述成缺失。**

| 判定 | 含义 | 计入「缺少运行环境」 | 阻止打开反馈页 |
| --- | --- | --- | --- |
| `PASS` | 读到值且达标 | 否 | 否 |
| `FAIL` | **明确读到**不达标或明确不存在 | 是 | 是 |
| `UNKNOWN` | 读不到 / 无法解析 / 无法区分 | 否 | 否（合并成一条 ⚠） |
| `ADVISORY` | 软依赖（远端会话、音频、日志管道） | 否 | 否 |

### 新增/重写

| 文件 | 职责 |
| --- | --- |
| `spw-folia/.../FoliaEnvironmentProbe.kt`（新增） | **探测层**：只回答「读到了什么、从哪读的、为什么没读到」。每个探测返回 `Evidence(value, source, raw, error)`；**全部不抛异常**，异常被捕获成带原因的 `Evidence`；子进程 3 s 上限 |
| `spw-folia/.../FoliaDiagnostics.kt`（重写） | **判定层**：只做判定与呈现。每项带 `evidence`，写进日志与反馈 issue |
| `poc/settings-ui/src/chrome/ProblemReportPanel.tsx` | 播放页面板对齐同一套四态；`Number(report.dotnet)` 把 `null` 变 `0` 导致必然 fail 的缺陷一并修掉 |
| `poc/webview/host/HostForm.cs` | `BuildEnvReport` 新增 `windowsBuild` / `webView2Error` / `dotnetError`：**null 现在带原因**，面板才能报「无法判定」 |
| `spw-folia/.../FoliaHostBridge.kt` | 退出码翻译成用户能读懂的句子并 toast（`docs/host-app.md` §2 定义了映射，但此前只写进日志） |

### 判定依据（关键项）

- **Windows build**：注册表 `CurrentBuildNumber`（回退 `CurrentBuild`，再回退 `os.version` 的三段式，
  再不行报 `UNKNOWN`）。真机实测 `Windows 11 (26H2, build 26300.9711), amd64`。
- **.NET**：`Release` 按 `reg.exe` 的**类型标记**解码（`REG_DWORD` 走十六进制，`REG_SZ` 走十进制）。
- **WebView2**：三个 `EdgeUpdate\Clients\{F3017226-…}` 的 `pv`，回退 `Application\<ver>\msedgewebview2.exe`；
  `pv=0.0.0.0` 是「已注册但不可用」，判 FAIL。
- **权限**：`isPermissionGranted` 返回 `false` 时判 `UNKNOWN` 并在证据里写明「该接口默认实现恒为 false」，
  把用户引到插件权限页核对，而不是断言缺权限。

## 验证

**单元测试（18 个，全绿）** — `spw-folia/src/test/kotlin/dev/spw/folia/FoliaDiagnosticsTest.kt`。
样本全部取自本机真实输出，不是构造值：

- `os.version = "10.0"` → `UNKNOWN`，**且断言它不是 FAIL**（截图里的回归点）
- `Release REG_DWORD 0x82718` → 534296；`REG_SZ "528040"` → 528040（不被误当十六进制）
- CRLF 残留 `` 不破坏解析；`line.contains` → 精确 token 匹配
- 四态语义：只有 `FAIL` 计入 missing；只有 `UNKNOWN` 的报表仍算 healthy
- 退出码翻译：0 与未知码不产生文案

**真机自检** — `cd spw-folia && ./gradlew runDiagnostics`（打印每条判定 + 证据）：

```
PASS      Windows 10 x64（1809+）   Windows 11 (26H2, build 26300.9711), amd64
          evidence: build: registry [CurrentBuildNumber REG_SZ 26300]; arch: os.arch=amd64; ubr: registry [UBR REG_DWORD 0x25ef]
PASS      .NET Framework 4.8        Release=534296（4.8 起算 528040）
          evidence: registry [Release REG_DWORD 0x82718]
PASS      WebView2 Runtime（≥ 86）   150.0.4078.83
```

对比 v0.4.6：同一条 Windows 检查从**必然 FAIL** 变为 PASS。

**发行包端到端验收** — `node packaging/tools/verify-layout.mjs`（真实宿主 + 真实 WebView2 加载打包产物）：

```
"consoleErrors": 0
"hasUi": true, "hasBridge": true, "uiApi": true
"canvases": 3, "settingsScripts": 1, "avatarAssetStatus": 200
screenshots: packaged-firstrun-settings.png:85128, packaged-visualizer.png:848274
```

**前端类型检查** — 顺带修掉 `tsconfig.json` 里 `baseUrl` 在 TypeScript 7 下导致 `tsc` 直接无法启动
的问题（`error TS5102`）。修好后对全仓跑 `tsc --noEmit`：改动前后同为 62 个错误（全部来自
gitignore 掉、未随仓库分发的 `work/` 上游源码目录），**本次改动引入 0 个新错误**。

## 产物

> **本地产物，未发布。** 下面这个 `.spmod` 只在本机 `dist/release/` 里，**从未上传 GitHub Releases**。
> 最后发布的版本是 v0.4.6。

```
dist/release/spw-folia-0.4.6.1.spmod
  10,948,881 B (10.44 MiB) · 3907 条目
  sha256 a3f1b9158c9b29356eb30e608b894450ec62968cc44df49b0fe07ff4b862117c
  classes/ 91 · web/ 3804 · native/ 5 · licenses/ 7
  Plugin-Version: 0.4.6.1 · Plugin-Id: dev.spw.folia
  Plugin-Permissions: class-transform,library-read,key-bindings
```

上游与工具链版本（本次构建实测）：Folia **v0.7.22**（tag `1f6d0f46`，`vite build` 原生产出
23 MB OBS bundle）、WebView2 SDK **1.0.4314.35**、宿主 `spw-folia-host.exe` 165,888 B、
`web/settings/settings-ui.js` 2,253.78 kB。
