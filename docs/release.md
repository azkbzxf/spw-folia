# spw-folia — packaging & release pipeline

`packaging/` 是 `.spmod` 的**载荷来源**：它把三块内容（Folia web bundle、原生辅助进程、许可证文本）
暂存成固定布局，再由 `assemble-release.py` 与 Gradle 产出的插件 `classes/` 合并成可分发安装包。
本文只讲**当前**的打包与发布方法；单个版本的字节数、sha256 与变更说明以
[GitHub Releases](https://github.com/azkbzxf/spw-folia/releases) 为准，不要写回这里。

## 1. 载荷构成

```
packaging/
  web/                         # -> .spmod/web/            宿主离线加载的页面
    index.html                 #   Folia OBS 浏览器源入口（已移除 PWA 标签）
    assets/…                   #   完整 Folia web chunk 图，含每个按需 lazy chunk
    preview.html               #   生成：设置页实时预览的 iframe 入口（打过补丁的 index.html + preview shim）
    _host/preview-shim.js      #   生成：子文档 shim，为预览桩掉 EventSource
    settings/settings-ui.js    # -> 注入式设置岛（CSS 内联在这一个文件里）
    settings/assets/           #   设置岛自带的 chunk（与 web/assets 重复的已去重为 /assets/…）
    settings/thumbs/*.jpg      #   15 张样式预览静帧（设置岛按 thumbs/<mode>.jpg 取）
    _host/shim.js, overlay.js  #   嵌在 exe 里的脚本的审计副本
  native/                      # -> .spmod/native/
    spw-folia-host.exe         #   C# .NET Framework 4.8 辅助进程
    spw-folia-host.exe.config  #   PerMonitorV2 DPI + supportedRuntime v4.8
    Microsoft.Web.WebView2.Core.dll
    Microsoft.Web.WebView2.WinForms.dll
    WebView2Loader.dll
  licenses/                    # -> .spmod/licenses/
    AGPL-3.0.txt               #   AGPL 全文（Folia + 本项目）
    NOTICE.md / SOURCE-OFFER.md / THIRD-PARTY.md
    AUDIO-MIT.txt              #   WASAPI 分析器（本项目原创，MIT）
    WebView2-SDK-LICENSE.txt / WebView2-SDK-NOTICE.txt
  tools/                       # 构建与校验工具（从不随包分发）
    stage-web.mjs              # 整棵 dist 暂存（排除 SW/PWA）+ index.html 补丁 + 预览帧生成 + 设置岛去重
    apply-image-overrides.mjs  # 把 image-overrides/ 覆盖到暂存的 web 树上
    make-image-overrides.py    # 从上游 dist 重新生成覆盖图（需要 Pillow）
    size-report.mjs            # 体积统计 + 预算判定
    verify-layout.mjs          # 打包后布局的端到端测试
    assemble-release.py        # 把 packaging 载荷合并进 Gradle 产出的 .spmod
  image-overrides/             # 提交进仓库的瘦身版上游插图（不作为独立目录分发）
    MANIFEST.md
    assets/…                   # 256 色 PNG / q88 JPEG，文件名与格式同上游
    preview/…                  # 两张生成的预览封面
  testdata/default-settings.json  # 冒烟测试用的设置树，同时作为插件的默认设置资源
  web-stage-report.json        # 暂存/排除清单（审计）
  size-report.json             # 体积预算结果
  SHA256SUMS.txt               # 每个已分发文件的 sha256
  out/                         # 校验证据（截图、报告、fps 日志），不随包分发
```

体积有两个独立的门限，分别守不同的东西：

| 门限 | 位置 | 当前值 | 超限行为 |
| --- | --- | --- | --- |
| 暂存膨胀警戒 | `size-report.mjs` `budgetMB` | **32 MB**（解压后暂存总量） | 只报告 `OVER`，不中断 |
| **用户下载体积** | `assemble-release.py` `SHIPPED_BUDGET_MB` | **16 MB**（`.spmod` 本身） | 打印原因并 **exit 1** |

两者不可互换。暂存量是解压后的目录，约为 `.spmod` 的 2.2 倍（v0.4.7 实测 26.19 MB → 11.89 MB），
把它当作用户体积会得到误导性的 `OVER` —— 这正是 P4-10 记录的坑：25 MB 那个数字在设置岛去重
瘦身后从没同步过，健康包也会报 OVER。现在暂存警戒值 = 当前 26.19 MB + ~22% 余量，刚好能抓住
一次 P4-8 式的回归（+54% / +7 MB）；而真正保护用户的 16 MB 卡在 zip 上，因为那才是用户下载的文件。

两处都不要「顺手调大」：先看 `size-report.json` 的 `biggest` 列表确认是什么变大了。

以下几处是刻意为之，改打包脚本时不要顺手改掉：

- **必须分发整棵 dist**，不能只取冷启动离线闭包。Folia 按需 `import()` 每种样式的渲染器
  （`assets/VisualizerTempera-*.js` 等），子集打包会让非默认样式黑屏
  （`Failed to fetch dynamically imported module`）。`stage-web.mjs` 因此在找不到任何
  `assets/Visualizer*` lazy chunk 时直接抛错。
- **只排除 PWA / service-worker 三件套**（`registerSW.js`、`sw.js`、`workbox-*`、
  `folia-cover-sw.js`、`manifest.webmanifest`）与本地 `.bak` 备份，同时把 `index.html` 里的
  service-worker 注册 `<script>` 与 `manifest` link 删掉。除此之外 `index.html` 不做任何修改。
- **设置岛资产去重**：Folia 的样式图与头像在页面构建和设置岛构建里各产出一份、字节完全相同，
  两者同源，因此把设置岛的引用改写成绝对路径 `/assets/<name>` 并删掉重复文件。宿主因此从 bundle
  源注入设置岛（见 `HostForm.cs` 的 `settingsInsideBundle` 分支），根绝对路径才能解析。
- **图片覆盖**：`apply-image-overrides.mjs` 用仓库内提交的瘦身版替换上游的插图 / 封面。
  上游 dist 变了要重跑 `python packaging/tools/make-image-overrides.py`（需要 Pillow）再暂存。

## 2. 构建前置

三份输入都不在仓库里（`.gitignore` 排除），必须先在本地生成：

```bash
# 1) 原生辅助进程 -> poc/webview/host/build/
bash poc/webview/host/build.sh

# 2) 设置 UI -> poc/settings-ui/dist/
cd poc/settings-ui && pnpm install && pnpm build && cd ../..

# 3) Folia 0.7.22 浏览器端产物 -> poc/webview/dist/dist/（见下）
```

### 2.1 获取 Folia 浏览器端产物

`poc/webview/dist/dist/` 要放的是 **Folia `folia-major` 0.7.22 的 web 构建输出**（`index.html` +
`assets/` 那一层，不是 Electron 的 `dist/` 上层）。两种来源：

**从上游源码构建（推荐，可复现）**

```bash
git clone https://github.com/chthollyphile/folia-major.git
cd folia-major && git checkout v0.7.22      # commit 1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe
npm ci
npx vite build                               # -> folia-major/dist/
# 把 folia-major/dist/ 的内容放到本仓库的 poc/webview/dist/dist/
```

**从已安装的 Folia 桌面版提取**：`<Folia 安装目录>\resources\app.asar` 解包后取其中的 `dist/`
子目录（Electron 的构建输出层，web 产物在它下面）。这条路快，但取得的是发布包里的产物，
版本号要自己核对；作为交付依据请用源码构建那条。

### 2.2 构建闸门：两个 Tailwind 配置文件必须存在

上游源码目录里必须有 **`postcss.config.js`** 与 **`tailwind.config.js`**。缺了这两个文件时
`npx vite build` **照样成功**，但 `src/index.css` 的 `@import "tailwindcss"` 不会被处理：

| 状态 | 产物 CSS | 后果 |
| --- | --- | --- |
| 两个文件存在 | `assets/src-*.css` ≈ 215 KB，含 `.h-full{height:100%}`、`.relative{position:relative}`，无 `@tailwind` 字面量 | 正常 |
| 两个文件缺失 | 同一产物 ≈ 30 KB，残留字面量 `@layer utilities{@tailwind utilities;}`，`.h-full` / `.relative` / `.flex` 一条都没有 | **所有 Tailwind 工具类失效**：设置页预览的渲染器布局塌成顶部一条（视口 1080 px 内容高度只剩 270 px） |

这条坑之所以难查，是因为构建、打包、校验都不会报错，只有人眼看预览才看得出来。重建 Folia
bundle 之前先确认这两个文件在，或者按上表的体积与 `.h-full` 做一次自检：

```bash
grep -c '\.h-full' poc/webview/dist/dist/assets/src-*.css   # 必须 > 0
grep -c '@tailwind' poc/webview/dist/dist/assets/src-*.css  # 必须为 0
```

空目录 / 只 checkout 了部分文件时最容易踩。

## 3. 重新打包

```bash
bash packaging/build-package.sh
```

脚本幂等，约 20 秒，依次做：`stage-web.mjs` 暂存 web（并生成 `preview.html` +
`_host/preview-shim.js`、执行设置岛去重）→ `apply-image-overrides.mjs` 覆盖插图 →
重建 `native/` → 重建 `licenses/`（从 `work/folia/folia-major-main/LICENSE` 拷 AGPL，
从 `poc/webview/tools/webview2.nupkg` 抽 WebView2 的 `LICENSE.txt` / `NOTICE.txt`）→
`size-report.json` → `SHA256SUMS.txt`。

输入缺失时脚本直接失败；`work/folia/.../LICENSE` 或 nupkg 不在时对应项只打 WARNING 并跳过
（产物会缺许可证文件，发布前必须补齐）。图片覆盖与实际文件不匹配只报 warning。

## 4. 组装 `.spmod`

Gradle 插件项目 `spw-folia/` 产出 SPW 元数据与 JVM 侧；`packaging/` 只提供载荷。映射：

| packaging | `.spmod`（解包后的插件目录） |
| --- | --- |
| `packaging/native/*` | `native/`（插件 `resolveHelper()` 也接受 `lib/`；`WebView2Loader.dll` 必须与 exe 同目录） |
| `packaging/web/*` | `web/` |
| `packaging/licenses/*` | `licenses/` |

安装后的插件目录形如：

```
%APPDATA%\Salt Player for Windows\workshop\plugins\spw-folia\
  enabled.txt
  permissions.json
  <插件元数据 + jar>            # 来自 spw-folia/ 项目，不由本目录暂存
  native\spw-folia-host.exe
  native\spw-folia-host.exe.config
  native\Microsoft.Web.WebView2.Core.dll
  native\Microsoft.Web.WebView2.WinForms.dll
  native\WebView2Loader.dll
  web\index.html
  web\assets\…
  web\settings\settings-ui.js
  licenses\…
```

`packaging/tools/`、`packaging/out/`、`packaging/testdata/`、各类 report **不要**放进 `.spmod`。

完整流程：

```bash
cd spw-folia && ./gradlew.bat plugin          # 1. classes/（+ 运行时依赖时的 lib/）
cd .. && bash packaging/build-package.sh       # 2. 暂存 web/native/licenses + 校验和
python packaging/tools/assemble-release.py \
    --spmod spw-folia/build/libs/plugin-dev.spw.folia-0.4.6.spmod \
    --staging packaging --out dist/release --name spw-folia-0.4.6.spmod   # 3. 合并
node packaging/tools/verify-layout.mjs         # 4. 干净解包后的布局测试
```

`assemble-release.py` 解包 Gradle 产物（`classes/`、`lib/`、`META-INF/` 原样保留），把
`packaging/{native,web,licenses}/` 映射到同名目录重新打成确定性 zip；必需文件缺失或 `.spmod`
清单缺 `Plugin-Id`/`Plugin-Class`/`Plugin-Version`/`Plugin-Name` 时失败。它同时写出
`<name>.json`（体积、sha256、条目数、插件元数据）。

**仅改 `classes/` 的兼容性发布**：不要重新暂存 `packaging/`——本地的 `native/` 与
`web/settings/settings-ui.js` 可能比已发布的旧，会让辅助进程或设置岛静默回退。正确做法是把新的
`classes/` 拼到上一个**已发布**产物上，并断言其余载荷逐字节未变：

```bash
gh release download v0.4.5 -p spw-folia-0.4.5.spmod -O dist/release/spw-folia-0.4.5-ref.spmod
python packaging/tools/splice-compat-release.py \
    --base dist/release/spw-folia-0.4.5-ref.spmod \
    --classes spw-folia/build/libs/plugin-dev.spw.folia-0.4.6.spmod \
    --out dist/release/spw-folia-0.4.6.spmod --version 0.4.6 \
    --payload-note "v0.4.5 (web/native/licenses unchanged)"
```

`splice-compat-release.py` 保留所有非 `classes/` 条目，任何条目 CRC 变化都会让它失败。v0.4.6
就是这样发布的（改的是菜单目标解析机制，web/native 载荷与 v0.4.5 相同）。

## 5. 插件 → 辅助进程的 spawn 契约

插件把辅助进程作为子进程启动，工作目录 = 插件目录，传进去的都是绝对路径（cwd 只是兜底）：

```text
native\spw-folia-host.exe --bundle <web 绝对路径> --fullscreen --bundle-version <插件版本>
    [--no-curtain | --curtain-palette #RRGGBB,#RRGGBB,…]
    [--settings-dir <dir> --settings-entry settings-ui.js]
    --log-file <插件目录>\spw-folia-host.stdout.log
    [--verbose-log]
```

- `--bundle` — 本地 Folia bundle，映射到 WebView2 内的 `https://spw-folia.local/`。没有 HTTP
  服务器、没有端口、不联网。
- `--bundle-version` — 插件版本，用于设置岛注入 URL 的 cache-buster
  （`https://spw-folia-settings.local/<entry>?v=<bundleVersion>`），避免 WebView2 磁盘缓存
  在插件升级后继续供旧的 `settings-ui.js`。
- `--settings-dir` / `--settings-entry` **只在设置岛不在 `<bundle>/settings/` 下时才传**：
  辅助进程会自动探测 `<bundle>/settings/settings-ui.js`，打包布局下无需显式传参。
- `--no-curtain` / `--curtain-palette` — 开屏转场动画（长度固定 0.8 s，由 SPW 配置页控制开关）。
- `--log-file` — 插件镜像宿主 stdout 的日志路径，「出现问题」环境报告会引用它。
- `--verbose-log` — 额外的导航与逐窗口卡顿日志，默认关，由配置页打开。
- `--fullscreen` 是常态；`--window WxH` 仅调试用；`--force-dsf 1` 仅调试用（见 §8）。
- `--open-settings` 是**辅助进程支持、但插件不传**的参数：它让注入的设置岛在
  `bridgeReady` 后自动展开设置面板（导航完成后 2.5 s 兜底定时器）。只有
  `packaging/tools/verify-layout.mjs` 这类验收脚本会传它；真实用户首次运行**不会**自动弹出设置，
  设置面板由用户点右上角 ⚙ 或按 F1 打开。
- stdin/stdout 是 UTF-8 JSON 行（protocol v1，见 `docs/protocol.md`）。插件先发 `hello`、
  `settings`，之后每 ~100 ms 发 `state`，`lyrics` / `track` / `config` 变化时发。宿主回 `ready`、
  `log`、`closed`、`fps`。
- 单实例：同一时刻只有一个辅助进程；窗口已存在时把动作转给它，不重复 spawn。插件禁用时发
  `quit`，等退出，2 s 后强杀。
- 构建前若有残留的 `spw-folia-host.exe` 占着 exe，`csc` 会报 `CS0016`：
  先 `Stop-Process -Name spw-folia-host`。

## 6. 交互契约（protocol §7.5）

- 设置岛持有覆盖层：它注册 `window.__SPW_FOLIA__.ui`
  （`isSettingsOpen/openSettings/closeSettings`），并在打开期间自己在 capture 阶段吃掉 ESC。
- 宿主命令经 Shim 转给设置岛：`{"t":"command","command":"open-settings"}` /
  `"close-settings"` 分别调用 `ui.openSettings()` / `ui.closeSettings()`。
- 覆盖层**关闭**时 ESC 才落到宿主（`{type:"key",key:"Escape"}`），宿主关窗、发
  `{"t":"closed","reason":"user"}` 并 exit 0。
- F1 与 ⚙ 走同一条 `ui` 动作。

## 7. 打包布局验收测试

```bash
node packaging/tools/verify-layout.mjs           # 约 16 s，通过时 exit 0
node packaging/tools/verify-layout.mjs --no-open-settings   # 跳过首次运行自动展开这一项
```

它用 `packaging/native/spw-folia-host.exe` 对 `packaging/web` 跑一次真实会话
（窗口化 1600×900、独立 user-data 目录、流式喂 `hello/settings/lyrics/track` 与 100 ms
`state`），然后：

1. 4.2 s 时探测页面：桥与 `__SPW_FOLIA__.ui` 存在、3 个 canvas、设置岛从虚拟主机注入、覆盖层已开；
2. 截图 `packaging/out/packaged-firstrun-settings.png`；
3. 发 `close-settings` → 探测为关；发 `open-settings` → 探测为开（宿主↔页面双向路由）；
4. 派发 ESC → 只有设置岛关闭覆盖层，窗口仍在；
5. 截图 `packaging/out/packaged-visualizer.png`；
6. 再派发 ESC → 宿主发 `{"t":"closed","reason":"user"}`，exit 0。

通过判定在 `packaging/tools/verify-layout.mjs` 里写死（`report.pass`）：`exitedZero`、
`closedUser`、`bridgePresent`、`settingsInjected`、`closeSettingsCommand`、`openSettingsCommand`、
`escClosedSettingsOnly`、`visualizerCanvases`、`noConsoleErrors`、两张截图均 > 10 KB；
若本次带了 `--open-settings` 还要求 `settingsAutoOpened`。结果落盘
`packaging/out/verify-report.json`，随版本发布时作为证据保留。

相对路径 spawn（验证插件安装布局，在 `packaging/` 目录内执行）：

```bash
cd packaging && ./native/spw-folia-host.exe --bundle web --settings-dir web/settings \
  --settings-entry settings-ui.js --window 800x450 --duration 6500 --demo \
  --screenshot out/relcwd-shot.png --shot-at 5000
```

## 8. DPI / DSF 口径

- 生产环境在**窗口所在显示器的 DSF** 下全屏，页面 CSS 视口 = 显示器物理像素 / DSF。
  参考机上（3200×2000 @ 180 %）视口约 1778×1111，视觉器与全视口设置覆盖层都正常布局。
- `--force-dsf 1` 会把 `--force-device-scale-factor=1` 传给 WebView2，1600×1000 的窗口就得到
  1600×1000 的 CSS 视口。**只在**小窗口冒烟测试里用（Folia 设置窗口按 ≥1240×780 CSS px 设计，
  低于 `lg:` 断点会退化成单栏——这是 Folia 自身的响应式行为）。不要默认开启：它绕过了用户的
  Windows 缩放，在高 DPI 屏上会显得很小。

## 9. 离线保证

打包后的页面不发任何网络请求：同源/本地请求 0 外部依赖、0 失败；Folia `index.html` 里的
`aistudiocdn` importmap 在 OBS 入口下不生效；不加载网络字体（也没有字体文件随包分发）；
service worker 已移除。唯一的外部依赖是机器上的 WebView2 Runtime（系统组件）。

## 10. 许可证（AGPL-3.0）—— 发布必读

- Folia 的 web 构建是 **AGPL-3.0**，插件复用了它的代码与组件。因此插件及随它分发的一切
  （`web/`、设置岛、本打包目录）都以 **AGPL-3.0-or-later** 发布。
  `licenses/AGPL-3.0.txt`、`NOTICE.md`、`SOURCE-OFFER.md`、`THIRD-PARTY.md` 随插件目录分发，
  必须保留在那里。
- `web/` 是**未修改**的上游 Folia 生产构建，只删掉了 `index.html` 里的两个 PWA 标签
  （service-worker 注册与 manifest link），改动记录在 `NOTICE.md`，可由
  `packaging/tools/stage-web.mjs` 复现。
- WASAPI 分析器是本项目原创、以 MIT 分发；WebView2 SDK 的 DLL 按 Microsoft WebView2 SDK
  许可再分发（许可全文随包）。除 web 构建外不再分发任何 Folia 二进制资产、字体或模型权重。
- 上游来源在 `SOURCE-OFFER.md` 里固定为 `folia-major` 标签 `v0.7.22`
  （commit `1f6d0f468f5bc81b23a8b40ad7ca96ccd4b1ecbe`）与仓库地址；改这个版本时要同步改那份文件。

## 11. 发布检查表

1. 三份输入都是新的：辅助进程构建、设置 UI 构建、Folia bundle（含 §2.2 的 Tailwind 自检）。
2. `bash packaging/build-package.sh` 跑通；`size-report.json` 的结果有解释（超预算说明原因）；
   `SHA256SUMS.txt` 已重新生成。
3. `node packaging/tools/verify-layout.mjs` 通过，保留 `packaging/out/verify-report.json` 与截图。
4. 按 §4 组装 `.spmod` 并确认 `licenses/` 在里面。
5. 在真实 SPW 安装里冒烟：菜单项 → 全屏视觉器、⚙ / F1 开设置、ESC 两级关闭、切歌、暂停 / 跳转。
6. 版本信息写进 Release 说明：插件版本、宿主 exe 的 sha256、Folia 版本（`folia-major 0.7.22`）、
   WebView2 SDK / NuGet 版本与被测 WebView2 Runtime 版本。
7. 产物里没有密钥（`packaging/` 不含任何凭据）。

## 12. 校验已下载的产物

每个 Release 都同时上传 `.spmod` 与 `.spmod.sha256`：

```bash
sha256sum spw-folia-<version>.spmod     # 与 Release 里的 .sha256 对照
node packaging/tools/verify-layout.mjs  # 干净解包后的布局测试
```

各版本的历史体积与哈希不在这里留账本——`git log` 与 Releases 页面是权威来源。
