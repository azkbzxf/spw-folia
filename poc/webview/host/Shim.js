// Shim.js — injected by spw-folia-host BEFORE any Folia page script. Implements protocol v1 §3.
//
// Folia's production OBS browser-source page (src/components/obs/ObsBrowserSourceApp.tsx) reads an
// SSE stream (/obs/events: config / clock / audio) and renders the real VisualizerRenderer. We
// replace EventSource with an in-memory implementation so the page can run with no HTTP server and
// no network: the host pushes JSON over window.chrome.webview instead.
//
// Responsibilities
//   1. FakeEventSource -> translates host messages into the exact SSE payloads the page expects.
//   2. window.__SPW_FOLIA__ bridge per docs/protocol.md §3.3 (settings / lyrics / track / state /
//      audio / config inputs, settings emit, pushConfig, requestClose).
//   3. Diagnostics: page errors, console errors, rAF FPS/heap, key events -> host.
(function () {
  'use strict';
  // Host Shim is injected into every frame by AddScriptToExecuteOnDocumentCreated. The settings
  // preview iframe has its own child shim (PreviewShim.js); never install the host bridge there.
  if (window.top !== window) return;
  if (window.__SPW_FOLIA_SHIM__) return;
  window.__SPW_FOLIA_SHIM__ = true;

  var PROTOCOL = 1;
  var listeners = {};

  // Purge any legacy Service Worker / Cache Storage left in the WebView2 profile by older builds.
  // Folia's original web bundle registered a PWA service worker for https://spw-folia.local/; a stale
  // registration can intercept the /preview.html navigation of the settings live-preview iframe and
  // answer with an old cached index.html (seen as "iframe loads but has no preview shim"). We run from
  // virtual-host files only, so no SW is ever needed: unregister + clear caches for this origin.
  try {
    if (window.navigator && navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        for (var i = 0; i < regs.length; i++) { try { regs[i].unregister(); } catch (e) { } }
      }).catch(function () { });
    }
    if (window.caches && caches.keys) {
      caches.keys().then(function (keys) {
        for (var i = 0; i < keys.length; i++) { try { caches.delete(keys[i]); } catch (e) { } }
      }).catch(function () { });
    }
  } catch (e) { }

  // ------------------------------------------------- v0.4.10: no frame-rate cap (cleanup only)
  //
  // The 配置 page used to offer a 帧率 list; v0.4.10 deleted it, because the visualizer should just
  // run at the display's refresh rate. Upstream Folia still owns a limiter
  // (src/utils/frameRateLimiter.ts): `installGlobalVisualizerFrameRateLimiter()` reads
  // `localStorage['visualizer_frame_rate']` at boot and, unless the value is 'off', replaces
  // `window.requestAnimationFrame` with a capped queue.
  //
  // Deleting our setting is therefore not enough: any value an older build wrote into that key
  // survives in the WebView2 profile and would keep throttling the page forever, invisibly. So this
  // script — which runs on every document creation, before any page script — actively removes the
  // key. `parseVisualizerFrameRate(null)` is 'off', which upstream turns into
  // `restoreGlobalVisualizerFrameRateLimiter()`, i.e. no cap.
  //
  // The removal is reported in the `ready` message (`frameRateCleared`) so a run can prove the
  // upgrade really lifted a stale cap, and `capped` in the per-second fps sample stays the ground
  // truth that the limiter is not installed (`window.__foliaNativeRequestAnimationFrame` absent).
  var FRAME_RATE_KEY = 'visualizer_frame_rate';
  var frameRateCleared = null;
  (function clearLegacyFrameRateCap() {
    try {
      var before = localStorage.getItem(FRAME_RATE_KEY);
      if (before === null) return;
      localStorage.removeItem(FRAME_RATE_KEY);
      // Only a would-be cap is worth reporting; 'off' left by an old build is a no-op.
      if (before !== 'off' && before !== '') frameRateCleared = before;
    } catch (e) {
      // Private-mode / quota failures must never break the page: an unreadable storage simply means
      // there was no cap to lift (the limiter reads the same storage and gets the same error).
    }
  })();

  var lastEvents = {};           // last SSE payload per event name
  var lastConfig = null;
  var lastClock = null;
  var lastFps = 0;
  var sources = [];
  var settings = {};
  var inputs = { state: null, lyrics: null, track: null, queue: null, audio: null, hello: null, beat: null, ui: null, envReport: null };
  var lastClockSentAt = 0;

  function post(msg) {
    try { window.chrome.webview.postMessage(msg); } catch (e) { }
  }

  function emitLocal(type, payload) {
    var list = listeners[type];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (e) { console.error('[spw-folia] listener error', type, (e && e.stack) ? e.stack : e); }
    }
  }

  // ------------------------------------------------- v0.4.8: Folia 原版开屏 (splash) 接管
  //
  // 上游 Folia 的 index.html 自带 `#app-splash`：深色 #09090b 底 + 居中 "F o l i a" 白色辉光词标
  // （逐字母随机跳字体/字重/斜体/缩放）+ 下方 13 根白色波形竖条（随机高度/宽度/透明度/辉光，
  // 1100ms 循环）。它由 src/utils/appSplash.ts 在 React 挂载后淡出。
  //
  // 但那个内联脚本开头还有一段移除逻辑：
  //   if (params.get('obs') === '1' || pathname === '/obs' || params.get('splash') === '0') { remove; return; }
  // 而宿主必须带 obs=1 导航（src/utils/appSurface.ts 用它选 OBS 根；去掉会挂成主应用窗口，带完整
  // 播放器 UI 与 Electron bridge 依赖，页面直接崩）。于是上游每次都在解析期就把开屏摘掉了 —— 这正是
  // “过渡动画看不到”的原因。splash=1 上游不认识（它只认 splash=0），光加参数救不回来。
  //
  // 这里不改 dist、也不动上游判断，走宿主自己的注入脚本：
  //   1. URL 带 splash=1 时，在**页面解析期**把一份与上游等价的遮罩装进 DOM（DOM / 内联样式 /
  //      波形随机化 / 词标字体轮盘全部照 index.html 搬过来）；
  //   2. 淡出时机交给宿主：HostForm.TickSplash() 在“首帧已画 + 最短可见时长”之后调用
  //      window.__spwHideSplash()，走上游同一条路径（加 is-hiding → 320ms ease → remove）。
  //
  // 元素 id 用 `spw-folia-splash` 而不是 `app-splash`：上游 AppSplashGate 在 React 挂载时会执行
  // hideAppSplash()（`document.getElementById('app-splash')` → 加 is-hiding → 320ms 后 remove），
  // 复用同一个 id 会让页面自己把宿主控制的遮罩提前摘掉，最短停留时长就失效了。类名沿用 app-splash-*，
  // 结构与上游一致；词标不再做字体轮盘（见 styleSplashTitle 的说明）。
  //
  // 没有 splash=1 时这里全是空操作，行为与改造前完全一致。
  var SPLASH_ID = 'spw-folia-splash';
  var SPLASH_FADE_MS = 320; // 与上游 #app-splash 的 transition: opacity 320ms ease 对齐
  var SPLASH_STYLE_ID = 'spw-folia-splash-style';

  // 上游 index.html <style> 的等价拷贝，选择器从 #app-splash 换成 #spw-folia-splash。
  // 词标与波形条的静态样式与上游一致；跳舞的字体轮盘没有搬过来（见 styleSplashTitle）。
  var SPLASH_CSS = [
    'html,body{background-color:#09090b}',
    '#spw-folia-splash{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
    'justify-content:center;background-color:#09090b;',
    "font-family:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;transition:opacity 320ms ease}",
    '#spw-folia-splash.is-hiding{opacity:0;pointer-events:none}',
    '#spw-folia-splash .app-splash-inner{display:flex;flex-direction:column;align-items:center;gap:28px;',
    'opacity:0;animation:spw-folia-splash-in 420ms ease 180ms forwards}',
    '#spw-folia-splash .app-splash-title{font-size:clamp(64px,17vw,200px);font-weight:600;line-height:1;',
    'letter-spacing:0.06em;text-indent:0.06em}',
    '#spw-folia-splash .app-splash-title span{display:inline-block;text-align:center;font-family:inherit;',
    'color:#ffffff;text-shadow:0 0 8px rgba(255,255,255,0.55),0 0 28px rgba(255,255,255,0.3);',
    'transform-origin:center 78%}',
    '#spw-folia-splash .app-splash-wave{display:flex;align-items:center;gap:clamp(6px,1.1vw,11px);',
    'height:clamp(42px,7.5vw,92px)}',
    '#spw-folia-splash .app-splash-wave span{width:var(--w,5px);height:100%;',
    'transform:scaleY(var(--floor,0.18));background-color:rgba(255,255,255,var(--alpha,0.85));',
    'box-shadow:0 0 var(--glow,14px) rgba(255,255,255,0.35);',
    'animation:spw-folia-splash-wave 1100ms ease-in-out infinite}',
    '#spw-folia-splash .app-splash-wave span:nth-child(even){animation-delay:-550ms}',
    '@keyframes spw-folia-splash-in{to{opacity:1}}',
    '@keyframes spw-folia-splash-wave{0%,100%{transform:scaleY(var(--floor,0.18))}',
    '50%{transform:scaleY(var(--peak,1))}}',
    '@media (prefers-reduced-motion:reduce){#spw-folia-splash .app-splash-inner{opacity:1;animation:none}',
    '#spw-folia-splash .app-splash-wave span{transform:scaleY(calc(var(--peak,0.5) * 0.7));opacity:0.5;',
    'animation:none}}'
  ].join('');

  // 与上游 index.html 的遮罩 DOM 逐节点相同（5 个字母 + 13 根波形条）。
  var SPLASH_HTML = '<div class="app-splash-inner">'
    + '<div class="app-splash-title" aria-label="Folia"><span>F</span><span>o</span><span>l</span>'
    + '<span>i</span><span>a</span></div>'
    + '<div class="app-splash-wave" aria-hidden="true">'
    + '<span></span><span></span><span></span><span></span><span></span><span></span><span></span>'
    + '<span></span><span></span><span></span><span></span><span></span><span></span>'
    + '</div></div>';

  var splash = {
    wanted: false,     // URL 带 splash=1 才接管
    installed: false,  // 已经装进 DOM
    hidden: false,     // 宿主已经让淡出（此后不再补）
    shownAtMs: 0,
    timers: [],
    attempts: 0
  };

  try {
    splash.wanted = new URLSearchParams(window.location.search).get('splash') === '1';
  } catch (e) {
    splash.wanted = false;
  }

  function splashEl() {
    try { return document.getElementById(SPLASH_ID); } catch (e) { return null; }
  }

  // 时序证据：遮罩出现 / 开始淡出 / 已移除各报一次，宿主把每条写成 `splash` 日志行，
  // 这样“开屏到底有没有出现过、什么时候走的”不用看画面也能从日志核对。
  function splashReport(state, extra) {
    var payload = {
      type: 'splash',
      state: state,
      atMs: Math.round(performance.now())
    };
    if (extra) payload.info = extra;
    post(payload);
  }

  function stopSplashTimers() {
    for (var i = 0; i < splash.timers.length; i++) {
      try { window.clearInterval(splash.timers[i]); } catch (e) { }
      try { window.clearTimeout(splash.timers[i]); } catch (e) { }
    }
    splash.timers = [];
  }

  // 波形逐条随机化（照搬上游 index.html 内联脚本：中间高两端低的包络 + 随机宽高/亮度/辉光/节奏）。
  function randomizeSplashWave(root) {
    try {
      var rand = function (min, max) { return min + Math.random() * (max - min); };
      var bars = root.querySelectorAll('.app-splash-wave span');
      for (var i = 0; i < bars.length; i += 1) {
        var bar = bars[i];
        var envelope = Math.sin(((i + 0.5) / bars.length) * Math.PI);
        var peak = Math.min(1, 0.32 + envelope * rand(0.38, 0.72));
        bar.style.setProperty('--peak', peak.toFixed(3));
        bar.style.setProperty('--floor', rand(0.08, 0.24).toFixed(3));
        bar.style.setProperty('--w', rand(3.5, 6.5).toFixed(2) + 'px');
        bar.style.setProperty('--alpha', rand(0.55, 1).toFixed(2));
        bar.style.setProperty('--glow', Math.round(rand(6, 26)) + 'px');
        bar.style.animationDuration = Math.round(rand(820, 1500)) + 'ms';
        bar.style.animationDelay = '-' + Math.round(rand(0, 1500)) + 'ms';
      }
    } catch (e) { /* CSS 里的默认值已经能跑出一条静态波形 */ }
  }

  // 词标排版：五个字母用同一套字体/字重/斜体，字形不再跳动。
  //
  // 上游 index.html 的版本每 380ms 挑一个字母随机换字体族（cursive / fantasy / monospace…）、
  // 字重（400/600/800）、斜体和缩放，本意是 Loki 片头那种“字体轮盘”。但它依赖目标机器上装了
  // 这些通用字族；实际机器上 cursive / fantasy 往往回退到同一张脸或字体不齐，五个字母于是
  // 大小、粗细、字形各自乱跳，词标看起来是“坏掉”而不是“设计”，和官方开屏那种干净统一的
  // 词标也差得远。这里只保留上游的“按最宽字形固定每个字母盒子宽度”这一步：宽度用 canvas 在
  // 统一字体下量一次，写死成 em，字号跟着 clamp(font-size) 缩放，排版稳定、字母间距均匀。
  function styleSplashTitle(root) {
    try {
      var letters = root.querySelectorAll('.app-splash-title span');
      if (!letters.length) return;
      var BASE_FONT = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";
      // 统一字重：与 #app-splash .app-splash-title 的 font-weight: 600 一致。
      var WEIGHT = '600';

      // 用 canvas 量出每个字母在同一字形下的宽度，换算成 em 写死盒子宽度。字体固定，所以这里
      // 量一次就够，不会出现“量的时候一种字体、画的时候另一种字体”的错位。
      var measure = document.createElement('canvas').getContext('2d');
      for (var i = 0; i < letters.length; i += 1) {
        var letter = letters[i];
        // 固定字形：父级已经有 font-family，这里只把字重和斜体钉死，避免任何继承来的差异。
        letter.style.fontFamily = BASE_FONT;
        letter.style.fontWeight = WEIGHT;
        letter.style.fontStyle = 'normal';
        letter.style.transform = 'none';
        // 辉光用 CSS 里的静态兜底值（#app-splash .app-splash-title span 的 text-shadow），
        // 逐字母随机辉光会让同一行字看起来亮度不齐，这里显式清掉随机值、留给样式表。
        letter.style.textShadow = '';

        if (measure) {
          var glyph = letter.textContent;
          measure.font = WEIGHT + ' 100px ' + BASE_FONT;
          var widest = measure.measureText(glyph).width;
          // 余量留给 letter-spacing 与亚像素抗锯齿，盒子略宽于字形，字母之间不会挤在一起。
          if (widest > 0) letter.style.width = ((widest / 100) * 1.08 + 0.04).toFixed(3) + 'em';
        }
      }
    } catch (e) { /* 排版失败就保持 CSS 默认的静态词标 */ }
  }

  function injectSplashStyles() {
    if (document.getElementById(SPLASH_STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = SPLASH_STYLE_ID;
    style.textContent = SPLASH_CSS;
    var host = document.head || document.documentElement;
    if (host) host.appendChild(style);
  }

  /**
   * 在解析期把遮罩装上去，越早越好：等到 DOMContentLoaded 才出现的话首帧已经是页面本体了。
   * document-created 阶段通常 documentElement 已经有、body 还没 —— #spw-folia-splash 是
   * position:fixed，挂在 documentElement 上照样铺满视口，所以两个都可以。
   */
  function installSplash() {
    if (!splash.wanted || splash.hidden || splash.installed) return splash.installed;
    var mount = document.body || document.documentElement;
    if (!mount) return false;
    try {
      injectSplashStyles();
      var node = document.createElement('div');
      node.id = SPLASH_ID;
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.setAttribute('aria-label', 'Loading Folia');
      node.innerHTML = SPLASH_HTML;
      mount.appendChild(node);
      randomizeSplashWave(node);
      styleSplashTitle(node);
      splash.installed = true;
      splash.shownAtMs = performance.now();
      splashReport('shown');
      return true;
    } catch (e) {
      return false;
    }
  }

  function bootSplash() {
    if (!splash.wanted || splash.hidden) return;
    if (installSplash()) return;
    // documentElement 都还没就绪（极少见）：每 2ms 再试，最多 ~400ms，然后放弃。
    var tries = 0;
    var retry = window.setInterval(function () {
      tries += 1;
      if (splash.hidden || installSplash() || tries >= 200) {
        window.clearInterval(retry);
      }
    }, 2);
    splash.timers.push(retry);
  }

  /**
   * 宿主按揭幕时机调用：加上游同一个 `is-hiding` 类（320ms ease 淡出），动画结束再摘掉节点。
   * 返回状态字符串，宿主把它写进日志（eval-result）。
   */
  window.__spwHideSplash = function () {
    var el = splashEl();
    splash.hidden = true;
    stopSplashTimers();
    if (!el) { splashReport('absent'); return 'absent'; }
    var info = splashInfo();
    el.classList.add('is-hiding');
    splashReport('hiding', info);
    window.setTimeout(function () {
      try { el.remove(); } catch (e) { }
      splashReport('removed');
    }, SPLASH_FADE_MS);
    return 'hiding';
  };

  /** 开屏当前的 DOM 状态：宿主 eval 命令与验收脚本直接读它做断言。 */
  function splashInfo() {
    var el = splashEl();
    var info = {
      wanted: splash.wanted,
      installed: splash.installed,
      hidden: splash.hidden,
      present: !!el,
      hiding: false,
      opacity: null,
      bars: 0,
      letters: 0,
      bodyBg: null,
      titleText: ''
    };
    if (!el) return info;
    info.hiding = String(el.className || '').indexOf('is-hiding') >= 0;
    info.bars = el.querySelectorAll('.app-splash-wave span').length;
    info.letters = el.querySelectorAll('.app-splash-title span').length;
    try { info.opacity = window.getComputedStyle(el).opacity; } catch (e) { }
    try { info.titleText = (el.querySelector('.app-splash-title') || {}).textContent || ''; } catch (e) { }
    try { info.bodyBg = window.getComputedStyle(document.body).backgroundColor; } catch (e) { }
    return info;
  }
  window.__spwSplashInfo = splashInfo;
  bootSplash();

  // Surface page errors / console errors to the host so integration failures are diagnosable.
  // Settings-overlay ownership (docs/protocol.md §7.5): the injected settings UI owns the panel and
  // exposes open/close/toggle/isOpen. The host only forwards commands through window.__SPW_FOLIA__.ui;
  // it never inspects or controls the panel itself.
  function settingsUi() { return window.__SPW_FOLIA_SETTINGS_UI__ || window.__SPW_FOLIA_UI__ || null; }
  function isSettingsOpen() {
    var ui = settingsUi();
    try { return !!(ui && typeof ui.isOpen === 'function' && ui.isOpen()); } catch (e) { return false; }
  }
  function callSettingsUi(method) {
    var ui = settingsUi();
    if (!ui || typeof ui[method] !== 'function') return false;
    try { ui[method](); return true; } catch (e) { console.error('[spw-folia] settings ' + method, e); return false; }
  }
  function applyUiAction(action) {
    if (action === 'open-settings') callSettingsUi('open');
    else if (action === 'close-settings') callSettingsUi('close');
    else if (action === 'toggle-settings') callSettingsUi('toggle');
  }

  window.addEventListener('error', function (e) {
    var stack = e && e.error && e.error.stack ? String(e.error.stack).replace(/\s+/g, ' ').slice(0, 6000) : '';
    post({ type: 'log', level: 'error', msg: 'js: ' + String((e && (e.message || e.error)) || 'unknown') + ' @ ' + String((e && e.filename) || '') + ':' + ((e && e.lineno) || 0) + (stack ? ' | stack: ' + stack : '') });
  });
  window.addEventListener('unhandledrejection', function (e) {
    post({ type: 'log', level: 'error', msg: 'rejection: ' + String((e && e.reason) || 'unknown') });
  });
  // issue #12 增加日志功能: the page's own diagnostics were invisible outside devtools — only
  // console.error was mirrored, so a warning (Folia logs style/tuning problems through console.warn)
  // or an informational load step never reached spw-folia-host.stdout.log. Mirror warn and info too,
  // at their own level, and keep the volume bounded (one line per call, deduped by text, info capped
  // at 200 distinct messages) so the log stays readable in a feedback report.
  //
  // v0.4.2a: PixiJS reports deprecations through `console.groupCollapsed(...)` + `console.warn(stack)`
  // + `console.groupEnd()`. The first call carries the actual message, the second carries only a stack,
  // so mirroring `warn` alone produced a log line that was nothing but "at bt (...)" frames. Mirror
  // groupCollapsed/groupEnd too: they keep the message and its frames together in one line, and the
  // `group` bookkeeping lets the stack lines be appended to the message they belong to instead of
  // becoming separate, meaningless entries.
  var consoleSeen = {};
  var consoleInfoCount = 0;
  var consoleGroup = [];
  (function () {
    function fmt(args, max) {
      if (!args || args.length === 0) return '';
      var first = args[0];
      // Devtools-style format string: `%s` consumes the next argument, `%c` is styling and is
      // dropped. PixiJS reports deprecations as `console.groupCollapsed('%c…%c%s', styleA, styleB,
      // message)`, so without this the label was a wall of CSS.
      if (typeof first === 'string' && first.indexOf('%') >= 0 && args.length > 1) {
        var next = 1;
        var text = first.replace(/%[scdifoO]/g, function (token) {
          if (token === '%c') return '';
          var value = args[next++];
          if (value === undefined) return token;
          return value instanceof Error ? String(value.message) : String(value);
        });
        return text.slice(0, max || 4000);
      }
      var parts = [];
      for (var i = 0; i < args.length && i < 6; i++) {
        var a = args[i];
        parts.push(a instanceof Error ? String(a.message) : String(a));
      }
      return parts.join(' ').slice(0, max || 4000);
    }
    function emit(level, name, text, bare) {
      var key = level + '|' + text.slice(0, 200);
      if (consoleSeen[key]) return;
      consoleSeen[key] = 1;
      if (level === 'info') { if (++consoleInfoCount > 200) return; }
      // `bare` = the text already carries its own context (the group label itself).
      var prefix = (!bare && consoleGroup.length) ? consoleGroup.join(' / ') + ': ' : '';
      post({ type: 'log', level: level, msg: 'console.' + name + ': ' + prefix + text });
    }
    function mirror(level, name) {
      var orig = console[name];
      if (!orig) return;
      console[name] = function () {
        try { emit(level, name, fmt(arguments)); } catch (e) { }
        return orig.apply(console, arguments);
      };
    }
    mirror('error', 'error');
    mirror('warn', 'warn');
    mirror('info', 'info');
    // Groups: the label is the message, the following console.warn is the stack belonging to it.
    ['group', 'groupCollapsed'].forEach(function (name) {
      var orig = console[name];
      if (!orig) return;
      console[name] = function () {
        try {
          var label = fmt(arguments);
          if (label) { consoleGroup.push(label); emit('warn', name, label, true); }
        } catch (e) { }
        return orig.apply(console, arguments);
      };
    });
    var origEnd = console.groupEnd;
    if (origEnd) {
      console.groupEnd = function () {
        try { consoleGroup.pop(); } catch (e) { }
        return origEnd.apply(console, arguments);
      };
    }
  })();

  // Long-frame reporting: a stalled main thread is the usual shape of a "卡住/掉帧" report, and a
  // bare fps number does not say when it happened. The rAF meter below counts `stallFrames`
  // (>100 ms) and remembers `worstFrameMs` per 1 s window; the host turns a non-zero stall count
  // into a `page-stall` log line (HostForm.WriteFpsSample).

  // ---------------------------------------------------------------- SSE emulation

  function dispatch(src, name, data) {
    var list = src.__listeners[name];
    if (!list || !list.length) return;
    // Real EventSource hands the listener a MessageEvent whose .data is a JSON *string*; Folia's
    // ObsBrowserSourceApp does JSON.parse(event.data). Serialize here (never hand it a raw object).
    var text;
    try { text = JSON.stringify(data); } catch (err) { return; }
    var ev = { type: name, data: text };
    for (var i = 0; i < list.length; i++) {
      try { list[i].call(src, ev); } catch (err) { console.error('[spw-folia] SSE listener error', name, err); }
    }
  }

  function deliver(name, data) {
    lastEvents[name] = data;
    if (name === 'config') {
      lastConfig = data;
      // v0.4.1 真实预览: the settings UI mirrors the config the player actually received (the page-side
      // publisher's pushConfig and a host-sent config both land here), so the stage preview never has
      // to guess. Local listeners are the page's `bridgeOn('config')` subscribers.
      emitLocal('config', data);
    }
    if (name === 'clock') lastClock = data;
    for (var i = 0; i < sources.length; i++) dispatch(sources[i], name, data);
  }

  function FakeEventSource(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    this.__listeners = {};
    sources.push(this);
    var self = this;
    setTimeout(function () {
      self.readyState = 1;
      try { if (self.onopen) self.onopen({ type: 'open' }); } catch (e) { }
      var names = Object.keys(lastEvents);
      for (var i = 0; i < names.length; i++) dispatch(self, names[i], lastEvents[names[i]]);
      post({ type: 'log', level: 'info', msg: 'eventsource-open ' + self.url });
    }, 0);
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  FakeEventSource.CLOSED = 2;
  FakeEventSource.prototype.addEventListener = function (name, fn) {
    var list = this.__listeners[name] || (this.__listeners[name] = []);
    if (list.indexOf(fn) < 0) list.push(fn);
    if (Object.prototype.hasOwnProperty.call(lastEvents, name)) {
      var self = this;
      var data = lastEvents[name];
      setTimeout(function () { dispatch(self, name, data); }, 0);
    }
  };
  FakeEventSource.prototype.removeEventListener = function (name, fn) {
    var list = this.__listeners[name];
    if (!list) return;
    var idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  };
  FakeEventSource.prototype.close = function () { this.readyState = 2; };
  window.EventSource = FakeEventSource;

  // ---------------------------------------------------------------- payload translation

  var ZERO_BANDS = { bass: 0, lowMid: 0, mid: 0, vocal: 0, treble: 0 };

  // state -> ObsBrowserSourceClock (page interpolates from sentAtMs + playbackRate)
  function toClock(state) {
    return {
      currentTime: (state.posMs || 0) / 1000,
      duration: (state.durationMs || 0) / 1000,
      playerState: state.playing === false ? 'PAUSED' : 'PLAYING',
      sentAtMs: Date.now(),
      playbackRate: typeof state.rate === 'number' ? state.rate : 1,
      lyricOffsetMs: (state.lyricOffsetMs || 0) / 1000
    };
  }

  // audio -> ObsBrowserSourceAudio. Values are already the Folia 0..255 gamma-shaped scale
  // (see docs/protocol.md §5), spectrum is a 0..255 byte array (1024 bins).
  function toAudio(msg) {
    var bands = msg.bands;
    if (bands && Object.prototype.toString.call(bands) === '[object Array]') {
      bands = { bass: bands[0] || 0, lowMid: bands[1] || 0, mid: bands[2] || 0, vocal: bands[3] || 0, treble: bands[4] || 0 };
    } else if (!bands) {
      bands = {
        bass: msg.bass || 0, lowMid: msg.lowMid || 0, mid: msg.mid || 0,
        vocal: msg.vocal || 0, treble: msg.treble || 0
      };
    }
    var spectrum = msg.spectrum;
    if (spectrum && Object.prototype.toString.call(spectrum) === '[object Array]') {
      var bytes = new Uint8Array(spectrum.length);
      for (var i = 0; i < spectrum.length; i++) {
        var v = spectrum[i] | 0;
        bytes[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
      spectrum = bytes;
    } else if (!spectrum) {
      spectrum = new Uint8Array(0);
    }
    return {
      audioPower: typeof msg.power === 'number' ? msg.power : (msg.audioPower || 0),
      bands: bands || ZERO_BANDS,
      spectrum: spectrum,
      sentAtMs: Date.now()
    };
  }

  function clockThrottled(force) {
    var now = Date.now();
    if (!force && now - lastClockSentAt < 250) return false;
    lastClockSentAt = now;
    return true;
  }

  // ---------------------------------------------------------------- host -> page

  window.chrome.webview.addEventListener('message', function (e) {
    var msg = e.data;
    if (typeof msg === 'string') {
      try { msg = JSON.parse(msg); } catch (err) { return; }
    }
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'hello':
        inputs.hello = msg;
        emitLocal('hello', msg);
        break;
      case 'settings':
        settings = msg.settings || {};
        emitLocal('settings', settings);
        break;
      case 'state':
        inputs.state = msg;
        if (clockThrottled(!lastClock || msg.playing !== lastClock.__playing)) {
          deliver('clock', toClock(msg));
          lastClock.__playing = msg.playing;
        }
        emitLocal('state', msg);
        break;
      case 'lyrics':
        inputs.lyrics = msg;
        emitLocal('lyrics', msg);
        break;
      case 'track':
        inputs.track = msg;
        emitLocal('track', msg);
        break;
      case 'queue':
        // protocol §3.2 / playback-controls.md §3.2: current playback queue snapshot; the settings
        // PlaybackBar + queue panel subscribe to 'queue' and read inputs.queue on late mount.
        inputs.queue = msg;
        emitLocal('queue', msg);
        break;
      case 'audio':
        inputs.audio = msg;
        deliver('audio', toAudio(msg));
        emitLocal('audio', msg);
        break;
      case 'config':
        deliver('config', msg.config);
        break;
      case 'ui':
        inputs.ui = msg;
        applyUiAction(msg.action);
        emitLocal('ui', msg);
        break;
      case 'envReport':
        // issue #12: the host's half of the 「出现问题」 environment report. The settings panel
        // subscribes to this event through the bridge (bridge.requestEnvReport).
        inputs.envReport = msg.report || null;
        emitLocal('envReport', msg.report || null);
        break;
      case 'beat':
        inputs.beat = msg;
        emitLocal('beat', msg);
        if (window.__SPW_FOLIA_BEAT__ && window.__SPW_FOLIA_BEAT__.onBeat) {
          try { window.__SPW_FOLIA_BEAT__.onBeat(msg); } catch (err) { console.error('[spw-folia] beat handler', err); }
        }
        break;
    }
  });

  // ---------------------------------------------------------------- public bridge (§3.3)

  window.__SPW_FOLIA__ = {
    protocol: PROTOCOL,
    version: '1.0',
    on: function (type, fn) {
      var list = listeners[type] || (listeners[type] = []);
      if (list.indexOf(fn) < 0) list.push(fn);
    },
    off: function (type, fn) {
      var list = listeners[type];
      if (!list) return;
      var idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    emit: function (type, payload) {
      if (type === 'settings') post({ type: 'settings', settings: payload });
      else if (type === 'settingsUI') post({ type: 'settingsUI', state: (payload && payload.state) || 'open' });
      else if (type === 'action') post({ type: 'action', name: (payload && payload.name) || payload });
      else if (type === 'log') post({ type: 'log', level: (payload && payload.level) || 'info', msg: (payload && payload.msg) || '' });
      else if (type === 'control') post(Object.assign({ type: 'control' }, payload || {}));
      /* issue #12: the diagnostics actions carry flat protocol fields (docs/protocol.md §3.1), so
       * flatten the payload the same way `control` does instead of nesting it under `payload`. */
      else if (type === 'envCheck') post({ type: 'envCheck' });
      else if (type === 'openLogFolder') post({ type: 'openLogFolder', path: (payload && payload.path) || null });
      else if (type === 'openUrl') post({ type: 'openUrl', url: (payload && payload.url) || null });
      else post({ type: type, payload: payload });
      emitLocal(type, payload);
    },
    pushConfig: function (config) {
      if (!config) return;
      lastConfig = config;
      deliver('config', config);
    },
    getSettings: function () { return settings; },
    setSettings: function (partial) {
      if (!partial) return settings;
      for (var k in partial) if (Object.prototype.hasOwnProperty.call(partial, k)) settings[k] = partial[k];
      post({ type: 'settings', settings: settings });
      emitLocal('settings', settings);
      return settings;
    },
    requestClose: function () { post({ type: 'action', name: 'close' }); },
    openSettings: function () { applyUiAction('open-settings'); emitLocal('ui', { action: 'open-settings' }); },
    closeSettings: function () { applyUiAction('close-settings'); emitLocal('ui', { action: 'close-settings' }); },
    toggleSettings: function () { applyUiAction('toggle-settings'); emitLocal('ui', { action: 'toggle-settings' }); },
    ui: {
      isSettingsOpen: isSettingsOpen,
      openSettings: function () { applyUiAction('open-settings'); emitLocal('ui', { action: 'open-settings' }); },
      closeSettings: function () { applyUiAction('close-settings'); emitLocal('ui', { action: 'close-settings' }); },
      toggleSettings: function () { applyUiAction('toggle-settings'); emitLocal('ui', { action: 'toggle-settings' }); }
    },
    getStats: function () {
      return { fps: lastFps, longFrames: longFrames, atMs: Math.round(performance.now()), href: location.href };
    },
    inputs: inputs,
    lastConfig: function () { return lastConfig; },
    lastClock: function () { return lastClock; }
  };

  document.addEventListener('keydown', function (e) {
    if (!e || !e.key) return;
    // Docs/protocol.md §7.5: the settings UI owns ESC while its overlay is open (it handles the key
    // in its own capture listener and stops propagation). The shim must not swallow/duplicate it:
    // when the overlay is open we do nothing here; a second ESC (overlay closed) reaches the host,
    // which closes the window with reason "user".
    if (e.key === 'Escape' && isSettingsOpen()) return;
    // SPW's in-app shortcut only fires while SPW owns focus; once this fullscreen window is
    // focused the key lands here instead, which is why the toggle could open but never close.
    // The registered action's default combo (Ctrl+Alt+F) closes the window from here.
    if (e.ctrlKey && e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      post({ type: 'action', name: 'close' });
      return;
    }
    post({ type: 'key', key: e.key, ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey });
    // F1 is the agreed open/close trigger, routed through the same ui actions the host uses.
    if (e.key === 'F1') {
      applyUiAction('toggle-settings');
      emitLocal('ui', { action: 'toggle-settings' });
      e.preventDefault();
    }
  }, true);

  // Mouse side-button "back" (XBUTTON1 → DOM button 3) exits Folia mode. Mirrors ESC ownership:
  // while the settings overlay is open the first back closes the overlay only; otherwise the host
  // receives the same `action: close` envelope the ESC path uses and closes the window
  // (reason "user"). mousedown only: Chromium fires mouseup/auxclick for the same press, and a
  // second dispatch would otherwise turn "close settings" into "exit".
  document.addEventListener('mousedown', function (e) {
    if (!e || e.button !== 3) return;
    e.preventDefault();
    e.stopPropagation();
    if (isSettingsOpen()) {
      applyUiAction('close-settings');
      emitLocal('ui', { action: 'close-settings' });
      return;
    }
    post({ type: 'action', name: 'close' });
  }, true);

  // Multi-monitor: Alt+left-drag anywhere on the player page moves the borderless window to another
  // monitor. The host hands the window to Windows' native move loop (WM_NCLBUTTONDOWN/HTCAPTION) and
  // re-fullscreens on the monitor it was dropped on; skipping the settings overlay keeps its inputs
  // and sliders working normally.
  document.addEventListener('mousedown', function (e) {
    if (!e || e.button !== 0 || !e.altKey) return;
    if (isSettingsOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'windowDrag' });
  }, true);

  // ---------------------------------------------------------------- rAF metrics

  var frames = 0;
  var windowStart = 0;
  var lastFrame = 0;
  var longFrames = 0;
  // issue #12: separate the "just over one vsync" jitter from real stalls, and remember the worst
  // frame of the window, so a lag report can be matched to a moment instead of only an average fps.
  var stallFrames = 0;
  var worstFrameMs = 0;
  // v0.4.9 (M2): the host used to take `firstPageFrameAt` from the first `fps` message, but that
  // message is only sent once a whole 1 s window has elapsed — so "first frame" was really "end of
  // the first fps window", ~850 ms late (measured). The splash reveal gate is
  // `max(shownAt + splashMinMs, firstFrameAt + SplashFrameGraceMs)`, so the opening splash stayed on
  // screen that much longer than the configured minimum. Report the first rAF callback separately;
  // the fps window below keeps its own cadence and its own meaning.
  var reportedFirstFrame = false;
  function tick(t) {
    if (!reportedFirstFrame) {
      reportedFirstFrame = true;
      post({ type: 'first-frame', atMs: Math.round(t) });
    }
    if (!windowStart) { windowStart = t; lastFrame = t; }
    frames += 1;
    if (lastFrame) {
      var dt = t - lastFrame;
      if (dt > 25) longFrames += 1;
      if (dt > 100) stallFrames += 1;
      if (dt > worstFrameMs) worstFrameMs = dt;
    }
    lastFrame = t;
    var elapsed = t - windowStart;
    if (elapsed >= 1000) {
      var fps = frames * 1000.0 / elapsed;
      lastFps = Math.round(fps * 10) / 10;
      var heapMB = null;
      if (performance.memory) heapMB = Math.round(performance.memory.usedJSHeapSize / 104857.6) / 10;
      post({
        type: 'fps',
        fps: lastFps,
        longFrames: longFrames,
        stallFrames: stallFrames,
        worstFrameMs: Math.round(worstFrameMs),
        heapMB: heapMB,
        canvases: document.querySelectorAll('canvas').length,
        dpr: window.devicePixelRatio,
        w: window.innerWidth,
        h: window.innerHeight,
        // v0.4.10: `__foliaNativeRequestAnimationFrame` is only set while upstream's limiter is
        // installed, so `capped: false` is the ground truth for "nothing is throttling the page".
        // It is independent of how fast this machine can actually draw, and therefore of the
        // display's refresh ceiling — fps numbers alone cannot distinguish the two.
        capped: typeof window.__foliaNativeRequestAnimationFrame === 'function',
        atMs: Math.round(t)
      });
      frames = 0;
      windowStart = t;
      longFrames = 0;
      stallFrames = 0;
      worstFrameMs = 0;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  post({
    type: 'ready',
    source: 'shim',
    protocol: PROTOCOL,
    href: window.location.href,
    frameRateCleared: frameRateCleared
  });
})();
