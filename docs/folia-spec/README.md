# Folia 复刻规格

插件跑的是 Folia **自己**的渲染代码，不是按截图重画的仿制品：宿主窗口里加载 Folia 的生产 OBS 浏览器源页面，
17 种歌词样式、背景、字幕与转场全部是上游原码；插件的活是给这套渲染器喂数据、并在同一页面里注入自己的
chrome 与设置界面。这套文档说明**它现在是什么样、怎么用、改的时候看哪里**。

事实基线：Folia **0.7.25**（`work/folia/folia-major-main`，AGPL-3.0，只读副本）、**17 种样式**、
插件 v0.4.17、SPW 兼容 ≥ 1.19.0。

## 文档

| 文档 | 内容 |
|---|---|
| [`style-map.md`](style-map.md) | 17 种样式的清单（货架顺序 / mode id / 渲染技术 / tuning 键）、样式注册契约、动感效果表、货架与预览机制、背景系统、主题与字体、随包素材与许可 |
| [`settings-ui.md`](settings-ui.md) | 「歌词样式」窗口：骨架与颜色令牌、左栏预览与货架、四个 tab 的控件与默认值、构建期裁剪清单、「默认」语义、状态与下发链路 |
| [`fullscreen-shell.md`](fullscreen-shell.md) | 全屏播放页：层叠顺序、chrome 与自动隐藏、点击分区与播放条、穿透热区上报、开屏与透明、与上游播放页的取舍 |
| [`runtime-contracts.md`](runtime-contracts.md) | 渲染器契约：`VisualizerSharedProps` 全表、MotionValue、`Line`/`Word` 语义、`GlowWord` 词级动画、音频 0..255 + gamma + 呼吸值、字幕层、样式/歌曲切换、背景、宿主→页面三条流、性能开关 |
| [`tunings.md`](tunings.md) | 16 个样式的 tuning：settingsKey / 面板 / 存储键，以及**每个字段的默认值**；4 个背景的 tuning 默认值；默认值打底为什么必须 |

相关文档：协议 [`../protocol.md`](../protocol.md)、宿主 [`../host-app.md`](../host-app.md)、
设置岛实现 [`../settings-ui-impl.md`](../settings-ui-impl.md)、大预览契约
[`../live-preview-iframe.md`](../live-preview-iframe.md)、透明 [`../live-transparency.md`](../live-transparency.md)、
上游升级 [`../upstream-sync.md`](../upstream-sync.md)。

## 六条必须知道的事实

1. **画面来自 Folia 的 OBS 页面**：宿主用 `SetVirtualHostNameToFolderMapping` 把 web bundle 挂到
   `https://spw-folia.local`，导航到 `index.html?obs=1`；`Shim.js` 把假的 `EventSource` 接上宿主消息，
   页面自建 MV、rAF 与行号计算。没有 HTTP 服务、没有 Electron。
2. **音频是 0..255，且已套 gamma**：`audioPower = ((bass + lowMid) / 2 / 255)^3 * 255`，各频段另有 boost；
   暂停不是 0，是 `(sin(nowMs/2000)+1)*20` 的呼吸值（0..40）。照抄 0..1 会让多个样式「不随音乐动」。
3. **config 由页面构建、单一入口下发**：设置岛把 `SettingsSnapshot` 编译成 Folia 的
   `ObsBrowserSourceConfig`（≤10Hz、去重）后 `pushConfig`，`Shim.deliver('config')` 是播放页唯一的 config 入口。
   不要另造一份「设置页以为的」配置。
4. **样式 = 上游 `entry.tsx` 的注册项**：货架顺序是 `order` 升序（商籁10 … 静止130），第 16 个中文是
   **镜台**不是「铭台」，顺序与中文名双向校验（`check-style-sync.mjs` + 模块加载期断言）。
5. **tuning 必须 defaults-first 合并**：上游的 `apply` 原样存 bag，少一个键会让渲染器算出 `NaN` 并静默丢整个
   构图。插件在持久化层与发布层各打一次底。
6. **注入页做不到的事在构建期裁掉**：节拍效果、和声字幕、罗马音、上传类控件都不显示成死开关，裁剪由
   `vite.config.ts` 的 `SETTINGS_SURGERY` 做标记校验，上游改源码导致标记失配时**构建直接报错**。

## 改东西时的路径

| 要做的事 | 看/改哪里 |
|---|---|
| 加新样式、跟上上游版本 | [`upstream-sync.md`](../upstream-sync.md) + `poc/settings-ui/scripts/check-style-sync.mjs` |
| 改样式调参或默认值 | [`tunings.md`](tunings.md) §1/§4 |
| 改设置窗口控件 | [`settings-ui.md`](settings-ui.md) §6 |
| 改渲染输入、字幕、音频 | [`runtime-contracts.md`](runtime-contracts.md) §2/§7/§8 |
| 改播放页 chrome 或交互 | [`fullscreen-shell.md`](fullscreen-shell.md) §3–§5 |
| 改跨进程字段 | [`protocol.md`](../protocol.md)（改动需同步三端） |

## 源码落点

| 位置 | 是什么 |
|---|---|
| `work/folia/folia-major-main/` | 上游 Folia 0.7.25 只读副本（AGPL-3.0）；`src/components/visualizer/` 是样式层 |
| `poc/webview/dist/dist/` | 上游构建产物（宿主就是加载它）；由 `packaging/tools/stage-web.mjs` 校验并暂存 |
| `poc/webview/host/` | 宿主 exe 源码：`HostForm.cs`、`Program.cs`、`Shim.js`、`PreviewShim.js`、`audio/` |
| `poc/settings-ui/` | 注入的设置岛：`src/App.tsx`、`src/model/`、`src/publisher/`、`src/chrome/`、`vite.config.ts`（含裁剪与闸门） |
| `spw-folia/src/main/kotlin/` | 插件：菜单 hook、播放时钟、设置持久化、宿主生命周期 |
