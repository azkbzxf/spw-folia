# Third-party notices

`spw-folia` 整体以 **AGPL-3.0-or-later** 分发，因为它是 **Folia** 的衍生作品。
本文件分三类说清楚：**随包分发的第三方组件**、**只作行为参考的项目**、**本项目自己的原创代码**。

- 完整许可证正文：[LICENSE](LICENSE)（AGPL-3.0）
- 维护者视角的许可义务、源码提供方式与更新流程：[docs/licensing.md](docs/licensing.md)

---

## 一、随包分发的第三方组件

这些组件的代码或数据**实际存在于** `.spmod` 里，各自的许可证与声明必须随包保留。

### Folia — 歌词可视化本体

| | |
| --- | --- |
| 上游 | <https://github.com/chthollyphile/folia-major>（作者：chthollyphile） |
| 版本 | **0.7.25**（tag `v0.7.25`） |
| 许可证 | **GNU AGPL-3.0** |
| 在包内 | `web/**`（约 3,891 个文件） |

`web/` 是 Folia 0.7.25 的**生产构建产物**（OBS 浏览器源入口），原样分发：完整产物、
17 种歌词样式、背景、辉光词、字幕/和声叠加、转场。与上游构建输出相比**只改了一个文件**：
`index.html` 删掉了 service-worker 注册标签与 manifest 链接（因为插件不分发 service worker）。
这个改动记录在包内的 `licenses/NOTICE.md`，并可由 `packaging/tools/stage-web.mjs` 复现。

设置界面（`web/settings/`）由本仓库源码 `poc/settings-ui/` 构建，复用了 Folia 的 React 组件与
`zh-CN` 翻译资源（见 `docs/settings-ui-impl.md` 的适配清单），因此同样受 AGPL-3.0 约束。

因为 Folia 是 AGPL-3.0，**整个插件**（Kotlin 插件 + C# 宿主 + 设置岛 + 随包 web 产物）
也按 AGPL-3.0 分发。对应源码全部在本仓库；Folia 自身的源码见上面的上游地址与 tag。

### AnimCJK 笔画数据（雾笺 / Nebbia 样式）

