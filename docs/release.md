# 打包与发布

本文只讲**现在怎么打包、怎么发布**：发布物由什么组成、构建顺序、组装命令、体积门限、发版检查表、
打包布局验收。它不记录"某个版本怎么一步步做出来"——那属于 Git 历史与 GitHub Releases。

当前版本 **v0.4.18**（内嵌 Folia 0.7.25，17 种样式）。产物体积、条数与哈希见文末台账。

---

## 1. 发布物是什么

`.spmod` 就是一个 zip。解开后是 SPW 的插件目录：

```
packaging/                      # 暂存树，最终成为 .spmod 的 payload
  web/                          -> web/            宿主加载的页面（离线）
    index.html                  #    Folia OBS 浏览器源入口（已去掉 PWA 标签）
    assets/…                    #    完整 Folia 产物（含每个样式的懒加载 chunk）
    preview.html                #    生成物：设置页大预览 iframe 入口
    _host/preview-shim.js       #    生成物：预览子文档的 shim（顶替 EventSource）
    preview/placeholder_cover*.jpg  # 无封面时的占位图
    nebbia-strokes.json         #    雾笺笔顺数据（4.5 MB，上游构建产物）
    settings/settings-ui.js     # -> 注入的设置岛
    settings/thumbs/*.jpg       #    17 张真实样式缩略图
    licenses/nebbia-strokes/    #    雾笺笔顺数据的 Arphic 许可证全文 + 修改声明
    _host/shim.js, overlay.js   #    内嵌进 exe 的脚本的审计副本
  native/                       # -> native/（插件 resolveHelper 也认 lib/）
    spw-folia-host.exe          #    C# .NET Framework 4.8 辅助进程
    spw-folia-host.exe.config   #    PerMonitorV2 DPI + supportedRuntime v4.8
    Microsoft.Web.WebView2.Core.dll / .WinForms.dll / WebView2Loader.dll
  licenses/                     # -> licenses/
    AGPL-3.0.txt                #    Folia + 本项目的 AGPL 正文
    NOTICE.md / THIRD-PARTY.md / SOURCE-OFFER.md / AUDIO-MIT.txt
    WebView2-SDK-LICENSE.txt / WebView2-SDK-NOTICE.txt
  licenses-src/                 # 上面三份手写声明的唯一真源（改这里，不要改 licenses/）
  tools/                        # 构建与验收脚本（永不随包）
  image-overrides/              # 上游图片的瘦身副本（按同名同格式替换，不整树分发）
  testdata/default-settings.json # 冒烟用的设置树样本
  web-stage-report.json / size-report.json / SHA256SUMS.txt   # 审计产物
```

安装后的插件目录：

```
%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia\
  enabled.txt / permissions.json
  <插件元数据 + jar>            # 来自 spw-folia/（Gradle 构建，不由 packaging 提供）
  native\spw-folia-host.exe     # 必须与三个 dll、exe.config 同目录
  web\…  licenses\…
```

**不要**把 `packaging/tools/`、`packaging/out/`、`packaging/testdata/` 或任何报告打进 `.spmod`。

当前 **v0.4.18** 的 payload（解压后）：

| 区域 | 文件数 | 字节 |
| --- | --- | --- |
| `web/`（完整 Folia 产物 + 设置岛 + 2 份脚本审计副本） | 3,891 | 33,904,033 |
| `native/`（exe 178,688 B + config + 3 个 dll） | 5 | 1,116,126 |
| `licenses/` | 7 | 49,757 |
| `classes/`（Gradle 构建的插件类与元数据） | 104 | 829,445 |
| **合计** | **4,007** | **35,899,361**（压缩后 15,464,000 B） |

`web/` 必须是**完整**的 Folia 产物：Folia 按样式动态 `import()` 渲染器 chunk
（`assets/VisualizerTempera-*.js` …），只拷冷启动闭包会让非默认样式黑屏
（`Failed to fetch dynamically imported module`）。`packaging/tools/stage-web.mjs` 因此整树复制，
并在缺少按样式 chunk 时硬失败。只排除 PWA 三件套（`registerSW.js`、`sw.js`、`workbox-*`、
`manifest.webmanifest`，注册标签同时从 `index.html` 移除）与本地 `.bak`。

体积的大头是 `web/nebbia-strokes.json`（4.5 MB，雾笺笔顺）与 Folia 的 ICU 词典/渲染器 chunk。
两道瘦身：**设置岛资源去重**（与 `web/assets/` 逐字节相同的 29 个文件改写为 `/assets/…` 引用）、
**图片覆盖**（`packaging/image-overrides/` 把插画/头像/封面换成调色板 PNG / q88 JPEG）。

