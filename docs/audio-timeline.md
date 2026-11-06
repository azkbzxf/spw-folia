# 音频分析与播放时间线

> 插件 v0.4.19 / 上游 Folia 0.7.26。本文是音频链路与播放时钟的**实现契约**：原生分析器的公共 API 与文件集、
> 频谱算法与标定口径、Kotlin 时间线的锚点模型、与 SPW `PlaybackExtensionPoint` 的接线。
>
> 字段级协议见 [`docs/protocol.md`](protocol.md) §5（宿主 ↔ 页面）与 §1（插件 → 宿主 `state`）——本文不重复
> 协议，只解释实现与集成。

---

## 1. 职责划分与数据流

```
SPW（Kotlin 插件）
  ├─ FoliaPlaybackExtension → TimelineController（§5）：1 Hz onPositionUpdated → 60 FPS 平滑 currentTime
  │     └─ 每 100 ms 向宿主 stdin 写 {"t":"state", posMs, durationMs, playing, rate, tsMs}
  │        （protocol §1；页面按 tsMs + (now-tsMs)*rate 二次插值）
  └─ spawn → spw-folia-host.exe（C#，WinForms + WebView2）
        ├─ LoopbackAnalyzer（§2，进程内）：WASAPI loopback → FFT → AudioFrame
        │     └─ 宿主 15 ms tick 拉取最新帧 → postMessage
        │        {"type":"audio", power,bass,lowMid,mid,vocal,treble,spectrum:[1024]}
        │        无信号/暂停 → breath 写入 power 与五带，spectrum=[]
        └─ WebView2 页面（Folia dist + Shim）：把 audio 事件喂给 Folia 视觉器
```

**为什么音频分析在原生进程里做**：页面（WebView2 里的 Folia dist）不播放音频——声音来自系统播放器，页面没有
`HTMLMediaElement` 可接 `AnalyserNode`，所以必须在宿主 exe 里用 WASAPI loopback 采集，再由 JS 侧构造
`Uint8Array(1024)` 等价频谱。在 C# 里一次 FFT 远低于帧预算且能直接读 mix format，放宿主进程还能让插件保持
**零原生依赖**。页面只消费结果：`audioPower` / `audioBands.{bass,lowMid,mid,vocal,treble,spectrum}`，尺度
**0..255 float**（页面自己 `/255`），与 Folia 的 Web Audio 生产路径一致
（[`runtime-contracts.md`](folia-spec/runtime-contracts.md) §7）。

**为什么插件仍需要 `PlaybackTimeline`**：Workshop API 只给 1 Hz `onPositionUpdated`，而 Folia 的歌词/动效以
60 FPS 消费时间，直接用 1 Hz 会阶梯卡顿。时间线在插件侧插值 → 100 ms 节奏喂给宿主 → 页面侧再插值一次。
插件侧精度是页面观感的上限。

---

## 2. 原生分析器（C#，WASAPI loopback）

### 2.1 文件集与编译

目录 `poc/audio/native/`，命名空间 `SpwFolia.Audio`，C# 5 语法（in-box csc 4.0.30319 / .NET Framework 4.8），
**无外部包**（未使用 NAudio，COM interop 手写）。

| 文件 | 作用 | 进宿主 exe |
|---|---|---|
| `AudioInterop.cs` | WASAPI COM 声明（IMMDeviceEnumerator / IAudioClient / IAudioCaptureClient / IAudioClock）；`WasapiLoopbackCapture`（默认渲染端点、`AUDCLNT_STREAMFLAGS_LOOPBACK`、轮询 `GetNextPacketSize`）；`CaptureFormat.FromMixFormat` | ✅ |
| `SpectrumAnalyzer.cs` | 2048 点 Hann FFT、1024 个 AnalyserNode 等价字节、五带与 gamma、节拍检测、自检 | ✅ |
| `FoliaAudioMapper.cs` | `Shape()` / `Breath()` / `PausedPayload()`（页面契约的 gamma 与呼吸） | ✅ |
| `LoopbackAnalyzer.cs` | 采集线程、帧调度、静音帧、设备切换/恢复、节拍队列、`ISpectrumSink`、统计 | ✅ |
| `SharedAudioRing.cs` | 可选 file-backed MMF 环形缓冲（v2 布局，JVM 可读） | ✅（默认不启用） |
| `Program.cs` | 独立测量 harness（JSONL/CSV/stats/selftest/describe），**有 Main，不进宿主** | ❌ |

