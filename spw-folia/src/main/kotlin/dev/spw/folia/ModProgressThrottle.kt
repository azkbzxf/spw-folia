package dev.spw.folia

/**
 * issue #23（第二轮）：把「一次安装」的进度节流成最多 5 Hz、且只在百分比真的变了时发。
 *
 * ## 为什么需要它（三条都是硬约束，不是优化）
 *
 * 1. **通道会被饿死。** `FoliaHostBridge.sendLine` 的队列有界（256 行），满了丢**最旧**的一条 ——
 *    而最旧的那些正是 100 ms 的 `state` 时钟（播放页的时间基准）。逐字节发进度会先把时钟挤掉，
 *    症状是歌词/进度条一顿一顿，而且**没有人会把它和进度条联系起来**。
 * 2. **视觉分辨率就是 1%。** 同一个百分比重复发只会让 React 白重渲染。
 * 3. **`phase` 变化必须立刻发。** 否则「校验中」要等一个节流窗口才出现，用户会以为卡住了。
 *
 * ## 为什么是独立类而不是 `FoliaPlugin` 的 inner class
 *
 * 它有三条分支（新阶段 / 百分比变了 / 被节流）和一条收尾例外，靠点真机验证这三条分支等于没验证
 * —— 真机一次安装只走一遍，而「被节流」那条分支恰恰是**看不见**的。所以时钟与出口都从外面注入：
 * JVM 测试用假时钟走遍每条分支，生产代码注入 `System::currentTimeMillis` 与两个宿主桥。
 *
 * `total < 0` 表示分母未知（分块传输 / 解包），原样透传给页面 —— 页面据此画不定长条，**绝不**
 * 把它折成 0% 或 100%。
 */
internal class ModProgressThrottle(
    private val actionId: String?,
    private val modId: String?,
    private val now: () -> Long = System::currentTimeMillis,
    /** 出口：生产里是「给两个宿主桥各发一条」，测试里是一个收集器。 */
    private val sink: (phase: String, done: Long, total: Long) -> Unit,
) {

    private var lastPhase = ""
    private var lastPercent = -1
    private var lastAtMs = 0L

    /** 实际发出去的条数（测试用；生产里没人读）。 */
    internal var emitted = 0
        private set

    fun emit(phase: String, done: Long, total: Long) {
        val at = now()
        /* 百分比只在分母已知时才算。分母未知（`total < 0`，分块传输 / 解包）时**不能**用 -1 当
         * 「没变」的判据 —— 那样第一次之后每一拍都是 -1，进度就永远停住，不定长条看着像卡死。
         * 所以未知分母走**时间闸**：200 ms 一拍，页面据此让不定长条持续动。 */
        val percent = if (total > 0L) ((done.coerceAtMost(total) * 100L) / total).toInt() else null
        val phaseChanged = phase != lastPhase
        val isFinal = phase == FINAL_PHASE
        if (!phaseChanged) {
            // 已知分母：百分比没动就没什么可画；动过了也还要过时间闸。
            if (percent != null && percent == lastPercent && !isFinal) return
            if (at - lastAtMs < MIN_INTERVAL_MS && !isFinal) return
        }
        lastPhase = phase
        // 未知分母时不更新 lastPercent：它只表示「上一拍的百分比」，没有百分比就没有上一拍。
        if (percent != null) lastPercent = percent
        lastAtMs = at
        emitted += 1
        sink(phase, done, total)
    }

    internal companion object {
        /** 200 ms = 5 Hz。上界是通道约束（见类注释第 1 条），不是视觉偏好。 */
        internal const val MIN_INTERVAL_MS = 200L

        /** 一次安装的终点标记：成功与失败都会发，页面据此收掉进度条。它**不受节流**。 */
        internal const val FINAL_PHASE = "done"
    }
}
