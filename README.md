# spw-folia — Salt Player for Windows 的 Folia 歌词可视化插件

把 [Folia](https://github.com/chthollyphile/folia-major) 的歌词可视化带进 **Salt Player for
Windows（SPW）**：迷你播放器「更多」菜单里的 `Folia` 条目打开无边框全屏模式，用 Folia 自己的
15 种歌词样式跟着正在播放的音乐显示歌词；也可以让歌词透明叠加在桌面上。

[![Release](https://img.shields.io/github/v/release/azkbzxf/spw-folia)](https://github.com/azkbzxf/spw-folia/releases)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)](#兼容性)
[![Site](https://img.shields.io/badge/%E5%AE%A3%E4%BC%A0%E7%AB%99-azkbzxf.github.io%2Fspw--folia-ffb545)](https://azkbzxf.github.io/spw-folia/)

**中文** | [English](README.en.md)

<p align="center"><img src="docs/images/style-lumiere.jpg" width="92%" alt="绘光（lumiere）样式：金色星尘与发光歌词"></p>

## 功能介绍

- **跑的就是 Folia，不是仿制** —— 插件内嵌 Folia 0.7.22 的浏览器端渲染产物，15 种样式的动画、
  辉光、逐字时间轴和转场都来自 Folia 自己的代码。
- **15 种样式，随手切换** —— 商籁 · 凝彩 · 绘光 · 花火 · 流光 · 心象 · 云阶 · 浮名 · 倾诉 ·
  回环 · 莫奈 · 时计 · 群唱 · 镜台 · 静止。勾选几种组成随机池后，每首歌换一种且不连续重复；
  播放条上的骰子按钮可以当场重抽。
- **跟着音乐走** —— 逐字歌词、翻译字幕，播放 / 暂停 / 跳转 / 倍速都同步；画面也会随音乐的
  音量起伏。
- **播放条可以直接点** —— 播放 / 暂停、上一首 / 下一首、拖动进度、随机 / 循环，还能打开播放
  队列点选切歌。
- **设置页就是 Folia 的界面** —— 复用 Folia 自己的组件，左侧大预览显示的是真实歌曲、歌词、
  背景和透明状态；拖动任何滑块立刻看到结果。
- **自定义字体与字幕** —— 导入字体包（`.ttf` / `.otf` / `.woff` / `.woff2`，单个 ≤ 50 MB）或
  从系统字体里挑；字重、字号、自动字重、整体透明度、字幕样式与背景、即将歌词模糊等都可调。
- **封面取色** —— 主题、背景与强调色由当前歌曲封面派生，切歌即变。
- **桌面透明叠加** —— 全屏页右下角的圆钮面板可打开「播放页透明背景」，只留歌词与特效叠在桌面
  或其它窗口之上，适合直播 / OBS 叠加；打开后第二行会出现「鼠标穿透」，让你一边放歌词一边照常
  操作电脑。**Ctrl+Alt+B** 随时恢复不透明。
- **可改的快捷键** —— SPW 的「快捷键管理」里有三条可重绑动作：`呼出 / 关闭 Folia 歌词`
  （默认 **Ctrl+Alt+F**）、`播放页透明背景：开 / 关`（默认 **Ctrl+Alt+G**）、
  `播放页透明背景 + 鼠标穿透：开 / 关`（默认 **Ctrl+Alt+Shift+G**）。打开对应动作的「全局」
  开关后，窗口聚焦时也能用。
- **入口随手可得** —— 迷你播放器「更多 → Folia」、最小化后右键托盘图标都能开 / 关；窗口开在
  SPW 窗口所在的那块屏幕上，**Alt + 左键**可以拖到别的屏幕并铺满该屏；还能打开一段封面取色的
  淡入动画（默认关闭，见 SPW「模组管理 → 配置」）。
- **出问题有据可查** —— SPW「模组管理 → 配置 → 支持与反馈 → 出现问题」（播放页右上角救生圈
  按钮同效）会逐项检查 .NET / WebView2 / 插件文件 / 权限 / 可写目录，缺哪项就提示哪项；环境
  齐全时打开已预填环境信息与日志的反馈页，并选中日志文件。见
  [docs/logging-and-diagnostics.md](docs/logging-and-diagnostics.md)。
- **不联网、不上传** —— 运行时不发网络请求，数据只在插件与本地辅助进程之间传递；只读取播放
  状态与当前歌曲 / 歌词 / 封面，不写入音乐库。

## 截图

<p align="center">
  <img src="docs/images/fullscreen-chrome.jpg" width="49%" alt="全屏播放页，右上角 ⚙ 打开设置">
  <img src="docs/images/settings-ui.jpg" width="49%" alt="Folia 设置页：左侧是真实渲染器大预览">
</p>
<p align="center">
  <img src="docs/images/transparent-background.jpg" width="49%" alt="播放页透明背景：歌词直接叠加在桌面上">
  <img src="docs/images/style-grid.png" width="49%" alt="歌词样式一览">
</p>
<div align="center"><sub>全屏播放页 · Folia 设置页 · 播放页透明背景 · 歌词样式（样式图为 v0.3.x 拍摄，不含「花火」）</sub></div>

> 想一次看全？[**宣传站**](https://azkbzxf.github.io/spw-folia/) 有滚动演示、样式大图，以及
> [一段 48 秒的实拍巡览](https://azkbzxf.github.io/spw-folia/#film)（画面全部由插件真实渲染）。

## 安装与使用

1. 从 [Releases](https://github.com/azkbzxf/spw-folia/releases) 下载最新的 `.spmod` 安装包；
   也可以直接在 [Steam 创意工坊](https://steamcommunity.com/sharedfiles/filedetails/?id=3825012802)
   订阅（Steam 版会在订阅后自动安装）。
2. SPW → **设置 → 插件 / 创意工坊 → 导入插件**，选择下载的 `.spmod` 并启用；按提示授予下方
   「权限」里列出的三项权限（漏授也可以在插件权限页补授后重启 SPW）。
3. 插件管理器提示时重启 SPW。
4. 播放歌曲，打开迷你播放器的 **更多**（…）菜单 → **Folia**。

<p align="center"><img src="docs/images/menu-folia.png" width="240" alt="SPW「更多」菜单里的 Folia 条目"></p>

**在播放页里**：右上角 ⚙ 或 **F1** 打开 / 关闭设置；**ESC** 先关设置、再关窗口。设置保存在
SPW 的插件数据目录中。

**要让歌词悬浮在桌面上**：全屏页右下角圆钮面板 → 打开「播放页透明背景」；需要边放歌词边操作
电脑时再打开「鼠标穿透」。**Ctrl+Alt+B** 恢复不透明，两个开关也能绑到自己的键位（见功能介绍）。

## 兼容性

**要求**：Windows 10/11 x64 · **Salt Player for Windows 1.19.0 及以上**（1.19.0、1.19.2、1.19.3
上均确认可用）· WebView2 Runtime（Windows 11 内置，Windows 10 需安装 “Microsoft Edge WebView2
Runtime”）· .NET Framework 4.8（Windows 10 1903 起内置）。完整依赖矩阵与闪退排查见
[docs/runtime-requirements.md](docs/runtime-requirements.md)。

**权限**：

| 权限 | 用途 | 未授予时 |
| --- | --- | --- |
| `class-transform` | 在「更多」菜单里插入 Folia 条目 | 菜单里没有 Folia |
| `library-read` | 读取当前歌曲的封面与歌词 | 没有可显示的歌词 / 取色 |
| `key-bindings` | 登记呼出与透明开关的快捷键 | 其余功能正常，只是没有快捷键 |

### 已知限制

- **没有「智能动感」的节拍特效** —— 节拍检测跑在 Folia 桌面端的主进程里，插件所用的是它的
  浏览器端渲染部分，拿不到节拍事件。因此依赖节拍的效果（随拍推镜、涟漪、时计的鼓面、花火的
  随拍开花等）不会触发，样式本身的动画不受影响。设置页已移除所有不会生效的控件，保留项清单
  见 [docs/known-inert-settings.md](docs/known-inert-settings.md)。
- **仅支持 Windows** —— 辅助进程依赖 WebView2 与 Windows 音频接口。
- **透明是色键抠图，不是 alpha 通道** —— 透到的是桌面或其它窗口，不适合作为 OBS 的透明源
  （OBS 场景建议直接用 Folia 的浏览器源或窗口捕获）。莫奈样式与浅色主题下的绘光含有无法抠除的
  大面积图层，选中时会自动关闭透明背景。
- **窗口跟着 SPW 走** —— 全屏窗口开在 SPW 窗口所在的那块屏幕上，可用 **Alt + 左键**拖到其它
  屏幕并铺满该屏。
- **跟随 SPW 版本** —— 菜单 hook 的宿主类名在运行时解析：已知版本直接命中，未知版本扫描宿主
  jar 的结构后缓存，因此 SPW 改混淆名通常不需要等插件更新；但宿主若重构了弹层本身的结构，仍需
  重新适配。`1.19.0` 以下会明确拒绝注入并记日志（见 [docs/hook-target.md](docs/hook-target.md)）。
- 只读取播放状态与当前歌曲 / 歌词 / 封面，不写入音乐库。

## 版本

当前 **v0.4.6**。每个版本的安装包、SHA-256 校验值与更新说明都在
[GitHub Releases](https://github.com/azkbzxf/spw-folia/releases)。

## 从源码构建

工具链：JDK 25、Gradle 9.8（含 wrapper）、Kotlin 2.4.20、Node 24 + pnpm（设置 UI）、Windows 自带
`csc.exe`（.NET Framework 4.8，用于原生辅助进程）。无需 .NET SDK，无需 Android SDK。打包还需要
上游 Folia 0.7.22 的浏览器端产物位于 `poc/webview/dist/dist`。

```bat
:: 1) 插件（Kotlin，官方 SPW 创意工坊 Gradle 插件）
cd spw-folia
gradlew.bat plugin          :: -> build/libs/plugin-dev.spw.folia-0.4.6.spmod

:: 2) 原生辅助进程（C# + WebView2）
cd ..\poc\webview\host
bash build.sh               :: -> build/spw-folia-host.exe (+ WebView2 dlls)

:: 3) 设置 UI（React）
cd ..\..\settings-ui
pnpm install && pnpm build  :: -> dist/settings-ui.js

:: 4) 组装可分发 .spmod（插件 classes + 暂存 web bundle + 原生进程 + 许可证）
bash packaging/build-package.sh     :: 暂存 packaging/{web,native,licenses} + SHA256SUMS
python packaging/tools/assemble-release.py ^
    --spmod spw-folia/build/libs/plugin-dev.spw.folia-0.4.6.spmod ^
    --staging packaging --out dist/release --name spw-folia-0.4.6.spmod
```

完整的打包流水线、payload 清单、大小预算与发布检查表见 [docs/release.md](docs/release.md)。

## 文档

[架构](docs/architecture.md) · [通信协议](docs/protocol.md) · [原生宿主](docs/host-app.md) ·
[音频与时间轴](docs/audio-timeline.md) · [设置 UI](docs/settings-ui-impl.md) ·
[透明窗口机制](docs/live-transparency.md) · [Folia 复刻规格](docs/folia-spec/) ·
[打包发布](docs/release.md) · [运行环境与排障](docs/runtime-requirements.md) ·
[日志与诊断](docs/logging-and-diagnostics.md) · [许可](docs/licensing.md)

## 项目地址与反馈

- [GitHub 仓库](https://github.com/azkbzxf/spw-folia) —— 源码、文档、[Releases](https://github.com/azkbzxf/spw-folia/releases)
  与 [Issues](https://github.com/azkbzxf/spw-folia/issues)。
- [宣传站](https://azkbzxf.github.io/spw-folia/) —— 滚动演示、样式大图与 48 秒实拍巡览。
- 交流群：**1075038382**。
- 反馈问题时请附上 SPW 版本、插件版本与复现步骤。

## 致谢

- [Folia](https://github.com/chthollyphile/folia-major)，作者 chthollyphile（AGPL-3.0）——整个
  可视化器、设置 UI 与 web bundle 都来自 Folia 的工作（v0.7.22）。
- [Salt Player for Windows](https://saltplayer.com/) 创意工坊插件 API，作者 Moriafly。
- [spw-island（Dynamic Lyrics Island for SPW）](https://github.com/gaboron/spw-island) ——
  仅作为行为参考（GPL-3.0）；未复制任何代码。
- Microsoft Edge WebView2 SDK、.NET Framework、Kotlin/Compose、React/Vite。

## 许可

AGPL-3.0-or-later。与 Folia、Salt Player 均无隶属关系；本仓库包含 Folia 的衍生作品，分发时希望
它有用，但不提供任何担保。见 [LICENSE](LICENSE)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
以及 [docs/licensing.md](docs/licensing.md) 中的源码提供说明。