```bash
cd poc/audio/native && ./build.sh     # 产出 spw-folia-spectrum.exe（等价：build.bat）
```

宿主 exe 的编译集 = `AudioInterop + SpectrumAnalyzer + FoliaAudioMapper + SharedAudioRing + LoopbackAnalyzer`
（**不含 `Program.cs`**）；要求 C# 5、无 Main、无 WPF/UI 依赖。它支持 float32/int16/int24/int32 与
WAVEFORMATEXTENSIBLE 的 mix format。

> **两处副本必须同步**：宿主实际编译的是 `poc/webview/host/audio/*.cs`（`poc/webview/host/build.sh` 显式列这五个
> 文件），它由 `poc/audio/native/` 拷过去。当前两份并不完全一致：宿主副本的节拍检测仍是 120 ms 不应期且没有
> 上升沿判据（`poc/audio/native` 已改成 180 ms + `BeatRiseMin`）。改算法时两处一起改，否则改的是不发货的那份。

### 2.2 公共 API

```csharp
public sealed class AudioFrame {
    public long Seq, TsEpochMs, SamplePos;  public double TsMonoMs;  public int SampleRate;
    public byte[] Spectrum;                 // 1024 个 0..255 字节；静音/暂停帧为空数组
    public float RawBass, RawLowMid, RawMid, RawVocal, RawTreble;  // bin 区间算术平均（未 gamma）
    public float Power, Bass, LowMid, Mid, Vocal, Treble;          // 已 gamma，0..255 float
    public float Rms, AgcGain;              // Rms 0..1（已乘 AGC）；AgcGain 1.0 = 关闭
    public bool  Silent;                    // true ⇒ Spectrum.Length == 0
    public bool  Beat, BeatDownbeat;  public float BeatStrength, LatencyMs;
    public static AudioFrame SilentFrame();
    public float[] GetShapedBands();        // [bass, lowMid, mid, vocal, treble]
}

public struct BeatEvent { public long Seq, TsEpochMs; public double TsMonoMs;
                          public float Strength; public bool IsDownbeat; public double IbiMs; }

public interface ISpectrumSink { void OnAudioFrame(AudioFrame frame); void OnBeat(BeatEvent beat); }

public sealed class LoopbackOptions {
    public int  TargetFps = 60;  public int PollIntervalMs = 3;  public int DeviceRole = 0;  // eConsole
    public long BufferDurationHns = 10_000_000L;                  // 1 s
    public bool EnableSmoothing = true;  public bool EnableAgc = false;  public bool EmitSilentFrames = true;
    public string SharedMemoryPath = null;                        // 非空 → 同时写 MMF 环（§2.6）
    public bool FollowDefaultDevice = true;  public double SilenceTimeoutSec = 0.25;
}

public sealed class LoopbackAnalyzer : IDisposable {
    public LoopbackAnalyzer(LoopbackOptions options);
    public LoopbackAnalyzer(LoopbackOptions options, ISpectrumSink sink);
    public event Action<AudioFrame> FrameReady;   public event Action<BeatEvent> BeatReady;
    public event Action<Exception> CaptureError;
    public void Start();   // COM/WASAPI 全在专用 MTA 采集线程创建，可从 WinForms STA UI 线程调用
    public void Stop();    // 幂等；未 Start 时安全返回
    public bool TryGetLatest(out AudioFrame frame);   // 拉模式：最近一帧（无则 false）
    public bool TryDequeueBeat(out BeatEvent beat);   // 有界 256
    public LoopbackStatistics Stats { get; }  public bool IsRunning { get; }
    public int SampleRate { get; }  public int FftSize { get; }   // 2048
    public static string DescribeDefaultDevice(int role);
}
```

