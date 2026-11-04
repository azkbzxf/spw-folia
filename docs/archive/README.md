# Archive — 历史记录

这个目录是**历史，不是文档**。这里的内容不描述项目现在长什么样、怎么用、怎么维护；
当前文档在上一层的 [`docs/`](../)。

如果你要找的是：怎么用插件 → 看 [README](../../README.md)；某个版本改了什么 →
版本更新说明是 [`docs/release-notes-v0.4.17.md`](../release-notes-v0.4.17.md) 这类文件，外加
[GitHub Releases](https://github.com/azkbzxf/spw-folia/releases) 页面上的下载与 `SHA256SUMS.txt`；
怎么打包发布 → 看 [`docs/release.md`](../release.md)。

## 这里保留了什么

| 内容 | 为什么保留 |
| --- | --- |
| `release-notes-v0.1.0.md` … `release-notes-v0.3.0.md`（14 篇） | 早期版本的更新说明。用户仍可能在旧帖、旧 Release 正文里遇到指向它们的链接；内容本身是对应用户可见的版本描述（v0.1.5 与 v0.1.11 从未单独发布，所以没有对应文件） |
| `verification-v0.2.0.md` | 透明背景兼容性判定与宿主健壮性修复的**实测方法**。`poc/settings-ui/src/model/transparencyCompat.ts` 里的抽样方法仍指向它 |
| `verification-v0.4.2.md` | v0.4.2/v0.4.3 那次「先证伪再下结论」的对照实验记录（逐像素梯度能量），是 `docs/release-notes-v0.4.3.md` 引用的一手证据 |
| `verification-live-preview-ui.md` | 设置页大预览接入真实渲染器的验收方法，`poc/settings-ui/scripts/diag-preview-health.mjs` 仍引用 |
| `verify-frame-rate-v0.4.9.mjs` | 一次性脚本，但 `docs/release-notes-v0.4.10.md` 与 `docs/upstream-sync.md` 把它当作「为什么 dpr=1 不是 bug」的对照实验可复现件 |
| `webview-spike.md` | WebView2 vs JCEF 的技术选型记录。**四份随包/源码文件引用它**：`packaging/licenses-src/NOTICE.md`、`poc/webview/README.md`、`poc/webview/host/Program.cs` |

## 这里删掉了什么

2026-11 的文档整理中删掉了以下内容——它们记录的是「它一步步怎样开发出来」，而不是
「现在是什么」：一次性的验收矩阵（`acceptance*.md`）、发布候选快照（`release-candidate.md`）、
早期里程碑复盘（`hook-poc.md`、`re-host.md`、`plugin-integration.md`）、以及 v0.1.x/v0.2.x 的逐版本
验证报告（`verification-v0.1.*`、`verification-v0.2.[12].md`、`verification-v0.3.0.md`、
`verification-live-preview.md`）。

它们记载的事实如果有持续价值，已经在当前文档里重新表述过：

- 宿主逆向与 hook 机制 → [`docs/hook-target.md`](../hook-target.md)
- 进程/协议/窗口/注入的现行契约 → [`docs/host-app.md`](../host-app.md) 与 [`docs/protocol.md`](../protocol.md)
- 鼠标穿透、透明窗口 → [`docs/live-transparency.md`](../live-transparency.md)
- 早期崩溃与修复的教训（还会再犯的） → [`docs/postmortem-v0.4.13.md`](../postmortem-v0.4.13.md)
  与 [`docs/lessons.md`](../lessons.md)
- 每个版本改了什么 → GitHub Releases 与 Git 历史

## 约定

这里的文件是**冻结**的：保持原始措辞，不改写以追代码变化。需要更新的是上一层的 `docs/`。
删掉文件后一定要跑 `python packaging/tools/check-doc-links.py`——本目录的交叉引用很容易留死链。
