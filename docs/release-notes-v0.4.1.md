# spw-folia v0.4.1 — 真实预览：预览框就是播放页，预览文本选项移除

v0.4.1 是一次**预览体验**更新：设置页左侧的大预览不再播放预置的示例歌曲、也不再用设置页
“以为的”配置去拼一个近似预览，而是**逐帧镜像播放页**——真实曲目、真实歌词、真实主题与背景、
真实播放进度与音频，连「播放页透明背景」打开后的透明效果也一并真实呈现。字体 tab 里的
「预览文本（当前歌词 / 神文之诗 / 野芝麻）」整项移除，默认即预览当前歌词；相关设置字段与
快照字段一起删除。这一版还修掉了一个打包体积回归（Python 3.14 的 zip 压缩级别未生效）。

## 重点

- **真实预览**：预览 iframe 直接消费**播放页实际收到的 config**，不再由设置页用占位歌重建
- **真实时间轴**：暂停/继续冻结或恢复的是真实时钟；歌词动画与播放页同一帧，不再本地合成
- **透明背景真实呈现**：播放页透明时预览框显示棋盘格 + 「播放页透明背景」角标，iframe 内歌词透明底
- **移除「预览文本」**：整行控件、`previewPlaceholderId` 状态与快照字段、两首内置示例歌数据全部删除
- **打包体积修复**：`.spmod` 从虚高的 12.38 MB 回到 **12,191,035 字节（11.63 MiB）**

## 新增 / 变更

- **预览框 = 播放页的镜像（新）** —— v0.4.0 及以前，设置页用 `previewSong.ts` 里的占位歌
  （神文之诗 / 野芝麻）+ `/preview/placeholder_cover.jpg` 预设封面 + `buildConfig()` 重建一份
  预览配置，再塞进 iframe 合成一条本地时间轴。问题有三：占位歌不是用户的歌；设置页重建的配置
  与播放页实际渲染的配置可能不一致（尤其宿主/插件直接下发 config 时）；本地合成时间轴与真实
  播放进度、音频频谱无关。
  v0.4.1 改为：

  1. **config 唯一来源 = 播放页收到的 config**：`Shim.js` 的 `deliver('config')` 在投递时记住
     `lastConfig` 并发出本地 `config` 事件；设置页 `usePlayerConfig()` 读 `bridge.lastConfig()` 并
     持续订阅，把同一份对象 `postMessage` 给预览 iframe——样式、调参、背景、字体、字幕、
     透明标记全部自动一致。
  2. **真实时钟与音频**：设置页订阅桥的 `state` / `audio` 事件（顶层 Shim 本来就在转发宿主
     数据），把原始 payload 转发给 iframe；`PreviewShim.js` 新增 live 模式，用与 `Shim.js`
     完全相同的映射转成 SSE `clock` / `audio` 事件驱动 Folia 渲染器，不再本地合成。
  3. **暂停冻结真实时钟**：暂停时用最后一帧 state 发 `PAUSED` 把时钟钉住，恢复时重发最后一帧，
     下一帧真实 state 到来即无缝接上；切到别的设置 tab 时预览继续跟随（不再被卸载重建）。
  4. 占位歌数据 `previewSong.ts` 删除，仅保留 `currentLyric.ts` 给字体选择器的样例行使用；
     预览框下方不再有预设背景色，透明时由设置页画棋盘格表示“这里会透出桌面”。

- **移除「预览文本」选项（新）** —— 字体 tab 不再有 `当前歌词 / 神文之诗 / 野芝麻` 三段选择：
  预览框永远是当前播放的歌词。实现上通过 `vite.config.ts` 的 `SETTINGS_SURGERY` 从上游
  `VisPlaygroundSettingsPanel.tsx` 移除 import、props、解构、重置调用与整行 `Row`（5 个 marker，
  上游改动会显式报错）；`previewPlaceholderId` 从 `SettingsState`、store 默认值、设置快照
  （`snapshotFromState` / `applySnapshot`）、`packaging/testdata/default-settings.json` 与
  `poc/webview/server/compat-regression.mjs` 中一并删除。旧快照里该字段被忽略，不影响升级。

- **透明背景真实呈现（新）** —— OBS 页面自身已把 `html/body` 设为透明，因此 iframe 里的透明
  配置可以直接透出下层：透明开启时预览框显示棋盘格 + 左下角「播放页透明背景」角标，歌词仍是
  真实透明底渲染；关闭后恢复真实主题背景。设置页外层不再给预览铺任何预设颜色。

- **打包体积修复** —— `packaging/tools/assemble-release.py` 在 Python 3.14 下用显式 `ZipInfo`
  写 zip 时，`ZipFile(compresslevel=9)` 不会传递到条目（3.14 改为 `ZipInfo.compress_level`），
  导致 `.spmod` 被按默认级别压缩、比上一版大约 190 KB。现在 `writestr(..., compresslevel=9)`
  显式传入，产物回到 **12,191,035 字节**（比 v0.4.0-preview.2 的 12,193,169 字节还小 2,134 字节）。

## 修复