**生命周期契约**：`Start()` 无默认渲染端点 / 未被授权时抛 `InvalidOperationException("loopback capture start
failed: …")`，5 s 内没起来抛 `TimeoutException`；宿主捕获后进入呼吸降级（§7）。`Stop()`/`Dispose()` 之后再
`Start()` 同一实例未定义——宿主只建一个实例，关窗 `Stop()`。

### 2.3 频谱与帧契约（对应 [`docs/protocol.md`](protocol.md) §5）

- `Spectrum[1024]`：与 WebAudio `AnalyserNode.getByteFrequencyData` 等价的 0..255 字节。
  **`binHz = sampleRate / FftSize = sampleRate / 2048`**（48 kHz 时 23.4375 Hz）。FFT 点数对所有采样率固定
  2048（WebAudio 语义），所以 **44100 与 48000 的 binHz 不同，绝不能写死 21.5 Hz 之类的常数**，否则五带整体偏移。
- 五带 = 指定区间的 **bin 算术平均**（不是 RMS、不是 log band）：
  `bass 20–150`、`lowMid 150–400`、`mid 400–1200`、`vocal 1000–3500`、`treble 3500–12000`（Hz）。
  **vocal 与 mid 在 1000–1200 有意重叠**，与 Folia 桥一致。
- `Power/Bass/LowMid/Mid/Vocal/Treble` 是**已 gamma** 的形状值，`Spectrum` 与 `Raw*` 保持 raw（不 gamma）。
  gamma 公式与各带指数见 §3。
- 无信号 / 暂停：**不要发 0**。帧侧 `Silent=true` + `Spectrum=[]`；宿主发
  `breath = (sin(now/2000)+1)*20`（0..40）写入 `power` 与五个带、`spectrum=[]`，`paused` 由播放状态单独表达。
  页面据此「呼吸」而不是归零。
- 节拍：原生只发**事件**（`BeatEvent{ts,strength,isDownbeat}` + 帧上的 `Beat/BeatDownbeat`），不做包络。

### 2.4 采集线程与降级

- `Start()` 创建专用线程 `spw-folia-audio-capture`（MTA，AboveNormal）：打开默认渲染端点 → `GetMixFormat`
  → `Initialize(SHARED, LOOPBACK, 1 s)` → `GetService(IAudioCaptureClient)` → `Start()`。
  **不要在 UI 线程建 COM 对象**（跨 apartment 会挂）——内部已规避。
- 每次轮询 drain 全部 packet（`GetNextPacketSize` 循环），单声道混音（各声道平均；float32/int16/int24/int32/int8），
  滚动缓冲 ≥ 65536 样本。
- 帧调度用**绝对 deadline**（`Stopwatch` + `timeBeginPeriod(1)`），每 `1000/TargetFps` ms 发一帧；
  `SilenceTimeoutSec` 内没有新数据就发静音帧（连续 >0.5 s 静音会 `Reset()` 分析器状态）。
- 默认设备每 2 s 检查一次 device id，变化则重开（最多 3 次重试，间隔 500 ms）；WASAPI 异常走 `CaptureError`
  + 恢复路径，`Stats.ReopenCount` 记录。

### 2.5 harness（`Program.cs`）与可选的 MMF 环