## 2. 构建前置

按这个顺序，顺序本身就是正确性：

```bash
# 1) 宿主 exe + dll（改过 poc/webview/host/** 才需要）
bash poc/webview/host/build.sh            # -> poc/webview/host/build/

# 2) 设置岛（改过 poc/settings-ui/** 才需要）
cd poc/settings-ui && pnpm build && cd ../..

# 3) Folia 产物：poc/webview/dist/dist（上游构建，见 docs/upstream-sync.md）
```

- **`packaging/native` 与 `packaging/licenses` 是生成目录**，只改真源：宿主来自 `poc/webview/host/build/`，
  声明文本来自 `packaging/licenses-src/`。改完 `cmp` 验字节。
- **先刷新 `packaging/native`，再构建插件**；反了就会把旧宿主装进包（本地安装目录里宿主大小来回跳就是这个循环）。
- `build.sh` 会改写 tracked 的 `DefaultConfig.json` 的 `updatedAt`，构建后还原，别把脏 diff 提交进去。
- **`csc.exe` 不是确定性编译器**：同一份源码两次导出的 exe 差 51 字节（PE 时间戳 / MVID / PDB GUID，
  长度相同、不含源码内容）。装配本身是确定性的。所以"可复现"的口径是
  **装配 + 插件包 + 暂存树可复现，宿主 exe 不可复现**，release notes 要如实写明。

## 3. 组装

```bash
bash packaging/build-package.sh          # 1. 暂存 web/native/licenses + 体积报告 + 校验和

cd spw-folia && ./gradlew.bat plugin     # 2. 插件类（含 META-INF 清单）

cd .. && python packaging/tools/assemble-release.py \
  --spmod spw-folia/build/libs/plugin-dev.spw.folia-0.4.17.spmod \
  --staging packaging --out dist/release --name spw-folia-0.4.17.spmod

node packaging/tools/verify-layout.mjs   # 3. 干净解包上的布局验收（§6）
```

`build-package.sh`（幂等，约 20 s）依次做：`stage-web.mjs`（含 `preview.html` 与 shim 生成、
设置岛去重）→ `apply-image-overrides.mjs` → 拷 native（5 个文件）→ 拷 licenses
（AGPL 取自 `work/folia/folia-major-main/LICENSE`，WebView2 的两份文本从
`poc/webview/tools/webview2.nupkg` 里抽）→ `size-report.json` → `SHA256SUMS.txt`。
任何输入缺失都会硬失败；过期的图片覆盖只告警（它们只覆盖仍然存在的文件）。

`assemble-release.py` 把 Gradle 产物解包后与暂存树合并成**确定性** zip：
`classes/` 原样带入，`packaging/{web,native,licenses}` 分别映射到同名目录，条目时间戳固定，
并在缺失 `index.html` / `settings/settings-ui.js` / `spw-folia-host.exe` / 五份 license 时拒绝出包。
它同时写 `dist/release/<name>.json` 旁车（字节数、条目数、sha256、插件版本、权限）并检查体积门限。

改过上游 Folia 产物要重跑 `python packaging/tools/make-image-overrides.py`（需要 Pillow）再暂存。

## 4. 体积门限

两个门限各守各的，别混：

| 门限 | 位置 | 数值 | 超限表现 |
| --- | --- | --- | --- |
| 暂存目录（未压缩） | `packaging/tools/size-report.mjs` | 32 MB | 只在报告里标 `OVER`，不中断 |
| 用户下载的 `.spmod` | `packaging/tools/assemble-release.py` | 16 MB | **`exit 1`**，拒绝出包 |

数字对不上先看 `size-report.json` 的 `biggest`，**别急着调大阈值**——设置岛误引整个渲染器注册表
一次就能多出约 7 MB。

## 5. 发布检查表（owner: Lead）

1. 构建输入是新的：宿主、设置岛、Folia 产物都按 §2 重新产出。
2. `bash packaging/build-package.sh` → 暂存干净、`size-report.json` 未超警戒线、
   `SHA256SUMS.txt` 已重写。