- **预览与播放页不一致** —— 见「预览框 = 播放页的镜像」：不再用设置页重建配置。
- **预览框不是“当前歌曲”** —— 占位歌与预设封面移除，空闲（播放页还没有 config）时预览框保持
  空框而不是示例内容。
- **打包体积回归** —— 见上文「打包体积修复」。

## 验证

- **设置页构建**：`cd poc/settings-ui && npx --no-install vite build` → `dist/settings-ui.js`
  **2,237,591 字节**（v0.4.0 为 2,241,477 字节）。
- **bundle 组装**：`node packaging/tools/stage-web.mjs` → `previewHtml: true`、
  `previewShimCopied: true`、`indexHtmlPatched: true`。
- **打包**：`bash packaging/build-package.sh` → 3,837 文件 / 27,231,100 字节（`web/` 24.89 MB、
  `native/` 1.03 MB、`licenses/` 0.05 MB），与 v0.4.0 持平。
- **插件**：`cd spw-folia && JAVA_HOME="C:/Program Files/Java/jdk-21.0.10" ./gradlew plugin -q --offline`
  → `build/libs/plugin-dev.spw.folia-0.4.1.spmod` **205,694 字节**，manifest `Plugin-Version: 0.4.1`、
  `Plugin-Has-Config: true`、`Plugin-Permissions: class-transform,library-read,key-bindings`。
- **发布产物**：`dist/release/spw-folia-0.4.1-preview.1.spmod` **12,191,035 字节**
  （sha256 `6e07ae30a3f2a1f92c165afa0cb516fa87b75a7484bc909690c8001532a6b7fb`，3,896 条目；
  manifest `Plugin-Version: 0.4.1`）。
- **打包后验收**：`node packaging/tools/verify-layout.mjs` → PASS（10 项检查全绿：
  `exitedZero`、`closedUser`、`bridgePresent`、`settingsInjected`、`settingsAutoOpened`、
  `closeSettingsCommand`、`openSettingsCommand`、`escClosedSettingsOnly`、
  `visualizerCanvases`、`noConsoleErrors`；fps 中位数 103.2，heap 峰值 75.6 MB，0 控制台错误）。
- **真实预览真机验收**：`cd poc/settings-ui && node scripts/diag-real-preview.mjs`（宿主真机 +
  模拟插件 track/lyrics）→ **17/17 PASS**：
  - 设置页打开、预览 iframe 挂载、子帧 `ready`、config 送达、shim 处于 live 模式；
  - 预览框显示真实曲目（Spike Track）与真实歌词（8 行，来自插件协议）；
  - **iframe config === 播放页 config**（同一份 `lastConfig`，含 `background.transparent`）；
  - 子帧时钟与宿主 `posMs` 同步（如 19010 ms vs 19010 ms）；子帧持续出帧、canvas 3 个；
  - 透明开关同时到达父级 wrapper（`st-stage-transparent` + 角标）与 iframe config；
  - 暂停后子帧时钟冻结（两次采样 24427 ms 不变，宿主仍在走），恢复后重新前进（28362 ms vs 28379 ms）；
  - 字体 tab 已无「预览文本」，且切 tab 后预览继续渲染。
  - 截图：`poc/webview/host/out/real-preview/shots/preview-live.png`、
    `preview-transparent.png`、`preview-fonts.png`。
- **文档**：`docs/live-preview-iframe.md` 重写为 v0.4.1 契约；`docs/known-inert-settings.md`
  记录「预览文本」移除与旧快照字段忽略。
- **版本号**：`spw-folia/build.gradle.kts` 的 `version` 与 `PluginVersion` 均为 `0.4.1`；Kotlin 侧
  `FoliaPlugin.PLUGIN_VERSION` 同步为 `0.4.1`；`install-local.sh` 默认版本号为 `0.4.1`。

## 安装 / 升级

1. 关闭 Salt Player for Windows。
2. mod 管理器里删除旧版 `spw-folia`，导入 `spw-folia-0.4.1-preview.1.spmod`。
3. 授予 `class-transform`、`library-read` 与 `key-bindings`（快捷键；漏授可在插件权限页补授后重启）。
4. 重启 SPW，`更多 → Folia`；设置页打开「歌词样式」即可看到真实预览。

可直接覆盖升级 v0.4.0 / v0.3.x（协议与设置格式均未变；旧快照里的 `previewPlaceholderId`
会被忽略）。

## 已知限制

- 预览框内是**第二个完整 Folia 渲染器**（iframe），会额外占用一份 GPU/CPU 与内存；打开设置页
  期间属预期开销，关闭设置页即释放。
- 预览只在设置页可见时渲染（页面隐藏/最小化时暂停 rAF），不做后台运行。
- 播放页还没有收到 config 时（极短暂），预览框显示空框，不会回退到示例内容。
- 智能动感模式（smart beat）仍不可用：注入页没有节拍分析模型、宿主不发 `beat` 事件，节拍驱动的
  效果保持静止（与 v0.4.0 相同）。
- 系统字体列表不持久化（每次启动重新枚举），导入字体包存 IndexedDB（与 v0.4.0 相同）。