```bash
spw-folia-spectrum.exe --selftest                        # 44.1k+48k 全自检；exit 2 = 失败
spw-folia-spectrum.exe --describe                        # 默认设备/格式
spw-folia-spectrum.exe --seconds 8 --perf --stats-json    # 只统计不序列化（测 CPU）
spw-folia-spectrum.exe --seconds 12 --json --stats-json > capture.jsonl
spw-folia-spectrum.exe --shm measure/audio.shm --seconds 2
spw-folia-spectrum.exe --read-shm measure/audio.shm       # 读环（调试）
```

帧 JSON 走 stdout（一行一帧，含 `spec:[1024]`），节拍另起一行 `{"ev":"beat",…}`；统计 JSON 走 stderr
（`--stats-json`：fps / CPU / 延迟分位 / `qpcLeadMeanMs` / `sr` / `fft` / `bins` / `reopens` 等）。`--perf` 跳过
每帧序列化——测 CPU 时用它，否则序列化本身会额外吃 1–2% 单核。其它开关：`--fps N`、`--frames N`、`--csv`、
`--no-silent`、`--no-agc`、`--no-smoothing`、`--role console|multimedia`。

`SharedAudioRing`（v2）**只在** `--shm` / `LoopbackOptions.SharedMemoryPath` 非空时启用，宿主默认路径不写环：

- 布局：`magic="SPWF"(0x46575053)`、`version=2`、header 64 B、slot 1536 B × 256（slot 内含 seq/ts/pos/specLen/
  raw + shaped bands/rms/agc/beatStrength/latency/flags/spectrum bytes）。
- 写入顺序：先写 slot 内容 → 发布 `slot.seq` → 发布 `header.writeSeq`；读者按 `writeSeq` 追帧，跳过被覆盖或
  撕裂的 slot。默认路径在系统临时目录下；JVM 读端 = `poc/audio/src/spwfolia/audio/SharedAudioRing.kt` 的
  `SpectrumReader`。

---

## 3. 频谱标定（与 WebAudio AnalyserNode 对齐）

**字节映射**。WebAudio 默认 `minDecibels=-100`、`maxDecibels=-30`，`getByteFrequencyData` 等价于：

```
byte = clamp( (20*log10(mag) + 100) / 70 * 255 , 0, 255 )
```

- magnitude 侧：2048 点 Hann 窗；正弦满幅（bin 中心）→ magnitude 1.0；`amp[k] = 2*gain*|X_k| / sum(hann)`。
- `smoothingTimeConstant = 0.6`：对**线性 magnitude** 做 `mag = 0.6*prev + 0.4*cur`，再转 dB
  （不是对 dB 或字节做平滑）。
- 等价标定断言（`--selftest` 逐项验证）：幅度 0.001 → byte 146；0.003 → 180；0.01 → 219；
  单音相差 10.5 dB → 字节差 `10.5/70*255 = 38.25`。

**gamma**。`shape(v,boost) = (v/255)^boost * 255` 是**页面契约**，原生只做同样计算（`FoliaAudioMapper.Shape`）：
`power = shape((bass+lowMid)/2, 3)`、`bass^1.8`、`lowMid^2`、`mid^2`、`vocal^1.5`、`treble^2`，输出 0..255 float
（页面自己再 `/255`）。自检校验点：`shape(100,1.8)=47.29`、`shape(150,1.8)=98.12`、`shape(40,3)=0.98`、
`shape(120,3)=26.57`。注意 `power` 自乘 3 次的是 `(bass+lowMid)/2` 这个**中间量**，不是 bass 字节本身——
按公式算，不要凭直觉估。

**节拍检测**。

- 能量源：**未平滑**的五带 bass 原始字节（0.6 平滑会拖尾，造成一踢两拍）。
- 判据：`rawBass` 上升沿、历史 43 帧（~0.7 s）均值 × 1.25 + 6 阈值、最小能量 8、历史均值 > 4、
  上升幅度 ≥ 12 字节、**180 ms 不应期**（宿主当前编译的旧副本是 120 ms 且无上升沿判据，见 §2.1）。
