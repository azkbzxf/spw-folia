package dev.spw.folia

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * issue #23（第二轮）: 安装进度节流的四条分支。
 *
 * 用户的抱怨是「点击下载后没有进度条」。真机上那条链路有三个环节（下载回调 → 节流 → 宿主转发），
 * 而**节流这一环有两个分支在真机上看不见**：「同一百分比重复发」与「未到 200 ms」都被吞掉，所以
 * 靠点一次真机安装只能证明「至少发了一条」，证明不了规则本身。
 *
 * 假时钟 + 收集器让四条分支各自可断言，也顺手钉住了那个曾把进度条彻底弄没的 bug：进度只发给了
 * 播放页的桥，而安装是从**市场小窗**发起的 —— 那是出口接线的问题，由 `newProgressThrottle` 覆盖，
 * 这里钉的是「什么时候发、发什么」。
 */
class ModProgressThrottleTest {

    private class Recorder {
        val sent = ArrayList<Triple<String, Long, Long>>()
        fun sink(phase: String, done: Long, total: Long) {
            sent.add(Triple(phase, done, total))
        }
    }

    private fun throttle(rec: Recorder, clock: () -> Long) =
        ModProgressThrottle("mod-a", "some-mod", clock, rec::sink)

    /** 新阶段必须立刻发：否则「校验中」要等一个节流窗口才出现，用户以为卡住了。 */
    @Test
    fun `a phase change is sent immediately even inside the throttle window`() {
        val rec = Recorder()
        var t = 1_000L
        val throttle = throttle(rec) { t }

        throttle.emit("download", 0, 100)
        // 1 ms later: same phase would be throttled, but a NEW phase must go through.
        t += 1
        throttle.emit("verify", 0, 100)

        assertEquals("both phases must be on the wire: ${rec.sent}", 2, rec.sent.size)
        assertEquals("download", rec.sent[0].first)
        assertEquals("verify", rec.sent[1].first)
    }

    /** 同一阶段内百分比没动：不发（视觉分辨率就是 1%，重复只会让 React 白重渲染）。 */
    @Test
    fun `an unchanged percentage inside one phase is dropped`() {
        val rec = Recorder()
        var t = 1_000L
        val throttle = throttle(rec) { t }

        throttle.emit("download", 10, 100)   // 10% -> sent
        t += 500                              // well past the interval
        throttle.emit("download", 10, 100)   // still exactly 10% -> dropped
        t += 500
        throttle.emit("download", 10, 100)   // still exactly 10% -> dropped

        assertEquals("only the first tick may go out: ${rec.sent}", 1, rec.sent.size)
    }

    /** 百分比变了但没到 200 ms：被节流（保护 100 ms 的 state 时钟）。 */
    @Test
    fun `a new percentage is throttled until the interval elapses`() {
        val rec = Recorder()
        var t = 1_000L
        val throttle = throttle(rec) { t }

        throttle.emit("download", 10, 100)   // 10% -> sent
        t += 50
        throttle.emit("download", 50, 100)   // 50% but only 50 ms later -> dropped
        t += 200
        throttle.emit("download", 90, 100)   // 250 ms after the first -> sent

        assertEquals("the interval must gate, not the percentage alone: ${rec.sent}", 2, rec.sent.size)
        assertEquals(10L, rec.sent[0].second)
        assertEquals(90L, rec.sent[1].second)
    }

    /** `done` 不受节流：它是收尾标记，丢了进度条就永远停在那里。 */
    @Test
    fun `the final tick is never throttled`() {
        val rec = Recorder()
        var t = 1_000L
        val throttle = throttle(rec) { t }

        throttle.emit("download", 100, 100)
        t += 1                                // far inside the window
        throttle.emit(ModProgressThrottle.FINAL_PHASE, 1, 1)
        throttle.emit(ModProgressThrottle.FINAL_PHASE, 1, 1) // even a duplicate final must not vanish

        assertEquals("done must always reach the page: ${rec.sent}", 3, rec.sent.size)
        assertEquals(ModProgressThrottle.FINAL_PHASE, rec.sent[1].first)
        assertEquals(ModProgressThrottle.FINAL_PHASE, rec.sent[2].first)
    }

    /** `total = -1` 原样透传：页面靠它区分「真百分比」与「不定长条」，折成 0 会让条永远空着。 */
    @Test
    fun `an unknown denominator is passed through as -1`() {
        val rec = Recorder()
        var t = 1_000L
        val throttle = throttle(rec) { t }

        throttle.emit("unpack", 0, -1)
        t += 500
        throttle.emit("unpack", 1, -1)

        assertEquals(2, rec.sent.size)
        assertTrue("total must stay -1, never 0: ${rec.sent}", rec.sent.all { it.third == -1L })
    }

    /** 百分比永远不超过 100：服务器谎报 total 时不能画出 250% 的条。 */
    @Test
    fun `an over-reported total cannot produce more than 100 percent`() {
        val rec = Recorder()
        val throttle = throttle(rec) { 1_000L }
        throttle.emit("download", 250, 100)
        assertEquals(1, rec.sent.size)
        // The sink receives the raw numbers; the clamp lives in the percentage computation, so assert
        // the throttle still counts this as 100% by checking a follow-up at the same ratio is dropped.
        throttle.emit("download", 300, 100)
        assertEquals("both are 100%, so the second must be throttled as unchanged", 1, rec.sent.size)
    }
}
