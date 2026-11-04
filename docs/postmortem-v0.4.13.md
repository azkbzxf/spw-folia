# v0.4.13 事故复盘 —— 一个「重试一次」把宿主卡死九分钟

这是一次**真实事故**的记录，保留它是因为它有持续的维护价值：它标出了门禁的盲区、
几条容易重犯的错，以及"什么样的验收等于没验收"。

> 状态：已解决。v0.4.14 已在同一台机器、同一条件下复验通过。
> v0.4.13 的 Release 与 tag 均已删除，**不要重新上架**；用 v0.4.14 及之后的版本。
> 原始取证：`dist/release/taken-down/v0.4.13-handoff/`

## 一、发生了什么

v0.4.13 要修的是"三个配置开关全部不生效"，这个目的达到了。但同一版本里额外加的
"配置读取失败重试"逻辑是个**无限递归**，在真实环境下把 SPW 的界面线程卡死，被宿主的安全模式
判定为 `TERMINATED_HANG` 并强制结束进程。

触发条件是**全新安装、还没进过配置页**的默认状态：`config.json` 和 `diagnostics.json` 两个文件都
不存在。这不是异常场景，是每个新用户的起点。

## 二、根因

### 2.1 那八行

```kotlin
if (retriedAfterEmpty.compareAndSet(false, true)) {
    log("config sync ($reason): no config file readable; retrying once")
    Thread.sleep(EMPTY_RETRY_DELAY_MS)
    retriedAfterEmpty.set(false)          // ← 复位发生在递归调用之前
    sync(reason = "$reason/retry")        // ← 递归
} else {
    log("config sync ($reason): no config file readable")
}
```

`set(false)` 的本意是"复位，让下次真正需要时还能重试一次"，但它被放在**递归调用之前**，
于是每次递归进入时标志都是 `false`，`compareAndSet` 每次都能成功——**防重入标志自己解除了自己**，
"只重试一次"变成了"永远重试"。

### 2.2 为什么 `@Synchronized` 没拦住

`sync()` 带 `@Synchronized`，看起来"有锁就安全"。但 **JVM 的监视器对同一线程可重入**，所以递归
一路畅通。这是本次事故最容易被误判的一点：只看"有没有加锁"会得出"不会递归"的错误结论。

### 2.3 实测后果

| 指标 | 实测值 |
| --- | --- |
| 递归次数 | 1450 次 |
| 持续时长 | 559.6 秒（约 9.3 分钟） |
| 平均间隔 | 386 ms |
| 期间界面真实进展 | 0 |
| 宿主判定 | `failure.kind=TERMINATED_HANG` / `safeMode=true` |

日志特征极其明显——`reason` 字符串越滚越长：
`config sync (start)` → `(start/retry)` → `(start/retry/retry)` → …×1400+。

## 三、为什么验收没发现（真正的问题）

`verify-all.mjs` 当时是 **10/10 全绿**才发布的。不是脚本写错了，是更糟的情况：
**验收从来没执行过这条分支。**

1. 验收环境里 `config.json` 一直存在，代码永远走不到"读不到文件"那个 `if`。
2. 门禁里**没有任何用例会去构造"文件缺失"**，所有 suite 都拿格式完好的
   `packaging/testdata/default-settings.json` 喂宿主。
3. 更根本：**门禁从来不运行插件的 Kotlin 代码**。它只做两件事——对源码做文本正则检查，
   以及驱动打包好的 WebView2 页面。而递归在 `FoliaConfigSync` 里，是 Kotlin 运行时行为。

那 10/10 里的"10"是 **7 个静态文本检查 + 3 个浏览器 suite**，和这次崩溃的代码路径没有交集。

### 3.1 顺带查出的门禁自身缺陷

复盘时审计出的、让"全绿"更不可信的问题：

| 问题 | 后果 |
| --- | --- |
| `verify-json-singleline` / `verify-playback-switches` / `verify-live-settings-payload` 三个脚本**从未接入门禁** | 发布说明写着"已补齐三个回归脚本，10/10"，而这三个恰好是唯一测行协议的用例，一个都没跑 |
| `verify-diagnostics.mjs` 的断言是 `unknowns.length === 0 \|\| fails.length >= 0` | 第二个操作数对任何数组恒为真 → 这条唯一声称校验四态契约的断言**永远不会失败** |
| `verify-live-settings-payload.mjs` 硬编码开发者本机安装路径 | 换台机器或没装过插件就 `ENOENT` 崩溃 |
| `verify-playback-bar-switch.mjs` 的超时回调 `finish(0)` | 宿主卡死被记成**成功** |

## 四、修复（v0.4.14）

### 4.1 用循环替代递归，上限是编译期常量

```kotlin
var attempt = 0
while (true) {
    playerText = readConfigText(configFileOf(m, PLAYER_CONFIG))
    diagnosticsText = readConfigText(configFileOf(m, DIAGNOSTICS_CONFIG))
    if (playerText != null || diagnosticsText != null) break

    // 只有"文件存在但读出来是空的"才值得重试（宿主先截断再写入的窗口）。
    // 文件根本不存在 = 全新安装，重试不可能成功。
    val caughtMidWrite = (playerFile?.isFile == true) || (diagnosticsFile?.isFile == true)
    if (!caughtMidWrite || attempt >= EMPTY_RETRY_COUNT) break

    attempt++
    if (!sleepQuietly(EMPTY_RETRY_DELAY_MS)) return
}
```