- `strength = (rawBass - 阈值) / (255 - 阈值)`，clamp 0..1，下限 0.05。
- 重拍（启发式）：IBI（EMA，250–2000 ms）稳定后每第 4 拍标 `isDownbeat`。

---

## 4. 延迟口径

- 上报 `LatencyMs` = **采集 → 发射服务延迟**：本帧发射时刻 − 最近一个数据包到达时刻（0–17 ms 量级），
  clamp 0..500。
- **不是** WASAPI 引擎延迟，也**不是**「画面 vs 声音」的端到端延迟。已知 loopback packet 的 QPC 结束时间比
  本机 `HighResClock` 提前若干毫秒（数量随端点而异，`Stats.QpcLeadMeanMs/Min/Max` 已暴露），这是引擎预渲染
  （音频先写入渲染缓冲再被设备播放），意味着分析帧会**领先**人耳听到的声音约该量。
- **不做补偿**：Folia 视觉器对这种小提前量不敏感，而把 QPC 差从时间线里减掉会引入错误。若将来需要严格
  音画同步，建议把该 lead 作为可配置 offset 单独下发（页面侧使用），**不要改 `LatencyMs` 语义**。

---

## 5. Kotlin 播放时间线（`PlaybackTimeline.kt`）

### 5.1 文件与集成

- 单文件 `poc/audio/kotlin/dev/spw/folia/PlaybackTimeline.kt`（package `dev.spw.folia`，纯 JDK/Kotlin stdlib，
  无协程依赖）。插件里有同内容副本 `spw-folia/src/main/kotlin/dev/spw/folia/PlaybackTimeline.kt`（两份当前
  `diff` 为空，改动要同时落两处）。
- 无 Gradle 也可构建：`poc/audio/build-kotlin.sh` 用 Gradle 缓存里的 `kotlin-compiler-embeddable` 编译，
  `./run-tests.sh` 跑全部测试。

### 5.2 API

```kotlin
package dev.spw.folia

enum class PlaybackState { IDLE, BUFFERING, READY, ENDED }   // 播放/暂停由 playing 表达，不在此枚举
enum class TimeSource { INTERPOLATED, ANCHORED }
data class TimelineSnapshot(positionMs, durationMs, playing, buffering, ended, rate, seekPending, source)

class PlaybackTimeline(clockNanos: () -> Long = System::nanoTime, config: Config = Config()) {
    class Config(
        defaultRate = 1.0, seekAckWindowMs = 2_500, seekToleranceMs = 1_500.0,
        maxExtrapolationMs = 2_500.0, hardDriftMs = 800.0, softDriftMs = 120.0, softCorrectionGain = 0.25,
        rateLearning = true, minRate = 0.25, maxRate = 4.0, rateSmoothing = 0.3,
        rateMinSpanMs = 300, rateMaxSpanMs = 5_000, rateNoOpBand = 0.005, residualHistory = 128)

    fun onPositionUpdated(positionMs: Long)   // 1 Hz 权威位置
    fun onIsPlayingChanged(playing: Boolean)  // 播放/暂停
    fun onStateChanged(state: PlaybackState)  // 缓冲/结束/重置
    fun onSeekTo(positionMs: Long)            // 乐观锚定 + ack 窗口
    fun onPlaybackRateChanged(rate: Double)   // 显式变速
    fun onTrackChanged(durationMs: Long, startPositionMs: Long = 0)

    fun currentTimeMs(): Double               // 任意时刻调用，synchronized
    fun snapshot(): TimelineSnapshot; fun stats(): Stats; fun reset()
}

interface WorkshopPlaybackCallbacks { /* 与上面六个输入一一对应 */ }

class TimelineController(timeline: PlaybackTimeline = PlaybackTimeline(),
                         hostClock: (() -> Long?)? = null) : WorkshopPlaybackCallbacks {
    fun positionMs(): Double                  // 发 state 前调用（实时值，O(1)）
    fun snapshot(); fun stats(); fun timeline()
}
```

