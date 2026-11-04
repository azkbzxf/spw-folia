# 许可证与第三方声明

面向维护者的许可义务说明。用户可读的组件清单在仓库根目录的
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)，本文讲**为什么这样定、义务在哪里落地、
换上游时改哪些文件**。

## 1. 本项目的许可证

仓库里的一切——Kotlin 插件、C# 宿主、设置岛源码、打包脚本、发布出去的 `.spmod`——都是
**AGPL-3.0-or-later**，全文见 [`LICENSE`](../LICENSE)。

原因是 Folia：本插件内嵌并复用了 Folia（AGPL-3.0）的生产构建产物，还复用了它的 React 组件与
翻译资源，所以整件作品是 Folia 的衍生作品。AGPL 要求衍生作品与组合分发同样按 AGPL 授权，
并向通过网络使用它的用户提供对应源码。

### 1.1 对应源码在哪

| 分发物 | 源码位置 | 构建方式 |
| --- | --- | --- |
| `classes/`（Kotlin 插件） | `spw-folia/` | `./gradlew plugin` |
| `native/spw-folia-host.exe` | `poc/webview/host/` | `bash poc/webview/host/build.sh`（in-box `csc.exe`） |
| `web/settings/`（设置岛） | `poc/settings-ui/` | `pnpm build`（Vite；从 Folia 源码树取组件） |
| `web/`（Folia 产物） | 上游 Folia + 本仓库的暂存脚本 | 见 §2 |
| 打包与装配 | `packaging/` | `build-package.sh` + `assemble-release.py`（见 [`release.md`](release.md)） |

上游 Folia 源码：<https://github.com/chthollyphile/folia-major>，版本 **0.7.25**（tag `v0.7.25`）。
我们没有修改 Folia 源码，因此 Folia 部分的对应源码就等于上游该 tag 加上我们的构建配方。

### 1.2 源码提供（SOURCE-OFFER）

包内 `licenses/SOURCE-OFFER.md` 是面向分发接收者的书面说明，必须随包发出，不得删改。
如果你分发的是二进制，而接收者从上述位置拿不到源码，你有义务提供对应源码（AGPL-3.0 §6 / §13）。

> **当前待修**：`packaging/licenses-src/NOTICE.md` 与 `SOURCE-OFFER.md` 仍写
> "folia-major 0.7.22 / commit `1f6d0f46…`"，而内嵌的已是 **0.7.25**。这是许可证文件里的事实错误，
> 下一次发版前必须把上游 tag/commit 改对，再跑 `bash packaging/build-package.sh` 同步 `packaging/licenses/`。
> 改真源（`packaging/licenses-src/`），不要直接改生成目录 `packaging/licenses/`。

## 2. `web/` 的来源与改动

`web/` 是 Folia 0.7.25 的**生产构建产物**（OBS 浏览器源入口），原样分发：

- **唯一改动**是 `index.html` 删除了 service-worker 注册标签与 manifest 链接——插件不分发
  service worker，留着会让旧的 SW 劫持 `/preview.html`。
- 该改动记录在 `licenses/NOTICE.md`，可由 `packaging/tools/stage-web.mjs` 复现。
- 其余文件（含 17 种样式的渲染器 chunk、`nebbia-strokes.json`、缩略图）与上游构建输出一致；
  打包期的图片瘦身是**同名同格式的重新压缩**（`packaging/image-overrides/`），不是内容改写。

雾笺的笔顺数据 `web/nebbia-strokes.json` 派生自 AnimCJK（Arphic Public License），
它的许可证全文与 APL §2(a) 要求的修改声明在 `web/licenses/nebbia-strokes/`。

## 3. 三类归属

维护许可证文件时最容易犯的错是把这三类混在一起：

| 类别 | 例子 | 怎么处理 |
| --- | --- | --- |
| ① 真正随包分发 / 依赖的第三方 | Folia、AnimCJK 数据、WebView2 SDK dll、设置岛里的 MIT 库 | 必须进 `THIRD_PARTY_NOTICES.md` 与包内 `licenses/THIRD-PARTY.md`，带版本、许可证、落点 |
| ② 只作行为参考、未复制代码 | spw-island（GPL-3.0） | 放致谢，写明"未复制源码、不随包分发"，**不写进第三方组件表** |
| ③ 本项目原创 | Kotlin 插件、C# 宿主、设置岛、WASAPI 环回分析 | **不列进第三方组件**；原创代码不需要为了强调"自主实现"而占第三方声明的位置 |

WASAPI 环回分析（`poc/audio/native/*.cs`）是 ③：自己写的、无第三方音频库，
源码文件带 `SPDX-License-Identifier: MIT`。它被编译进 AGPL 分发的宿主 exe，所以
**分发出去的二进制是 AGPL-3.0**；MIT 只描述该源码文件本身的许可，不是第三方组件。

spw-island 是 ②：v0.2.2 起鼠标穿透改为系统级 shaped input region，思路借鉴它的
`WindowsGpuInput.kt` / `WindowsOverlay.kt`，但实现是我们自己的 C#（对方是 Kotlin/JNA），
没有复制源码、也不分发它。

## 4. 改上游版本时要一起改的地方

换 Folia 版本（见 [`upstream-sync.md`](upstream-sync.md)）时，许可证相关有四处要同步：

1. `packaging/licenses-src/NOTICE.md` —— 上游 URL、tag、commit、样式数。
2. `packaging/licenses-src/SOURCE-OFFER.md` —— 同上，外加构建配方路径。
3. `packaging/licenses-src/THIRD-PARTY.md` —— 版本列与样式数说明。
4. 仓库根 `THIRD_PARTY_NOTICES.md` —— 版本列。

另外两处容易被忘：`docs/release.md` 的发布检查表要求核对版本；`work/folia/folia-major-main/LICENSE`
是 AGPL 正文的来源，`build-package.sh` 从那里拷进包内。

## 5. 其它边界

- **字体**：不随包分发任何字体文件。Folia 用系统字体栈；用户导入的字体包由用户自己负责许可。
- **模型权重**：Folia 的 `beat_this` / `htdemucs`（约 133 MB）属于 Folia 桌面应用的
  Electron 主进程资源，不在 web 产物里，**本插件不分发**。
- **凭据与隐私**：仓库与日志里没有 token / cookie。SPW 日志可能含用户路径，**不要把用户日志
  原样公开**。插件只读本地播放状态用于渲染，无遥测、无网络请求。

## 6. 发布前的许可检查

- [ ] `.spmod` 内有 `licenses/`（AGPL 正文 + 4 份声明 + WebView2 两份）与
      `web/licenses/nebbia-strokes/`（3 份 Arphic 文件）。
- [ ] `packaging/licenses-src/` 里的上游版本号与实际内嵌的 Folia 版本一致。
- [ ] `THIRD_PARTY_NOTICES.md` 的三类归属没有被混写（原创代码没被列成第三方）。
- [ ] README 中英都声明了 AGPL-3.0、非官方社区作品、与 Salt Player / Folia 作者无隶属关系。
- [ ] Release 附近发出了 `SHA256SUMS.txt`。