三条硬约束（已经写进门禁的静态守卫）：

1. **`sync()` 内部绝不允许再调用 `sync()`**；
2. 重试次数是 `const val EMPTY_RETRY_COUNT = 2`，**不是**可复位的标志；
3. `ThreadLocal` 深度计数 `MAX_SYNC_DEPTH = 3` 作为兜底，未来的意外重入只写一行 ERROR。

### 4.2 顺手修掉的同类缺陷

审计中在别处确认并修复的问题（都附了回归测试）：

| 缺陷 | 为什么危险 |
| --- | --- |
| `isOs64` 读不到位数时返回 `false`，下游把 `!is64` 判成 FAIL"当前不是 64 位系统" | **在健康机器上制造假的失败**，和 v0.4.6 的历史 bug 完全同类。改为三态，读不到 → UNKNOWN |
| `runReg()` 先 `readText()` 再 `waitFor(3s)` | `readText()` 阻塞到 EOF，**3 秒超时永远不可能触发**；`reg.exe` 被杀软卡住时界面死锁。改为守护线程读管道 + 带超时等待 |
| `Json.stringField()` 遇到非法 `\u` 转义既不消费也不报错 | 返回"看似合理的垃圾"，而该函数正是协议分发器 → **坏行可能被派发给错误处理器**。改为返回 null |
| `FoliaSettingsStore` 把 `save()` 返回 `false` 也记成"已保存" | 值其实没落盘，而去抖器从此拒绝重试 → **静默丢设置** |

### 4.3 门禁的补强

- 新增 **4 条卡死守卫**（静态）：`sync` 机制永不自我递归、重试上限必须是常量、必须有深度兜底、
  **不允许存在孤立 verify 脚本**；
- 新增 **JVM 单测**这一项门禁，并带 `--rerun-tasks`。这一点很关键：第一版没加 `--rerun-tasks`，
  Gradle 判定 UP-TO-DATE 后不输出任何用例行，门禁报告"0 passed / 0 failed"却判 PASS——**又一个空通过**。
  现在"一个用例都没跑"本身就是 FAIL；
- 把 3 个孤立脚本接入门禁；修正恒真断言；`verify-live-settings-payload` 改为优先读本机安装、
  读不到则回退到仓库内样本（**hermetic**）；
- 门禁项从 10 项变成 18 项（当前已到 24 项）。

### 4.4 新增 JVM 单测

其中 9 个直接针对本次崩溃，走真实的 `FoliaConfigSync` 实例 + 临时目录：两个文件都缺失 → 迅速返回、
不递归、不 sleep；文件存在但为空 → 重试有界；缺失告警只写一次；值保持默认且插件仍可用；
文件正常时值仍被正确读取（没有为了修卡死把功能修死）；被截断的 JSON 不抛异常；
resolver 抛异常时降级；`stop()` 未 `start()` 也可安全调用。

**并且验证了这些测试真能抓到原 bug**：把 v0.4.13 的递归逻辑临时改回去后，测试立刻以
`StackOverflowError` 失败（4 个用例红）；门禁同样验证过——重放旧形态时 4 条守卫里有 2 条直接 FAIL。
**一个不会失败的测试等于没有测试。**

## 五、真机复验

复验时机器状态与崩溃时一致：两个配置文件都不存在（`bytes=-1`）。

| | v0.4.13（崩溃） | v0.4.14（修复后） |
| --- | --- | --- |
| 「读不到配置」日志 | 1450 行，reason 越滚越长 | 1 行 `no config file yet; using defaults` |
| 递归 | 有 | 无（`retrying once` 计数 = 0） |
| 日志总量 | 854 KB 且持续增长 | 7,370 B，不再增长 |
| 启动后续 | 卡死 | 快捷键 / 托盘 / hook / 扩展全部正常初始化 |
| 宿主判定 | `TERMINATED_HANG`，`safeMode=true` | 无 `failure.kind`，`safeMode=false` |

## 六、可以带走的几条

1. **失败路径必须有测试。** 这次只测了 happy path。凡是"文件不存在 / 读不到 / 写失败 / 权限拒绝"
   的分支，都必须有一个能执行到它的用例，否则等于没写。
2. **有锁不等于防重入。** `@Synchronized`、`synchronized(this)` 对同一线程可重入。
   防重入要用"深度计数 + 硬上限"，或者干脆不写递归。
3. **可复位标志不能当循环上限。** "重试一次"的语义必须由常量表达。
4. **门禁要执行真正的代码，并且要证明自己跑过。** 只做文本检查的门禁对运行时缺陷是盲的；
   "0 个用例通过"必须算 FAIL，不能算 PASS。
5. **测试不能依赖环境里恰好存在的东西。** v0.4.13 的验收依赖 `config.json` 恰好存在，
   `live-settings-payload` 依赖开发者恰好装过插件——同一个错误。
6. **已公开又撤下的版本号不要复用。** 0.4.13 已对外可见，修复版走 0.4.14。
7. **发布前备份资产。** 已删除的 Release 资产无法通过 API 找回——这次能复盘是因为下架前已把证据
   打包进 `dist/release/taken-down/`。

这些规则的日常形态写在 [`lessons.md`](lessons.md) §7；门禁的命令与当前基线见
[`release.md`](release.md) §5 与 [`logging-and-diagnostics.md`](logging-and-diagnostics.md) §4。