### 5.3 算法

- **锚点 + 外推**：每次 `onPositionUpdated(p)` 记 `(anchorPos=p, anchorNanos=now)`；
  `currentTime = anchorPos + clamp(now-anchor, 0, maxExtrapolationMs) * rate`。`maxExtrapolationMs=2500` 防止
  回调断更后无限外推；seek 未确认前外推值不超过 seek 目标。
- **暂停/缓冲/结束停住**：`!playing || buffering || ended` 时返回锚点值，`source=ANCHORED`；否则
  `INTERPOLATED`。
- **seek**：`onSeekTo(target)` 立即乐观锚定 target；`seekAckWindowMs=2500` 内，`|pos-target| ≤
  seekToleranceMs (1500)` 的更新算确认；与 seek 前位置相差 ≤ `hardDriftMs` 的是滞后旧包（记
  `staleUpdatesIgnored`，不让时间倒流）；既不是旧包也不在容差内 → 认为 seek 落到别处，直接接受；超时也接受。
- **漂移**：残差 = 权威位置 − 外推位置。`|r| ≤ softDriftMs(120)` 直接重锚（常态）；`120–800` 部分修正
  `predicted + r*0.25`（防跳变，记 `softCorrections`）；`> 800` 硬重锚（记 `hardSnaps`）。
- **变速**：`rateLearning` 用相邻两次位置更新算 `Δpos/Δwall`，只取跨度 300–5000 ms 且期间连续播放的样本，
  EMA `rate = rate*0.7 + observed*0.3`，夹 0.25–4.0，变化 <0.5% 视为无操作；显式 `onPlaybackRateChanged`
  立即生效并被后续学习缓慢拉回。
- **状态机**：`IDLE` 清 seek、`duration=0`、锚点归零；`BUFFERING` 停在当前时间；`READY` 恢复输出且
  `ended=false`；`ENDED` 锚到 `duration`（未知则保持当前）、`playing=false`。`onIsPlayingChanged(true)` 从当前
  位置恢复，若距结尾 >250 ms 就清掉 `ended`。`reset()` 回初始态（插件 reload / helper 重启）。
- **诊断**：`Stats` 记 `updates/seeks/seeksAcked/seeksTimedOut/hardSnaps/softCorrections/rateObservations/
  rateChanges/staleUpdatesIgnored/meanAbsResidualMs/p95/max/lastResidualMs/rate`。

### 5.4 与 SPW `PlaybackExtensionPoint` 的接线

插件侧实现见 `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlaybackExtension.kt`：

```kotlin
@Extension
class FoliaPlaybackExtension : PlaybackExtensionPoint {
    private val controller = TimelineController()          // 不传 hostClock = 纯插值

    override fun onPositionUpdated(position: Long) = controller.onPositionUpdated(position)
    override fun onIsPlayingChanged(isPlaying: Boolean) = controller.onIsPlayingChanged(isPlaying)
    override fun onSeekTo(position: Long) = controller.onSeekTo(position)
    override fun onStateChanged(state: State) = controller.onStateChanged(mapState(state))
    // State.Idle→IDLE, Buffering→BUFFERING, Ready→READY, Ended→ENDED
}
```

- **曲目时长**：`onBeforeLoadLyrics` / `onAfterLoadLyrics` 收到 `MediaItem` 时 `adoptMediaItem()`；换曲调
  `controller.onTrackChanged(item.duration, controller.positionMs())`，同一首只更新时长时调 `onDurationChanged()`。
- **喂给宿主**：`snapshot()` 组装 `PlaybackSnapshot(posMs, durationMs, playing, rate)`（`posMs` 取
  `controller.positionMs()` 实时值，`durationMs` 优先 `MediaItem.duration`），由 `FoliaHostBridge` 的 100 ms
  定时器（`STATE_PERIOD_MS = 100`）写成 `{"t":"state",…}`。