3. **跑门禁**：
   - `node packaging/tools/verify-all.mjs` —— `core`（版本三处一致、声明⇄读取双向、无重复键、
     无孤儿门禁脚本、JVM 配置失败路径）+ 3 个真实宿主套件**并发**跑，约 45 s。
     未运行的项打印为 `SKIP` 并给出原因，**不计入 PASS**。
   - `--static` 只跑不需要打包产物的部分。
   **健康机上出现 `FAIL` 就是阻断项。**
4. 发布物证据：`packaging/out/verify-all.json` 与 `packaging/out/click-zones/probe-report.json`、
   `packaging/out/verify-report.json` 及其截图留作发布证据。
5. 用 `assemble-release.py` 出包（§3），`licenses/` 必须留在包内。
6. 在真实 SPW 安装里冒烟组装好的 `.spmod`：菜单 → 全屏、首次运行设置、ESC、切歌、暂停/跳转、
   「出现问题」能打开日志文件夹。
7. 记录到 release notes：插件版本、宿主 exe 的 sha256、Folia 版本（0.7.25）、
   WebView2 SDK/NuGet 版本（1.0.4314.35）与实测 Runtime 版本、设置岛构建。
8. 三件资产上传（`.spmod` + `.spmod.json` + `SHA256SUMS.txt`），再
   `gh release download` 回读复算 sha256，与本地逐字节一致才算闭环。
9. 包内无凭据（`packaging/` 不含任何 token / cookie）。
10. 文档改过就跑 `python packaging/tools/check-doc-links.py`，必须 exit 0。

> 版本号散落三处，一次升级要改全：`build.gradle.kts` 的 `version`、`PluginVersion`、
> `FoliaPlugin.PLUGIN_VERSION`。门禁的静态契约会断言三者一致。补丁版一律 `X.Y.(Z+1)`。

## 6. 打包布局验收

```bash
node packaging/tools/verify-layout.mjs       # 约 16 s，exit 0 = PASS
```

它用**打包后的** `packaging/native/spw-folia-host.exe` 加载 `packaging/web`（＋
`--settings-dir web/settings --open-settings`，窗口化 1600×900，独立 user-data 目录），
喂 `hello/settings/lyrics/track` 与 100 ms `state` 行，然后断言 13 项：
`bridgePresent`、`settingsInjected`、`settingsAutoOpened`、`closeSettingsCommand`、
`openSettingsCommand`、`escClosedSettingsOnly`、`closedUser`、`exitedZero`、`visualizerCanvases`、
`styleThumbsLoaded`、`livePreviewReady`、`previewHasNoSplash`、`noConsoleErrors`，
并留两张截图（首次运行设置面板、播放画面）。报告写在 `packaging/out/verify-report.json`。

相对路径口径（安装布局）另有一条手工命令，从 `packaging/` 自身运行：

```bash
cd packaging && ./native/spw-folia-host.exe --bundle web --settings-dir web/settings \
  --settings-entry settings-ui.js --window 800x450 --duration 6500 --open-settings --demo \
  --screenshot out/relcwd-shot.png --shot-at 5000
```

## 7. DPI / DSF

- 生产环境全屏跑在显示器的设备缩放（DSF）下：参考机 3200×2000 @180 % → 页面 CSS 视口约
  1778×1111，可视器与整屏设置覆盖层布局都正确（设置面板按 ≥1240×780 CSS px 设计）。
- `--force-dsf 1` 会传 `--force-device-scale-factor=1`，只用于**小窗冒烟**，让 Folia 的 `lg:`
  断点生效。**生产绝不默认开**：它会绕过用户的 Windows 缩放，高分屏上会渲染得很小。

## 8. 离线与网络

打包后的页面不发起任何网络请求：断网实测 99 个请求全部同源/本地，0 外部、0 失败；
`index.html` 里的 aistudiocdn `importmap` 对 OBS 入口是惰性的；不下载字体（也不随包带字体）；
Service Worker 已移除。唯一的外部依赖是机器的 WebView2 Runtime（系统组件）。

## 9. 许可义务（发版必读）

插件与它分发的一切（`web/`、设置岛、宿主 exe、本打包树）都是 **AGPL-3.0-or-later**，
因为内嵌并复用了 AGPL 的 Folia。`licenses/` 下的 AGPL 正文、`NOTICE.md`、`SOURCE-OFFER.md`、
`THIRD-PARTY.md` 必须随包发出，不得删改。分发 `web/` 时它是上游 Folia 产物的**未修改**副本，
仅 `index.html` 去掉了两个 PWA 标签（`NOTICE.md` 有记录，`packaging/tools/stage-web.mjs` 可复现）。

