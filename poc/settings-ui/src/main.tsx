/* Injected entry: the host loads this module (settings-ui.js from the mapped virtual host) after
 * Shim.js, then it mounts either the settings island or the market-only window.
 *
 * Two shells, one bundle: `?market=1` means the host opened `mod-market.html` on purpose (issue #23
 * second round: 「商店不再依赖 folia 的主界面」), so only `ModMarketPanel` is rendered. Everything
 * else — the settings window, the player chrome, the hit-region reporting — belongs to the player
 * page and must not exist in that window. See `src/market/mountMarketWindow.tsx` for why this is a
 * branch instead of a second vite entry. */
import './app.css';
import './i18n';
import { mountSettingsUi } from './mount';
import { isMarketWindow, mountMarketWindow } from './market/mountMarketWindow';

if (isMarketWindow()) mountMarketWindow();
else mountSettingsUi();
