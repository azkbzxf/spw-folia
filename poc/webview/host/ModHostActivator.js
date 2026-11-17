/* mod-host-activator.js — the Folium mod activator, shared by BOTH shims (issue #23 第二轮).
 *
 * ## Why this file exists (the bug it fixes)
 *
 * The activator used to live inline in `Shim.js`, which is injected into the **top** document only
 * (`Shim.js` starts with `if (window.top !== window) return;`). The settings page's big live preview
 * is a **same-origin iframe** running `preview.html` + `PreviewShim.js`, so it never had the
 * activator: a mod's `client.mjs` was never imported there, `window.__SPW_FOLIA_MOD_VISUALIZERS__`
 * did not exist, and `config.visualizerMode = "mod:<id>:<viz>"` fell back to the built-in default.
 * The user-visible symptom was 「导入歌词样式的模组时，大的预览框没有适配」 — the shelf tile showed the
 * mod, the player rendered it, but the big preview kept drawing the built-in style.
 *
 * Measured before the fix (probe on the real host, settings overlay open):
 *   { hasModsGlobal: false, hasModVisualizers: false, hasPreviewShim: true, hasHostShim: false }
 *
 * ## Why a factory instead of a copy
 *
 * Two copies of an activator drift: the `addOldClientNames` wrap and the `onRelease` collection were
 * each added because a measured failure had no other fix (see `docs/mod-system.md` §3.1-3.2). A
 * second, quietly older copy in the preview would reproduce the "mod loads but draws nothing" bug in
 * exactly one window, which is the hardest kind to notice.
 *
 * So the activator is installed by the page that owns the document, and it borrows the three things
 * it cannot own itself:
 *   - `getMods()`      — the installed-mod list (top document: host `mods` push; iframe: `settings`);
 *   - `emit(type, p)`  — the local event bus of that document;
 *   - `post(msg)`      — the diagnostics channel (top: `chrome.webview`; iframe: parent postMessage).
 *
 * Everything else (the API chunk, `addOldClientNames`, the registries, teardown) is identical, which
 * is the whole point.
 *
 * The body below is the activator verbatim from `Shim.js`; only the wrapper changed.
 */
