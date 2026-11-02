// spw-folia-host.exe opening splash controller (v0.4.8).
//
// What changed from v0.4.0: the opening transition used to be painted by this process (see the old
// IntroCurtain WinForms veil: cover-derived gradient, aurora, embers, light sweep, wordmark). That is
// gone. The animation users see now is Folia's own `#app-splash` — the upstream page's opening
// screen: #09090b backdrop, a huge "F o l i a" wordmark whose letters hop between font families /
// weights / italics / scales, and a 13-bar white waveform underneath (1100 ms loop).
//
// The page owns the drawing; this file owns the *timing*. Why it is needed at all: the upstream
// inline script in index.html removes the splash when `obs=1` is present, and that parameter is
// mandatory here (src/utils/appSurface.ts picks the OBS React root from it; without it the page
// mounts the main app window, which needs a full player UI and an Electron bridge and crashes in
// WebView2). Shim.js therefore re-injects an equivalent splash when the URL carries `splash=1`, and
// this controller decides when it fades out — after the page has really painted and the minimum
// on-screen time has elapsed, so the hand-over neither flashes nor leaves a black frame.
//
// C# 5 only (in-box .NET Framework 4.8 csc.exe): no interpolation / ?. / expression bodies.

namespace SpwFolia
{
    /// <summary>
    /// v0.4.8: names/constants shared by HostForm's splash state machine. The old veil drew its own
    /// window; the replacement only needs to talk to the page, so this stays a plain static class.
    /// </summary>
    internal static class SplashBridge
    {
        /// <summary>
        /// URL parameter that makes Shim.js install the page-side splash. Upstream only understands
        /// `splash=0` (remove); `splash=1` is read exclusively by the host shim.
        /// </summary>
        public const string UrlParam = "splash";

        /// <summary>Fade-out length of the page splash (`#app-splash` transition: opacity 320ms).</summary>
        public const int FadeOutMs = 320;

        /// <summary>
        /// Script the host evaluates to start the fade-out. Guarded so a page without the shim (dev
        /// server, remote bundle) is a harmless no-op instead of a JS error in the log.
        /// </summary>
        public const string HideScript =
            "(function(){try{return (window.__spwHideSplash ? window.__spwHideSplash() : 'nomarker');}"
            + "catch(e){return 'error:' + String(e && e.message ? e.message : e);}})();";

        /// <summary>DOM snapshot used by the acceptance checks; evaluates to a JSON object string.</summary>
        public const string InfoScript =
            "(function(){try{var i = window.__spwSplashInfo ? window.__spwSplashInfo() : null;"
            + "return JSON.stringify(i);}catch(e){return 'null';}})();";
    }
}