- **性能约定**：60 FPS 循环里只调 `positionMs()`（一次加锁计算），别在帧循环里做别的重活。发 state 用
  `positionMs()` 而不是 `snapshot().positionMs`（后者是上一次回调时的快照）。

---

## 6. HostPlaybackProbe（宿主真实位置反射探测，未接线）

- 文件 `poc/audio/src/spwfolia/probe/HostPlaybackProbe.kt`（+ `tests/spwfolia/probe/HostPlaybackProbeTest.kt`）。
  动机：Workshop API 的 1 Hz 是插件侧唯一权威时间源，但宿主进程内其实能反射读到 Pisces 播放器位置。
- 解析顺序（全程 try/catch，失败返回 null，绝不抛给插件）：`PlaybackController` 静态 `INSTANCE` → 其
  `PlaybackService` 字段 → 类层次上无参且返回 `PiscesPlayer` 的方法 → 在 player 上枚举 public 无参 `long/int`
  getter，用两次采样（间隔 120 ms）的**递增性** + 调用方 `hintPositionMs` 判定哪个是位置。失败每 2 s 重试，
  最多 10 次。
- `TimelineController.hostClock` 若传入该 source，`positionMs()` 会以 ≤10 Hz（`HOST_CLOCK_MIN_INTERVAL_NANOS
  = 100 ms`）把真实位置**当作一次普通位置更新**喂进时间线，走同一套漂移/软修正逻辑，不会硬跳。
- **现状：未接线**。插件不构造 `HostPlaybackProbe`、不传 `hostClock`，也没有对应配置开关；只有文件与单元
  测试在。启用前必须考虑 R8 改名（类/方法名随 SPW 版本变）、线程竞争、版本绑定——收益（插值已够用）不足以
  抵消这些风险，所以默认路径保持纯插值。

---

## 7. 已知限制

- **只抓 shared-mode 渲染流**：播放器若用 ASIO/独占模式（WASAPI exclusive），loopback 抓不到，表现为静音帧 →
  呼吸降级，不报错。SPW 默认 WASAPI/共享，正常。
- **抓的是系统全部声音**：其他应用的通知/音乐也会进频谱。同机若有别的进程在放音频，测量与观感都会被污染
  （最典型是低频 bins 被持续点亮）；排查音频问题前先确认只有目标音源在响。
- **启动失败降级**：`Start()` 抛异常（无设备 / 权限 / 未知 mix subformat）→ 宿主记 warn，此后每个 tick 一律发
  呼吸帧，窗口与视觉器照常工作。协议层把「音频不可用」当可接受状态。
- **节拍效果当前不生效**：分析器有节拍检测与 `TryDequeueBeat`，但宿主没有把 `beat` 消息发给页面、也没有注入
  `__SPW_FOLIA_BEAT__`，所以页面侧 `beatImpact/downbeatImpact` 恒 0（智能动感 / 推镜裂光 / 涟漪因此不动，见
  [`docs/known-inert-settings.md`](known-inert-settings.md)）。要接这条链路，缺的是宿主 tick 里的
  `TryDequeueBeat` → `{"type":"beat"}` 转发（[`docs/protocol.md`](protocol.md) §3.2 已留位）。
- **WASAPI 拾取的是 post-volume 信号**：页面里的 `AnalyserNode` 接的是页面自己的媒体输出（pre-volume），
  loopback 拿到的是**系统混音后**的信号（post-应用音量、post-音效增强）。用户调低音量时频谱整体下降、
  视觉器变暗；响度均衡/音效会改变绝对电平。**相对动态（节拍、带间比例）不受影响**，标定曲线仍线性。
  不做补偿（保持 AnalyserNode 等价标定是页面兼容的前提）；`EnableAgc=true` 能自适应但要破坏绝对标定，
  **仅调试用，默认关**。音量 >100% 或开响度增强时近满幅会被 255 截断（顶部 4 dB 丢失），影响很小。