(function (root) {
  'use strict';

  /**
   * Installs the activator on `window` of the current document.
   *
   * Returns the `modHost` handle (`reconcile` / `status`), so the caller keeps its existing wiring.
   * Idempotent: a second call returns the live handle instead of activating every mod twice.
   */
  root.installFoliaModHost = function installFoliaModHost(options) {
    if (root.__SPW_FOLIA_MOD_HOST__) return root.__SPW_FOLIA_MOD_HOST__;
    var getMods = (options && options.getMods) || function () { return []; };
    var emit = (options && options.emit) || function () { };
    var post = (options && options.post) || function () { };
    // `inputs` is what the activator reads for `listMods()`; it must reflect the CURRENT list, so it
    // is a live view rather than a snapshot copied at install time.
    var inputs = { mods: getMods() };
    var refreshMods = function () { inputs.mods = getMods() || []; return inputs.mods; };

  // What a module bridge cannot do. These are NOT all `{ok:false}`: upstream's `ipc.ts` unwraps
  // `{ok:true,result}` and a mod expects `storage.get()` to resolve, so answering "no" would turn a
  // harmless read into a rejected promise inside mod code. Reads answer empty, writes are no-ops,
  // and only the genuinely unsupported calls fail loudly (net/rpc/pickFile), where the mod asked for
  // something we truly cannot provide.
  var NO_MAIN = { ok: false, error: 'no-main-process' };

  function emptyDisposer() { return function () { }; }

  var modBridge = {
    listMods: function () {
      return Promise.resolve({
        mods: inputs.mods || [],
        ffmpeg: { available: false, path: null, version: null, candidates: [] },
        directories: [],
        startSkipped: false
      });
    },
    setModEnabled: function () { return Promise.resolve({ ok: false, error: 'no-main-process', mods: inputs.mods || [] }); },
    reloadMods: function () { return Promise.resolve({ mods: inputs.mods || [] }); },
    installModFromZip: function () { return Promise.resolve(NO_MAIN); },
    invokeModStorage: function () { return Promise.resolve({ ok: true, result: null }); },
    invokeModSecrets: function () { return Promise.resolve({ ok: true, result: null }); },
    invokeModRpc: function () { return Promise.resolve(NO_MAIN); },
    invokeModNetFetch: function () { return Promise.resolve(NO_MAIN); },
    invokeModPickFile: function () { return Promise.resolve(NO_MAIN); },
    invokeModRestoreFile: function () { return Promise.resolve({ ok: true, result: null }); },
    invokeModReleaseFile: function () { return Promise.resolve({ ok: true }); },
    getFfmpegStatus: function () { return Promise.resolve({ available: false, path: null, version: null, candidates: [] }); },
    openModsDirectory: function () { return Promise.resolve(NO_MAIN); },
    getModStorageUsage: function () { return Promise.resolve({ ok: true, bytes: 0, dataBytes: 0, cacheBytes: 0 }); },
    clearModCache: function () { return Promise.resolve({ ok: true }); },
    getModCallStats: function () { return Promise.resolve({ stats: {} }); },
    pushRuntimeSnapshot: function () { return Promise.resolve(); },
    cancelExport: function () { return Promise.resolve(); },
    reportModsStartAlive: function () { return Promise.resolve(); },
    reportModsStartSettled: function () { return Promise.resolve(); },
    onModsStateChanged: emptyDisposer,
    onExportProgress: emptyDisposer,
    onModLog: emptyDisposer,
    onModRpcMessage: emptyDisposer,
    onModSecretChanged: emptyDisposer
  };

  // `Boolean(window.electron?.mods)` must be true: Folia's `isModsBridgeAvailable()` gates every
  // mod path on it, and several upstream surfaces show a "desktop only" hint without it.
  (function installModBridge() {
    try {
      if (!window.electron) window.electron = {};
      if (window.electron.mods) return; // a real preload bridge wins; never shadow it
      window.electron.mods = modBridge;
    } catch (e) {
      console.warn('[spw-folia] could not install window.electron.mods', e);
    }
  })();

  // Playback-bar buttons: the settings island is a SEPARATE bundle and cannot reach this page's
  // upstream registry objects, so registrations are forwarded into a plain array it reads.
  // Shape (contract with poc/settings-ui): [{ id, slot:'leading'|'trailing', order, mount, modId }]
  // with a `subscribe(fn)` helper hung off the array.
  var progressButtons = [];
  var progressSubscribers = [];

  function progressNotify() {
    for (var i = 0; i < progressSubscribers.length; i++) {
      try { progressSubscribers[i](progressButtons); } catch (e) { console.warn('[spw-folia] progress subscriber', e); }
    }
  }

  // The settings island wants `{mode,modId,vizId,label}` entries; `mode` is what it puts in config.
  var modVisualizers = [];
  var visualizerSubscribers = [];

  function visualizersNotify() {
    for (var i = 0; i < visualizerSubscribers.length; i++) {
      try { visualizerSubscribers[i](modVisualizers); } catch (e) { console.warn('[spw-folia] visualizer subscriber', e); }
    }
  }

  // Mod `locale`s are theirs, not ours: fall back to any language we do have rather than throwing.
  function pickLabel(label, fallback) {
    if (!label || typeof label !== 'object') return fallback || null;
    var order = ['zh-CN', 'en', 'zh-TW', 'ja'];
    for (var i = 0; i < order.length; i++) {
      if (typeof label[order[i]] === 'string' && label[order[i]]) return label[order[i]];
    }
    for (var k in label) {
      if (Object.prototype.hasOwnProperty.call(label, k) && typeof label[k] === 'string' && label[k]) return label[k];
    }
    return fallback || null;
  }

  var MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

    var hostInfo = null;          // /mod-host.json, fetched once
    var hostPromise = null;       // in-flight/!resolved fetch
    var apiPromise = null;        // in-flight/!resolved api module
    var deprecatedPromise = null;
    var active = {};              // modId -> record
    var errors = [];
    var reconciling = false;
    var pendingReconcile = null;
    var lastList = [];

    function recordError(modId, stage, error) {
      var text = String((error && error.message) || error || 'unknown');
      errors.push({ modId: modId || null, stage: stage, error: text, atMs: Math.round(performance.now()) });
      if (errors.length > 100) errors.shift();
      try { console.warn('[spw-folia] mod ' + (modId || '?') + ' ' + stage + ': ' + text); } catch (e) { }
    }

    // Where mod files are served from. `mod-host.json` names it (stage-web writes the host constant
    // in), because the host exe is what actually answers the requests — the page must not guess a
    // hostname the interceptor was not installed for. Falls back to the same default the exe uses.
    function modsBase() {
      if (hostInfo && typeof hostInfo.modsBase === 'string' && hostInfo.modsBase) return hostInfo.modsBase;
      return 'https://spw-folia-mods.local/';
    }

    function ensureHost() {      if (hostInfo) return Promise.resolve(hostInfo);
      if (hostPromise) return hostPromise;
      hostPromise = fetch('/mod-host.json', { cache: 'no-cache' })
        .then(function (res) {
          if (!res || !res.ok) throw new Error('mod-host.json HTTP ' + (res ? res.status : '?'));
          return res.json();
        })
        .then(function (json) {
          if (!json || json.format !== 'spw-folia-mod-host' || !json.api) {
            throw new Error('mod-host.json has no usable api entry');
          }
          hostInfo = json;
          return hostInfo;
        })
        .catch(function (e) {
          hostPromise = null; // a later mods push retries; never cache a failure forever
          recordError(null, 'mod-host.json', e);
          throw e;
        });
      return hostPromise;
    }

    function ensureApi() {
      if (apiPromise) return apiPromise;
      apiPromise = ensureHost().then(function (host) {
        return import('/' + host.api);
      }).catch(function (e) {
        apiPromise = null;
        throw e;
      });
      return apiPromise;
    }

    function ensureDeprecated() {
      if (deprecatedPromise) return deprecatedPromise;
      deprecatedPromise = ensureHost().then(function (host) {
        if (!host.deprecated) throw new Error('mod-host.json has no deprecated entry');
        return import('/' + host.deprecated);
      }).catch(function (e) {
        deprecatedPromise = null;
        throw e;
      });
      return deprecatedPromise;
    }

    /**
     * Builds the `folium` object one mod's client receives, plus the traces its teardown needs.
     *
     * Three wrappers are mandatory, and each one exists because a measured failure has no other fix:
     *   1. `addOldClientNames` — Folium 2 dropped `ctx.currentTime` / `ctx.subscribe`, which the mods
     *      in the market still use. Without it the visualizer mounts an EMPTY shell (measured:
     *      `shells:1, spans:0` — the style "works" but draws no characters).
     *   2. `events.on` — its disposers are NOT part of `onRelease`, so wrapping is the only way to
     *      remove event handlers at teardown without depending on a minified chunk's export name.
     *   3. `registries.progressButtons.register` — our playback bar is not upstream's, so every
     *      button registration is mirrored into the array the settings island renders.
     */
    function buildApi(mod, rec) {
      return ensureApi().then(function (apiModule) {
        if (typeof apiModule.createFoliumClientApi !== 'function') {
          throw new Error('api chunk does not export createFoliumClientApi');
        }
        var runtimeMod = {
          id: mod.id,
          name: mod.name || mod.id,
          version: mod.version || null,
          author: mod.author || null,
          description: mod.description || null,
          permissions: mod.permissions || [],
          status: 'loaded',
          error: mod.error || null,
          enabled: true,
          trustStale: false,
          signature: mod.signature || { status: 'unsigned', reason: null, keyId: null, keyLabel: null, signedAt: null },
          devSource: false,
          experimental: mod.experimental || [],
          embedOrigins: mod.embedOrigins || [],
          folia: mod.folia || null,
          hasMain: false,
          clientUrl: null
        };
        var api = apiModule.createFoliumClientApi(runtimeMod, {
          context: 'main',
          experimental: {},
          onRelease: function (release) { if (typeof release === 'function') rec.releases.push(release); },
          // Per-activation boolean, exactly like upstream's record.stopped: a lazy register arriving
          // after teardown must be refused instead of polluting the live registry.
          stopped: function (what) {
            if (rec.stopped) console.warn('[spw-folia] ' + mod.id + ' ' + what + ': this mod was stopped, the call is ignored');
            return rec.stopped;
          }
        });
        return ensureDeprecated().then(function (deprecatedModule) {
          if (typeof deprecatedModule.addOldClientNames !== 'function') {
            throw new Error('deprecated chunk does not export addOldClientNames');
          }
          return deprecatedModule.addOldClientNames(api, runtimeMod, 'main');
        }).catch(function (e) {
          // A missing deprecated chunk must not stop the mod from loading; it only means mods written
          // against Folium 1.5 render an empty shell. Recorded loudly so that state is diagnosable.
          recordError(mod.id, 'addOldClientNames', e);
          return api;
        });
      }).then(function (api) {
        return {
          api: wrapEvents(api, rec),
          registries: api.registries
        };
      }).then(function (carrier) {
        if (!carrier.registries) return carrier;
        try {
          /* v0.5.3: mirror BOTH registry names, because they are two live entry points to one kind.
           *
           * `progressButtons` is the current name; `controlButtons` is the Folium 1.5 name that
           * `addOldClientNames` re-adds as a property on the SAME `registries` object. That alias closes
           * over the UNWRAPPED `progressButtons.register`, so wrapping only the current name left every
           * `folium.registries.controlButtons.register({slot:'progress.trailing', mount})` call — which
           * is what the official 「进度条增强（样例）」 mod does — mirrored nowhere. The mod installed and
           * activated cleanly, its buttons simply never appeared: 「目前只适配了歌词样式，播放条还没适配」.
           *
           * Wrapping both is safe and idempotent in effect: whichever name the mod uses, the entry lands
           * in `progressButtons` exactly once (the alias forwards into the same underlying registry, and
           * the mirror is keyed by the handle id in `rec.progressIds`).
           */
          var patch = {};
          if (carrier.registries.progressButtons) {
            patch.progressButtons = wrapProgressRegistry(carrier.registries.progressButtons, mod.id, rec);
          }
          if (carrier.registries.controlButtons) {
            patch.controlButtons = wrapProgressRegistry(carrier.registries.controlButtons, mod.id, rec);
          }
          if (Object.keys(patch).length > 0) {
            carrier.registries = Object.freeze(Object.assign({}, carrier.registries, patch));
          }
        } catch (e) { recordError(mod.id, 'progressButtons wrap', e); }
        return carrier;
      }).then(function (carrier) {
        // The mod receives the api with the wrapped services; keep the rest of the object by copy so
        // `folium.theme`, `folium.log` … stay the upstream instances.
        return { api: Object.freeze(Object.assign({}, carrier.api, { registries: carrier.registries })), registries: carrier.registries };
      });
    }

    function wrapEvents(api, rec) {
      try {
        if (!api.events || typeof api.events.on !== 'function') return api;
        var originalOn = api.events.on;
        var wrapped = Object.freeze(Object.assign({}, api.events, {
          on: function (type, handler, options) {
            var off = originalOn(type, handler, options);
            if (typeof off === 'function') rec.eventDisposers.push(off);
            return off;
          }
        }));
        return Object.freeze(Object.assign({}, api, { events: wrapped }));
      } catch (e) {
        recordError(rec.modId, 'events wrap', e);
        return api;
      }
    }

    /**
     * Mirrors `progressButtons.register` into `window.__SPW_FOLIA_MOD_PROGRESS__` while still calling
     * upstream's register (so a mod that also renders inside Folia's own bar keeps working, and its
     * validation errors still surface to the mod as before).
     *
     * `slot` is upstream's `'progress.leading' | 'progress.trailing'`; the island's own bar speaks
     * `'leading' | 'trailing'`. The mapping happens here, once, so neither side has to know both.
     */
    function wrapProgressRegistry(registry, modId, rec) {
      if (!registry || typeof registry.register !== 'function') return registry;
      var originalRegister = registry.register;
      return Object.freeze(Object.assign({}, registry, {
        register: function (def) {
          var handle = originalRegister(def);
          try {
            if (def && handle && typeof def.mount === 'function') {
              var entry = {
                id: String(handle.id || (modId + ':' + def.id)),
                modId: modId,
                name: def.id,
                slot: def.slot === 'progress.trailing' ? 'trailing' : 'leading',
                order: typeof def.order === 'number' ? def.order : 500,
                hideWhenCollapsed: def.hideWhenCollapsed === true,
                mount: def.mount
              };
              progressButtons.push(entry);
              progressButtons.sort(function (a, b) { return (a.order - b.order) || String(a.id).localeCompare(String(b.id)); });
              rec.progressIds.push(entry.id);
              progressNotify();
            }
          } catch (e) { recordError(modId, 'progressButtons mirror', e); }
          return handle;
        }
      }));
    }

    /** Snapshots the mod's registered mod:<id>:<viz> styles for the island's shelf. */
    function collectVisualizers(mod) {
      return ensureApi().then(function (apiModule) {
        if (typeof apiModule.listFoliumHostRegistries !== 'function') return [];
        var registries = apiModule.listFoliumHostRegistries();
        var visualizers = null;
        for (var i = 0; i < registries.length; i++) {
          if (registries[i] && registries[i].name === 'visualizers') { visualizers = registries[i]; break; }
        }
        if (!visualizers || typeof visualizers.list !== 'function') return [];
        var out = [];
        var entries = visualizers.list();
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          if (!entry || entry.modId !== mod.id) continue;
          // The registry stores an adapter: `entry.name` is the mod-local id, `entry.def` is
          // StoredFoliumVisualizer — `{ mode, def: <the mod's def>, settings, … }`. The ready-made
          // `mode` (`mod:<modId>:<viz>`) is authoritative; deriving it by hand would silently
          // disagree with `foliumVisualizerMode` if upstream ever changes the prefix.
          var stored = entry.def;
          if (!stored || typeof stored !== 'object') continue;
          var mode = typeof stored.mode === 'string' ? stored.mode : null;
          if (!mode) continue;
          var def = stored.def && typeof stored.def === 'object' ? stored.def : stored;
          var vizId = entry.name || (typeof def.id === 'string' ? def.id : null);
          if (!vizId) continue;
          out.push({
            mode: mode,
            modId: mod.id,
            vizId: vizId,
            id: entry.id || (mod.id + ':' + vizId),
            label: pickLabel(def.label, vizId),
            order: typeof def.order === 'number' && isFinite(def.order) ? def.order : 500,
            // The island needs this to decide whether the host draws background/subtitles itself.
            hostBackground: stored.hostBackground !== false
          });
        }
        return out;
      }).catch(function (e) {
        recordError(mod.id, 'collectVisualizers', e);
        return [];
      });
    }

    function refreshModVisualizers() {
      var wanted = [];
      for (var id in active) {
        if (!Object.prototype.hasOwnProperty.call(active, id)) continue;
        var rec = active[id];
        // `rec.mod` holds the plugin's entry for this mod (set at activation). It is absent for a
        // record that is mid-teardown; those contribute no styles anyway.
        if (!rec.mod) continue;
        wanted.push(collectVisualizers(rec.mod));
      }
      return Promise.all(wanted).then(function (groups) {
        var flat = [];
        for (var i = 0; i < groups.length; i++) flat = flat.concat(groups[i] || []);
        flat.sort(function (a, b) { return (a.order - b.order) || String(a.mode).localeCompare(String(b.mode)); });
        modVisualizers = flat;
        try { window.__SPW_FOLIA_MOD_VISUALIZERS__ = makeSubscribable(flat, visualizerSubscribers, visualizersNotify); }
        catch (e) { recordError(null, 'publish visualizers', e); }
        visualizersNotify();
        return flat;
      });
    }

    function makeSubscribable(array, subscribers, notify) {
      try {
        Object.defineProperty(array, 'subscribe', {
          value: function (fn) {
            if (typeof fn !== 'function') return emptyDisposer();
            subscribers.push(fn);
            return function () {
              var at = subscribers.indexOf(fn);
              if (at >= 0) subscribers.splice(at, 1);
            };
          },
          enumerable: false, configurable: true, writable: true
        });
        Object.defineProperty(array, 'snapshot', {
          value: function () { return array.slice(); }, enumerable: false, configurable: true, writable: true
        });
      } catch (e) { }
      return array;
    }

    /**
     * Stops one mod. Five steps, in upstream's order (`clientLoader.ts:89-102`) — and the two that
     * this activator has to own itself are the ones that fail silently when skipped:
     *   - the disposer `activate` returned;
     *   - every `onRelease` release (measured: skipping them leaves the mod's `every()` timers
     *     RUNNING and its `onDispose` callbacks never called);
     *   - our wrapped event disposers (upstream removes those through a minified export we must not
     *     depend on);
     *   - `listFoliumHostRegistries().forEach(r => r.unregisterAll(modId))` — 11 registries.
     */
    function deactivate(modId) {
      var rec = active[modId];
      if (!rec) return Promise.resolve();
      delete active[modId];
      rec.stopped = true;
      if (typeof rec.dispose === 'function') {
        try { rec.dispose(); } catch (e) { recordError(modId, 'dispose', e); }
      }
      for (var i = rec.releases.length - 1; i >= 0; i--) {
        try { rec.releases[i](); } catch (e) { recordError(modId, 'release', e); }
      }
      for (var j = rec.eventDisposers.length - 1; j >= 0; j--) {
        try { rec.eventDisposers[j](); } catch (e) { recordError(modId, 'event-dispose', e); }
      }
      // Our mirrored progress buttons cannot be removed through upstream's registry here (unregister
      // needs the registry object), so they are dropped by ownership.
      if (rec.progressIds.length) {
        progressButtons = progressButtons.filter(function (entry) {
          return rec.progressIds.indexOf(entry.id) < 0;
        });
        window.__SPW_FOLIA_MOD_PROGRESS__ = makeSubscribable(progressButtons, progressSubscribers, progressNotify);
        progressNotify();
      }
      return ensureApi().then(function (apiModule) {
        if (typeof apiModule.listFoliumHostRegistries !== 'function') return;
        var registries = apiModule.listFoliumHostRegistries();
        for (var k = 0; k < registries.length; k++) {
          try { registries[k].unregisterAll(modId); } catch (e) { recordError(modId, 'unregisterAll', e); }
        }
      }).catch(function (e) { recordError(modId, 'teardown', e); });
    }

    /** Activates one mod: import its client entry, hand it the api, keep what it returns. */
    function activate(mod) {
      var rec = {
        modId: mod.id,
        // The plugin's entry, kept for collectVisualizers/refreshModVisualizers after activation.
        mod: mod,
        version: mod.version || null,
        entry: mod.clientEntry,
        stopped: false,
        dispose: null,
        releases: [],
        eventDisposers: [],
        progressIds: []
      };
      active[mod.id] = rec;
      // `?v=<version>`: the module map keys on the URL, so a mod whose content changed (same id, new
      // version) must get a NEW module record — otherwise an edited mod would keep running old code.
      var url = modsBase() + mod.id + '/' + mod.clientEntry + '?v=' + encodeURIComponent(mod.version || 'dev');
      return buildApi(mod, rec).then(function (carrier) {
        return import(url).then(function (module) {
          if (rec.stopped) return null;
          var activateFn = module && module.default;
          if (typeof activateFn !== 'function') {
            throw new Error('client entry must `export default function activate(folium)`');
          }
          return Promise.resolve(activateFn(carrier.api)).then(function (result) {
            if (typeof result === 'function') rec.dispose = result;
            return null;
          });
        });
      }).then(function () {
        return collectVisualizers(mod).then(function (list) {
          rec.visualizers = list || [];
          return null;
        });
      }).catch(function (e) {
        recordError(mod.id, 'activate', e);
        // A failed activation may still have registered something before throwing; tear it down so
        // the page never shows a half-registered style.
        return deactivate(mod.id);
      });
    }

    /**
     * Brings active clients in line with `list` (the plugin's full snapshot).
     * Idempotent by `id + version`: repeated `mods` pushes do nothing, and a mod whose version
     * changed is torn down and re-activated (new URL = new module record).
     */
    function reconcileOnce(list) {
      var desired = {};
      for (var i = 0; i < list.length; i++) {
        var mod = list[i];
        if (!mod || typeof mod !== 'object') continue;
        if (typeof mod.id !== 'string' || !MOD_ID_PATTERN.test(mod.id)) continue;
        if (mod.enabled !== true) continue;
        if (typeof mod.clientEntry !== 'string' || !mod.clientEntry) continue;
        // A broken entry (manifest error) is reported by the plugin; do not import it.
        if (mod.error) continue;
        desired[mod.id] = mod;
      }

      var chain = Promise.resolve();
      // Teardown first: a mod that vanished, was disabled, or changed version must stop before the
      // remaining ones activate (upstream does the same, and a duplicate id would otherwise collide).
      Object.keys(active).forEach(function (modId) {
        var rec = active[modId];
        var next = desired[modId];
        if (!next) { chain = chain.then(function () { return deactivate(modId); }); return; }
        if (rec.version !== (next.version || null) || rec.entry !== next.clientEntry) {
          chain = chain.then(function () { return deactivate(modId); });
        }
      });

      Object.keys(desired).forEach(function (modId) {
        if (active[modId]) return;
        var mod = desired[modId];
        chain = chain.then(function () { return activate(mod); });
      });

      return chain.then(function () { return refreshModVisualizers(); });
    }

    /**
     * Serialised reconcile: `mods` pushes can arrive while an activation is still importing, and two
     * interleaved runs would both see "not active yet" and activate the same mod twice. The last list
     * always wins, so a burst of pushes still converges on the newest snapshot.
     */
    function reconcile(list) {
      lastList = list || [];
      if (reconciling) { pendingReconcile = lastList; return; }
      reconciling = true;
      var run = function (snapshot) {
        return reconcileOnce(snapshot).then(function () {
          if (pendingReconcile === null) return null;
          var next = pendingReconcile;
          pendingReconcile = null;
          return run(next);
        });
      };
      run(lastList).catch(function (e) {
        recordError(null, 'reconcile', e);
      }).then(function () {
        reconciling = false;
        // Announce the new state: the settings island refreshes its shelf and playback bar on this.
        var payload = { mods: lastList, errors: errors.slice(), visualizers: modVisualizers.slice() };
        emit('modsReady', payload);
        post({ type: 'modsReady', count: lastList.length, active: Object.keys(active).length, errors: errors.length });
        publishGlobal();
      });
    }

    function publishGlobal() {
      try {
        var snapshot = {
          mods: lastList,
          errors: errors,
          progressButtons: makeSubscribable(progressButtons, progressSubscribers, progressNotify),
          visualizers: makeSubscribable(modVisualizers, visualizerSubscribers, visualizersNotify),
          activeIds: Object.keys(active),
          host: hostInfo,
          activateNow: function () { return reconcile(lastList); }
        };
        if (!window.__SPW_FOLIA_MODS__) window.__SPW_FOLIA_MODS__ = snapshot;
        else {
          window.__SPW_FOLIA_MODS__.mods = snapshot.mods;
          window.__SPW_FOLIA_MODS__.errors = snapshot.errors;
          window.__SPW_FOLIA_MODS__.progressButtons = snapshot.progressButtons;
          window.__SPW_FOLIA_MODS__.visualizers = snapshot.visualizers;
          window.__SPW_FOLIA_MODS__.activeIds = snapshot.activeIds;
          window.__SPW_FOLIA_MODS__.host = snapshot.host;
          window.__SPW_FOLIA_MODS__.activateNow = snapshot.activateNow;
        }
      } catch (e) {
        console.warn('[spw-folia] could not publish __SPW_FOLIA_MODS__', e);
      }
    }

    window.__SPW_FOLIA_MOD_PROGRESS__ = makeSubscribable(progressButtons, progressSubscribers, progressNotify);
    window.__SPW_FOLIA_MOD_VISUALIZERS__ = makeSubscribable(modVisualizers, visualizerSubscribers, visualizersNotify);
    publishGlobal();

    return {
      reconcile: reconcile,
      ensureHost: ensureHost,
      // Exposed for the acceptance probe and the settings island's "reload" affordance.
      status: function () {
        return {
          host: hostInfo,
          active: Object.keys(active),
          errors: errors.slice(),
          mods: lastList,
          progressButtons: progressButtons.slice(),
          visualizers: modVisualizers.slice()
        };
      }
    };
  

    var handle = {
      reconcile: function (list) {
        if (list !== undefined) inputs.mods = list || [];
        return reconcile(inputs.mods);
      },
      status: function () {
        return {
          host: hostInfo,
          active: Object.keys(active),
          errors: errors.slice(),
          mods: lastList,
          progressButtons: progressButtons.slice(),
          visualizers: modVisualizers.slice()
        };
      },
      /** Re-read the list from the owner (the iframe learns it from `settings`, not from a push). */
      sync: function () { return reconcile(refreshMods()); },
      ensureHost: ensureHost
    };
    root.__SPW_FOLIA_MOD_HOST__ = handle;
    return handle;
  };
})(typeof window !== 'undefined' ? window : this);
