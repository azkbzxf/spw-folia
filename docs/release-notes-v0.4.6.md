# spw-folia v0.4.6 — 结构发现：不再跟着 SPW 的混淆名发版

v0.4.6 是**适配机制**改造，功能与 v0.4.5 完全一致（更多菜单里的 Folia 项、播放控制、托盘菜单、
主题取色、透明层都不变）。变的是**插件怎么找到宿主的那几个类**：从「人工反编译提取混淆名、
写进 `HostTargets.PROFILES`、发插件版本」改成「解析宿主自己的字节码，按结构约束唯一发现目标」。

一句话：**宿主下次 R8 改名不再需要发插件版本。**

## 问题

SPW 每次发版都会重新跑 R8，把「更多」弹层相关的三个 Compose 类整个改名：

| 版本 | 菜单 facade | MenuFlyoutScope | PopupState |
| --- | --- | --- | --- |
| 1.19.0 | `ē` (U+0113) | `ন` (U+09A8) | `Ⴈ` (U+10A8) |
| 1.19.2 | `घ` (U+0918) | `Ը` (U+0538) | `ะ` (U+0E30) |
| 1.19.3 | `ɦ` (U+0266) | `त` (U+0924) | `ל` (U+05DC) |

v0.3.1 起混淆名已经从代码里挪进数据（`PROFILES` 表 + `host-targets.json` 缓存 + 一条「按形状
扫描」的兜底路径），所以**用户**不用每个版本都换插件。但**维护者**的负担没变：每次 SPW 发版，
仍然要人工解包 `ffmpeg-x64.dll` → vineflower 反编译 → 从 42,147 个 class 里认出那三个 →
抄码点 → 加 profile → 构建发版。v0.4.5 就是这么救回来的（1.19.3 改了三个类名，菜单项直接消失）。

这条路径还有两个结构性问题：

1. **它是猜名字，不是查结构。** profile 对不对，只靠「拿反射试一下签名」，试不过就整条失效。
2. **兜底的扫描路径太弱。** 它只按「6 个参数、其中 4 个未被混淆的类型」认方法，遇到改名的
   `MenuFlyoutScope` / `PopupState` 还得再靠「找带默认参数 bridge 的接口」二次拆解；v0.4.5 那个
   潜伏 bug（内部名/二进制名混用）也是这条路径的产物。

## 方案

参考 **SPW-Lyrics**（<https://github.com/GaBoron/SPW-Lyrics>，`integration/hostui/`
的 `HostBytecodeIndex.java` + `HostPlayerMenuDiscovery.java`，及其 `docs/开发说明.md`
「主窗口 Hook 与动态发现」一节）：**不读混淆名，读字节码结构**。

新增两个文件（均在 `spw-folia/src/main/kotlin/dev/spw/folia/`）：

| 文件 | 职责 |
| --- | --- |
| `HostBytecodeIndex.kt` | 用 JDK 25 的 `java.lang.classfile` API 解析宿主 jar，建立「方法体 → 调用点 / 字段访问」的调用图。只读字节，**从不加载或初始化宿主类**。 |
| `HostMenuDiscovery.kt` | 在索引上跑发现链，输出 6 个必需角色 + 2 个可选角色，全部是点分二进制名。 |

`HostTargets` 的解析链变成四层（详见 [`docs/hook-target.md`](hook-target.md)「结构发现」一节）：

| # | 层 | 何时 | 成本 |
| --- | --- | --- | --- |
| 1 | `host-targets.json` 缓存 | 同一版本第二次起 | ~0 |
| 2 | 内置 profile（1.19.3 / 1.19.2 / 1.19.0） | 已知版本 —— **回归基准 + 零成本快路径** | 实测 53–57 ms |
| 3 | **结构发现**（主路径） | 未知版本 —— 后台线程 | 索引约 1.3–1.5 s，每版本一次，结果缓存 |
| 4 | 旧版 classpath `scan()` | 结构发现失败时的第二意见 | ~0.5–2 s |

每一层的结果都过同一道**反射校验**（`validateMenu` / `validatePalette`：方法签名、scope bridge、
调色板 getter）。结构发现的结果还会跟「仍然能校验通过的 profile」**逐字段比对**，一致就记
`host structural matches regression baseline …`，不一致记 `WARNING: structural discovery
disagrees with …` 并把两边的名字与参数下标都打出来 —— 不静默取平均。