- **时间线**：1 Hz 回调中断（SPW 卡顿/UI 线程忙）→ 外推上限 2500 ms，超过后停在 cap，观感是缓慢停住而非乱跳；
  换曲/seek 依赖 `onTrackChanged`/`onSeekTo` 及时送达，插件必须在 lyrics/MediaItem 变化时补 `duration`。
  `PlaybackTimeline` 公开方法全部 `synchronized`，`TimelineController` 用 `AtomicReference` 快照，60 Hz 读 +
  1 Hz 写无竞争问题。
- **资源**：帧缓冲固定（2048 float + 1024 byte ×2），无增长；节拍队列有界 256。
- **版权**：全部代码为本项目原创（手写 COM interop，未使用 NAudio）；`dynamic-lyrics-island-for-spw`（GPL-3.0）
  仅作行为参考，未复制代码；Folia/AnalyserNode 常数来自 Web Audio 规范。

---

## 8. 维护入口

| 路径 | 说明 |
|---|---|
| `poc/audio/native/*.cs` | 分析器源码（§2.1 逐文件说明），`build.sh` / `build.bat` 用 in-box csc 编译 |
| `poc/webview/host/audio/*.cs` | **宿主实际编译的五份副本**，改算法时与 `poc/audio/native/` 同步 |
| `poc/webview/host/AudioProvider.cs` | 宿主音频接缝：`LoopbackAudioProvider` / `SyntheticAudioProvider`（呼吸兜底）/ `StdinAudioProvider`（调试注入）+ `AudioRouter`（`audioMode`） |
| `poc/audio/kotlin/dev/spw/folia/PlaybackTimeline.kt` | 时间线单文件（`PlaybackTimeline` + `TimelineController` + 回调接口） |
| `spw-folia/src/main/kotlin/dev/spw/folia/PlaybackTimeline.kt` | 插件内的同一份（`diff` 应为空） |
| `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlaybackExtension.kt` | 与 SPW `PlaybackExtensionPoint` 的接线、曲目/封面/歌词回调 |
| `poc/audio/src/spwfolia/**` | Kotlin 侧镜像：`FoliaAudioState.kt`、`SharedAudioRing.kt`（`SpectrumReader`）、`probe/HostPlaybackProbe.kt`（未接线，§6） |
| `poc/audio/tests/**` | `PlaybackTimelineTest` / `SpectrumReaderTest` / `HostPlaybackProbeTest`（`main()` 断言式，`run-tests.sh` 驱动） |
| `poc/audio/build-kotlin.sh` / `run-tests.sh` | 无 Gradle 的 Kotlin 编译/测试脚本（编译器取自 Gradle 缓存） |
| `poc/audio/tools/*.py` | `gen_test_audio.py`（合成测试 WAV：单音/踢鼓/标定扫频）、`analyze_capture.py`（JSONL 分析：fps/延迟/频带/标定/BPM） |

```bash
cd poc/audio/native && ./build.sh && ./spw-folia-spectrum.exe --selftest    # 编译 + 自检

cd poc/audio && python tools/gen_test_audio.py measure                      # 合成测试音
pwsh -Command "$p=New-Object System.Media.SoundPlayer '<abs>\measure\tones48.wav'; $p.PlayLooping(); Start-Sleep 30; $p.Stop()"
cd native && ./spw-folia-spectrum.exe --seconds 8 --perf --stats-json       # CPU / 延迟
cd .. && python tools/analyze_capture.py measure/tones.capture.jsonl --label tones

cd poc/audio && ./build-kotlin.sh && ./run-tests.sh [measure/audio.shm]     # Kotlin 测试（可带 shm 端到端）
```

Windows GBK 控制台跑 Python 分析器时设 `PYTHONIOENCODING=utf-8`。
