# spw-folia v0.4.5 — 适配 Salt Player 1.19.3：更多菜单里的 Folia 选项回来了

v0.4.5 是一次**宿主版本适配**修复。SPW 更新到 **1.19.3** 后，迷你播放器「更多」弹层里注入的
**Folia** 选项消失了（其余功能正常）。根因是宿主 R8 混淆又一次重命名了我们 hook 的那三个类，
以及一个从 v0.3.1 就潜伏在「按形状扫描」路径里的 bug 被这次重命名暴露出来。

## 根因

SPW 每次发版都会重新混淆 `PlayerMoreMenuFlyoutKt` 及其相关的两个 Compose 类。历史映射：

| 版本 | 菜单 facade | MenuFlyoutScope | PopupState |
| --- | --- | --- | --- |
| 1.19.0 | `ē` (U+0113) | `ন` (U+09A8) | `Ⴈ` (U+10A8) |
| 1.19.2 | `घ` (U+0918) | `Ը` (U+0538) | `ะ` (U+0E30) |
| **1.19.3** | **`ɦ` (U+0266)** | **`त` (U+0924)** | **`ל` (U+05DC)** |

插件本应在未知版本上走「结构扫描」兜底路径，但那条路径有一个潜伏 bug：

`menuCandidates()` 把 `ParsedClass.name`（`this_class` 的**内部形式**，用 `/` 分隔，
如 `androidx/compose/ui/ɦ`）直接塞进了 `MenuTarget.menuClass`，而所有下游消费者
（`validateMenu()` 的 `Class.forName()`、hook 注册、缓存文件）都期望**点分隔的二进制名**。
于是 `Class.forName()` 抛 `ClassNotFoundException`，扫描日志永远报
`host scan found no flyout helper`。

之前每个版本都有内置 profile，这条扫描路径从没被真正走到过，bug 一直没暴露；1.19.3 把三个类
全改名了，才让它现形——日志里能同时看到「扫描找到了候选」和「找不到 flyout」这种自相矛盾的输出：

```
host scan: 1 classpath entr(y/ies) [...], matching by shape
host scan found no flyout helper (1206ms) (classes=42147 parsed=788 menuHits=1 paletteHits=3)
WARNING: could not locate the 更多 flyout in 1.19.3; the Folia menu item will be missing
```

注意 `menuHits=1`：扫描其实**找到了**，只是验证阶段失败。

## 修复

1. **新增 1.19.3 profile**（`HostTargets.PROFILES`，放在最前）：`ɦ` / `ל` / `त`，helper 与
   scope bridge 仍是 `Ϳ`，dismiss 仍是 `ԩ`（U+0529）。
2. **修掉扫描路径的名字格式 bug**：`menuClass = cls.name.replace('/', '.')`。这修的不只是
   1.19.3——未来任何未知宿主版本现在都能真正靠扫描兜底，不再需要跟着发插件版本。

## 验证

- 用真实 1.19.3 宿主 `app/ffmpeg-x64.dll`（42147 个 class 的多语言 zip）跑编译后的
  `HostTargets`：`quickLoad` 命中 `profile:1.19.3`，`deepResolve` 扫描路径也独立解析出**完全相同**
  的目标（`origin=scan`），两条路径交叉一致。
- 缓存文件 `host-targets.json` 往返读写正常。
- 装进真实 Steam 版 SPW 后重启，日志：

```
host menu profile:1.19.3: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त)
hookMethod installed: ... (profile:1.19.3)
Folia item appended (scope=androidx.compose.ui.গ$Ϳ, bridge=Ϳ)
```

用户已在本机确认「更多」菜单里的 Folia 选项恢复。

## 兼容性

- 1.19.0 / 1.19.2 的 profile 保留，行为不变。
- 播放控制反射、托盘菜单、主题取色、透明层在 1.19.3 上均**未受影响**（`PlaybackQueueState`
  字段顺序与 `com.xuncorp.spc.core.queue.Ϳ` 跨两个版本都没变）。