发现链每一步只写结构约束（`PlaybackController#releaseAudioEngine` 的调用者、`BlurPopupMenu` 的
参数形状、自指的 Kotlin 默认参数 bridge、builder 的参数锚点……），完整 10 步表格在
[`docs/hook-target.md`](hook-target.md)。

### 为什么要收紧 SPW-Lyrics 的 builder 规则

SPW-Lyrics 原版的 builder 规则（static + 返回 `kotlin.Unit` + 参数里没有 `Composer` + 方法体调用了
item bridge）**在 1.19.3 上有 15 个候选**，对 SPW 自己的菜单结构约束太弱，照抄不可用。

v0.4.6 在同样四条之外，还要求参数表里**同时**出现六个锚点：`Track`、`PiscesMediaItem`、
`Navigator`、`androidx.compose.runtime.State`，加上两个由前面步骤推导出来的
`L<scope>;` 与 `popupStateType`。加完后 1.19.3 上**唯一命中**。

### 纪律：候选必须唯一

每一步都是 `unique(...)`：候选数 != 1 就抛 `IllegalStateException`（消息带角色名 + 候选数量），
**绝不 best-effort 挑一个**。理由是不对称：在宿主里调错方法会静默污染弹层，而抛错只是「这一版
没有 Folia 项 + 一条可读日志」。异常被捕获、记日志、退回第 4 层 `scan()`，**不会**让插件启动失败。
可选角色（`label` / 调色板）走另一条纪律：失败降级为 `null`（菜单项有常量颜色兜底）。

## 验证

**本轮是离线验证：真实宿主 dll + 编译后代码 + 双路径交叉校验 + 缓存往返。未做真机端到端**
（没有把 `.spmod` 装进真实 SPW 里实际打开菜单确认 Folia 项出现）—— 这一项留给发布前的人工验收。

### 1. 索引规模与耗时（真实 1.19.3 宿主 `app/ffmpeg-x64.dll`）

宿主包是伪装成 dll 的 zip，**111 MB、42147 个 class**。预筛只解析引用了 Compose runtime 的类：

| 指标 | 实测 |
| --- | --- |
| 索引到的方法体 | **28058**（约 2.8 万） |
| 索引耗时 | **1313 ms**（多次运行区间约 **1.3–1.5 s**） |
| 发现本身（索引建好之后） | 约 70–92 ms |
| 已知版本走 profile（对照） | 53–57 ms |

### 2. 双路径交叉校验：8/8 完全一致

清掉缓存与内存态后分别跑两条路径，逐字段比对：

| 字段 | profile 路径（`quickLoad`） | 结构发现路径（`deepResolve`） |
| --- | --- | --- |
| `menuClass` | `androidx.compose.ui.ɦ` | 相同 |
| `addItemsMethod` | `Ϳ` | 相同 |
| `scopeClass` | `androidx.compose.ui.त` | 相同 |
| `scopeBridge` | `Ϳ` | 相同 |
| `popupStateClass` | `androidx.compose.ui.ל` | 相同 |
| `popupDismiss` | `ԩ` | 相同 |
| `scopeParameter` | 5 | 5 |
| `popupParameter` | 2 | 2 |

码点断言 6/6 PASS：U+0266 / U+037F / U+0924 / U+037F / U+05DC / U+0529。
结构发现（1384 ms）与 profile（53–57 ms）解出的目标**逐字符一致**，这就是「结构发现没有退化」的
回归判据。

### 3. 真实日志

```
host structural index: com.xuncorp.pisces.PiscesMediaItem: 28058 method bodies (1313ms)
host structural matches regression baseline profile:1.19.3
host menu structural: androidx.compose.ui.ɦ.Ϳ(Track, PiscesMediaItem, ל, Navigator, State, त) scope=androidx.compose.ui.त.Ϳ (1313ms, 28058 bodies)
host palette structural: androidx.compose.ui.ʹ.Ԩ() via androidx.compose.ui.ʰ.Ԩ
```

未知版本匹配不到 profile 时，`start()` 打的是
`host build <ver> matched no known profile; indexing the host bytecode in the background`。

### 4. 缓存往返

`host-targets.json`（1597 bytes）写入后 `reset()` 再读，`origin` 正确保留为 `structural`，
`structural` 块带 `indexMs` / `bodies` / 每角色 `candidateCounts`（本轮 11 个角色全部 = 1）/
9 行 `diagnostics`。