组件清单、三类归属（真实分发 / 行为参考 / 本项目原创）与源码提供声明见
[`docs/licensing.md`](licensing.md) 与 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)。

> **待补齐**：`packaging/licenses-src/NOTICE.md` 与 `SOURCE-OFFER.md` 目前仍写
> "Folia 0.7.22 / commit `1f6d0f46…`"，而实际内嵌的是 **0.7.25**。下一次发版前应把上游 tag 与
> commit 改成 0.7.25，并重新跑 `build-package.sh` 让 `licenses/` 同步。

## 附录：发布产物台账

只保留**仍可下载**的版本，以及当前版本与已下架版本的行。早期版本（v0.1.0–v0.4.5）的 Release 已下线，
其字节数与哈希见 Git 历史；`local only` 的版本从未上传，改动并入后续发布。

**当前发布版本是 v0.4.18。**

| 版本 | `.spmod` 字节 | 条目 | sha256 | 发布状态 |
| --- | --- | --- | --- | --- |
| v0.4.6 | 12,476,192 | 3,912 | `fc06fd0724a4a6e8785bd912217c88c228aa1c234437d94e750c59a5f0619805` | 2026-10-30 发布（内嵌 Folia 0.7.22，15 种样式） |
| **v0.4.13** | **15,438,647** | **3,982** | `5cb1cdafacdea46559e4b57ad1934522e6b20874d2531aabad2b46cac948f308` | ~~2026-11-03 发布~~ **当日下架，Release 与 tag 均已删除；不要重新上架** |
| v0.4.14 | 15,442,237 | 3,983 | `9d787a8b6431e72f6455d167b8c7eb4b2ce66803e1941ca334a2f6c5aeefd612` | 2026-11-03 发布（v0.4.13 的修复版） |
| v0.4.15 | 15,443,035 | 3,983 | `9eb6763c7ad49707ccdb4f24b57cfd4e64a79a00ba3a837871c343b4fe26e5d9` | 2026-11-03 发布 |
| v0.4.16 | 15,462,458 | 4,007 | `4d3cde0fb53d6282b6edb5806180afb055293e5dcdf6e671ddf9fafae03bc25d` | 2026-11-03 发布 |
| v0.4.17 | 15,464,000 | 4,007 | `9ff9f66ebf9ff511c92a1ddede57a962be2266e36ec760c25a5af4b5afe48696` | 2026-11-04 发布 |
| **v0.4.18** | **15,464,554** | **4,007** | `19816c84b3252ffc77e78d32f5897aa6f02ca091609fe8dd5abe8493421354b2` | **2026-11-04 发布（当前）** |

台账里"缺行"的版本说明，免得读起来像缺页：

- **v0.4.13 已下架。** 它修好了三个开关失效，但同版本引入的重试递归在"两个配置文件都不存在"
  （全新安装的默认状态）时无限递归，把 SPW 界面卡死 9 分钟（`failure.kind=TERMINATED_HANG`）。
  Release 与 tag 已删除，取证包留在 `dist/release/taken-down/v0.4.13-handoff/`。
  复盘与门禁教训见 [`postmortem-v0.4.13.md`](postmortem-v0.4.13.md)；**不要再上传这个版本**。
- **v0.4.6.1 / v0.4.7 / v0.4.11 / v0.4.12 只在本地构建过**，从未上传，也没有 tag；
  它们的改动含在后续已发布版本里，不要指向这些版本号。
- **v0.4.4 / v0.4.8 / v0.4.9 / v0.4.10 从来没有独立产物**（v0.4.4 无 Release 也无 tag；
  v0.4.8–v0.4.10 是开发过程中的中间版本，只产出过插件包，没有组装完整 `.spmod`），所以没有字节/哈希可记。
- 版本号在代码里曾长期滞后（`build.gradle.kts` / `PLUGIN_VERSION` 停留在 `0.4.7`），
  `dist/release/` 里那些 `*-0.4.7*.spmod` 是更早的本地构建，不是已发布的 0.4.7。

校验一个下载到的产物：

```bash
sha256sum spw-folia-0.4.17.spmod        # 对比上表与 Release 附带的 SHA256SUMS.txt
node packaging/tools/verify-layout.mjs  # 干净解包上的打包布局验收
```

各版本的详细更新内容在 GitHub Releases（正文即 [`docs/release-notes-v0.4.18.md`](release-notes-v0.4.18.md)
这类文件），失败路径的技术细节在 `docs/lessons.md` 与 `docs/postmortem-v0.4.13.md`。