| | |
| --- | --- |
| 上游 | <https://github.com/parsimonhi/animCJK>（commit `99dba566b92daf45ae20d05e6c91d3f68d8619f2`） |
| 版权 | Copyright 2016-2026 FM&SH；其图形数据派生自 Arphic PL KaitiM GB / Big5 字体与 [Makemeahanzi](https://github.com/skishore/makemeahanzi) |
| 许可证 | **Arphic Public License**（本文件用到的图形数据部分仅 APL） |
| 在包内 | `web/nebbia-strokes.json`（4.5 MB）、`web/licenses/nebbia-strokes/{ARPHICPL.TXT,COPYING.txt,NOTICE.txt}` |

这是雾笺样式逐字书写歌词用的笔画中线数据，由 Folia 自己的
`dev/nebbia/nebbiaStrokesPlugin.mjs` 在构建期从固定 commit 生成。相对上游做了修改：
只保留每个字的 `medians`（丢掉轮廓），y 轴翻转（`y' = 900 - y`，1024 网格），去掉网格外的
辅助笔画。按 APL §2(a)，该修改记录在数据文件自身的 `notice` 键与 `NOTICE.txt` 里。

缺少这个文件时雾笺会退化为描摹字体骨架，歌词仍然有动画，其余样式不受影响。

### Microsoft Edge WebView2 SDK

| | |
| --- | --- |
| 来源 | NuGet 包 `Microsoft.Web.WebView2`，版本 **1.0.4314.35** |
| 许可证 | Microsoft WebView2 SDK 许可（随包的 `licenses/WebView2-SDK-LICENSE.txt` 与 `-NOTICE.txt`） |
| 在包内 | `native/Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll` |

**WebView2 Runtime 本身不分发**：它是用户机器上的系统组件（Windows 11 自带），
插件只依赖它存在。三个 dll 是可再分发的 SDK 部分。

### 设置岛里随包的 JavaScript 库

`web/settings/` 是打好的 bundle，下列库的代码以压缩形式进入产物（版本取自
`poc/settings-ui/package.json` 与实际安装版本）：

| 库 | 版本 | 许可证 |
| --- | --- | --- |
| React / React DOM | 19.3.1 | MIT |
| pixi.js | 8.21.0 | MIT |
| three（含 `@react-three/fiber` 等 react-three 系列） | 0.185.1 / 9.8.1 | MIT |
| framer-motion | 13.5.1 | MIT |
| zustand | 5.0.15 | MIT |
| i18next / react-i18next / i18next-browser-languagedetector | 26.4.7 / 17.0.21 / 8.2.1 | MIT |
| react-window | 2.3.4 | MIT |
| react-colorful | 5.8.1 | MIT |
| lucide-react | 1.59.0 | ISC |

这些是宽松许可，与 AGPL-3.0 分发兼容。完整依赖树与锁定版本见
`poc/settings-ui/package.json` 与 `pnpm-lock.yaml`；构建产物里每个库保留其原始许可条款。
`package.json` 里还有些依赖只参与构建或被 tree-shake 掉（如 dexie、wanakana、opencc-js、
twgl.js），它们没有进入分发的 bundle，但仍在依赖清单里。

### 未随包分发的构建期/宿主提供组件

| 组件 | 许可证 | 为什么不算分发 |
| --- | --- | --- |
| SPW Workshop API `com.github.Moriafly:spw-workshop-api:0.1.0-dev23` | 见上游仓库 | `compileOnly`，运行时由 Salt Player 提供 |
| PF4J 3.12.0 | Apache-2.0 | `compileOnly`，宿主带 PF4J 运行时 |
| Compose Multiplatform runtime/foundation/ui 1.12.1 | Apache-2.0 | `compileOnly`，宿主拥有 Compose 运行时 |
| Kotlin stdlib / Kotlin Coroutines | Apache-2.0 | `compileOnly`，宿主自带 |
| Gradle wrapper、Node/pnpm/Python 工具链 | 各自许可证 | 只在构建时使用 |
| Microsoft .NET Framework 4.8 | Microsoft EULA | 系统组件，宿主 exe 只链接不携带 |
| Folia 的 AI/节拍模型权重（`beat_this` / `htdemucs`，约 133 MB） | Folia 的 AGPL 分发 | **不分发**；它们是 Folia 桌面应用的 Electron 主进程资源，不在 web 产物里 |
| 字体 | — | **不随包带任何字体文件**；用系统字体栈，或用用户自己安装的字体 |

---

## 二、只作行为参考的项目（未复制代码）

**spw-island** — <https://github.com/gaboron/spw-island>，许可证 **GPL-3.0**。

它是另一个 SPW 创意工坊插件（Kotlin/Compose Desktop 桌面挂件）。我们参考了它的**架构做法**：
工坊插件如何创建独立窗口、如何探测播放状态、如何以子进程方式分发并拉起原生辅助程序，
以及鼠标穿透用系统级 shaped input region 而非合成点击的思路
（见 `poc/webview/host/HostForm.cs` 的 `CreateRectRgn`/`SetWindowRgn` 实现与
`docs/live-transparency.md`）。

**没有复制任何源码**：我们的宿主是 C#/.NET Framework 4.8（对方是 Kotlin/JNA），实现、
接口与代码结构都是独立写的。该项目也不随 spw-folia 分发。它按 GPL-3.0 的要求在这里致谢，
但不构成 spw-folia 的许可证约束。

---

## 三、本项目原创代码（不属于第三方）

以下都是我们自己写的，列出来是为了避免被误认为第三方组件：

- **Kotlin 插件**（`spw-folia/`）：宿主生命周期、协议收发、菜单 hook、设置持久化、环境自检。
- **C# 原生宿主**（`poc/webview/host/`）：无边框全屏窗口、WebView2 承载、虚拟主机映射、
  DPI/多屏、透明与穿透、开屏与截图。
- **设置岛**（`poc/settings-ui/`，React）：设置界面与大预览。它复用 Folia 的组件（受 AGPL 约束），
  但插件侧的组织、注入协议与适配层是本项目代码。
- **WASAPI 环回音频分析**（`poc/audio/native/*.cs`）：我们自己的干净实现，从系统环回采集到
  FFT 频谱与节拍，**没有使用任何第三方音频库**（没有 NAudio，也没有 FFTW）。
  这些源文件带 `SPDX-License-Identifier: MIT` 头，MIT 正文见包内 `licenses/AUDIO-MIT.txt`。
  注意：它被编译进以 AGPL-3.0 分发的宿主 exe，所以**分发出去的二进制是 AGPL-3.0**；
  MIT 是该文件在源码层面的许可，不改变整体分发许可。

---

## 分发者的义务（摘要）

1. 随包保留 `licenses/` 全部内容（AGPL 正文、`NOTICE.md`、`THIRD-PARTY.md`、`SOURCE-OFFER.md`、
   `AUDIO-MIT.txt`、WebView2 两份文本）与 `web/licenses/nebbia-strokes/` 下的三份 Arphic 文件。
2. 修改后分发时，仍需按 AGPL-3.0 提供对应源码；通过网络提供服务的场景适用 AGPL-3.0 §13。
3. 保留各方的版权声明，不得以更严格的专有条款再授权。
4. 本项目是非官方社区作品，与 Salt Player for Windows 及 Folia 的作者无隶属关系、
   未获其背书。