### 5. 构建

- `./gradlew compileKotlin` 通过；`./gradlew plugin` 通过
- 产物 `spw-folia/build/libs/plugin-dev.spw.folia-0.4.6.spmod`
  sha256 `136821fbe4b41f13e172d1b91420346886a28da6ffc662d9b63961ac13d3ce8a`
- Manifest：`Plugin-Version: 0.4.6`、`Plugin-Permissions: class-transform,library-read,key-bindings`
- 产物内含 `HostBytecodeIndex*` / `HostMenuDiscovery*`，**未**打包 kotlin/androidx

## 顺带修掉的两个问题

这两个都是「结构发现要跑在后台线程」这个新时序带出来的：

1. **调色板反射的时序 bug（`FoliaMenuItem.kt`）。** 原先是两个 `by lazy`：未知版本上
   `HostTargets.palette` 要等后台发现跑完才有值，而弹层可能在启动后几毫秒内就被打开 —— lazy 第一
   次看到 `null` 就把 `null` 永久缓存了，于是**即使 palette 之后解析成功，菜单项仍然一直是硬编码
   的深色兜底色**（浅色弹层上不可见）。改成按 `HostTargets.palette` 实例失效的缓存：每个解析出的
   目标只反射一次，目标晚到或换版本都能跟上。
2. **hook 取参不再写死下标（`FoliaPlugin.kt`）。** 原先 `args[5]`（scope）/ `args[2]`（popupState）。
   现在读 `MenuTarget.scopeParameter` / `.popupParameter`（1.19.x profile 仍是 5/2，结构发现从
   builder 参数表推导），并且用前先做界内检查 —— 参数表被重排时记
   `after: argument indices out of range …`，而不是把错误的参数喂给注入逻辑。

## 兼容性

- **1.19.0 / 1.19.2 / 1.19.3 行为不变**：三个 profile 全部保留，`quickLoad` 仍走 profile（实测
  53–57 ms），只是它们的角色从「适配手段」变成「回归基准 + 首启动加速」。
- **版本门槛不变**：`HostTargets.Version.MIN_SUPPORTED` 仍是 1.19.0，低于它照旧拒绝注入并记日志。
- 播放控制反射、托盘菜单、主题取色、透明层**均未改动**。
- 协议、设置格式、web bundle、native helper **均未改动** —— 可直接覆盖升级 v0.4.5。
- `host-targets.json` 格式**向后兼容**：旧缓存（没有 `structural` / `paletteTarget` 块）仍能读；
  新缓存多出的字段只有诊断用途。调色板用 `paletteTarget` 这个键而不是 `palette`，是因为项目自带的
  `Json.rawField` 不做层级区分、只取首个文本匹配，而 `structural.candidateCounts` 里也有一个
  `palette` 键（候选计数），同名会读出数字而不是对象。

## 升级说明

1. 关闭 Salt Player for Windows。
2. mod 管理器里删除旧版 `spw-folia`，导入 `spw-folia-0.4.6.spmod`。
3. 授予 `class-transform` 与 `library-read`。
4. 重启 SPW，`更多 → Folia`。

可直接覆盖升级 v0.4.5。首次在**未知**宿主版本上启用时，后台会花约 1.3–1.5 s 建索引 —— 期间宿主
UI 不受影响（后台线程），结果写入 `host-targets.json`，之后每次启动零成本。已知版本（1.19.x）
完全没有这个等待。

## 已知限制

- **结构发现能适应重命名，不能适应页面结构重构。** 宿主若不再用 `BlurPopupMenu` 这类弹层
  （发现链第 2 步的形状变了），或者「更多」弹层不再从 `Track` / `PiscesMediaItem` 取数
  （builder 的锚点没了），结构约束就会失效：候选不唯一或为零 → 抛错 → 退回旧扫描 → 仍失败则记
  `could not locate the 更多 flyout`，Folia 项缺失，**其余功能不受影响**。这种情况需要重新适配，
  不是自动就能活的（SPW-Lyrics 的 `docs/常见问题.md` 也承认同一条边界）。
- 首次在未知版本上启用会有一次约 1.3–1.5 s 的后台索引（见上）。
- 其余限制与 v0.4.5 相同：色键透明（`rgb(255,0,255)`）、仅主屏全屏、`monet` 与浅色主题下的
  `lumiere` 在透明下不可用、WebView2 进程偶发退出暂无自动重试。
