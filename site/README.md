# spw-folia 宣传站（`site/`）

单页、纯静态的宣传站。没有构建步骤、没有运行期依赖、没有任何网络请求 —— 直接双击
`index.html` 就能看（本地起个静态服务器体验更好，视频的 range 请求更顺）。

部署在 **https://azkbzxf.github.io/spw-folia/**，由
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) 在每次 `site/**` 变更时
把整个目录上传成 Pages 产物。因为什么都没构建，**你本地看到的就是线上会看到的**。

> 这一版是 v0.4.18 的「全面重做」：结构、章节编排、动效都重写，内容对齐 v0.4.18。
> 旧版是 v0.4.6 前后写的，下载链接、样式数口径与功能清单都已过时。

## 改版本号只改一行

**发布号只在 `site/index.html` 出现一次**：`<html lang="zh-CN" data-release="0.4.18">` 这一行的
`data-release` 属性。`main.js` 启动时把它写进页面里所有 `[data-release="v"]` 标记
（导航与首屏的下载按钮、安装步骤、「本次发布」那条版本记录），所以改一处、全站跟着变。

不要再把版本号写进正文句子或 `main.js` 里 —— `site/tools/check-site.mjs` 会检查
「`data-release` 只声明一次」和「下载 / 当前版本这类文案里没有写死版本号」。
历史版本记录（v0.4.15 / v0.4.16 / v0.4.17）里的版本串是**内容**，不是发布号，不用改。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` | 页面。中文文案全部手写；顶栏 + 章节轨 + 首屏 + 8 个章节 + 收束 + 页脚。 |
| `style.css` | 全部样式：墨黑 / 金色配色、衬线展示字、章节轨、灯箱、`prefers-reduced-motion` 降级、三档响应式。 |
| `main.js` | 版本号注入、17 格画廊注入、滚动高亮（章节轨与顶栏）、滚动入场、视频懒加载、灯箱（含焦点管理）。 |
| `assets/fonts/serif.woff2` | Noto Serif SC 的子集，覆盖站点实际渲染的每个字符。 |
| `assets/styles/*.jpg` | 17 张样式缩略图，960×540。 |
| `assets/styles/large/*.jpg` | 同 17 张的 1600×900 版，供灯箱使用。 |
| `assets/video/` | 三段 H.264 片段与海报：`hero`（首屏背景）、`reel`（样式蒙太奇）、`overlay`（桌面透明）。 |
| `assets/stills/` | 文案里用的界面截图：`player-page.jpg` / `player-menu.jpg` / `settings-page.jpg` / `menu-folia.png`。 |
| `tools/` | 重新生成上面这些素材的脚本，以及站点自检脚本。 |

### 17 张样式图的来源

**它们就是插件「歌词样式」货架里的那 17 张小图本身**，不是另外渲染的示意图。真源是
`packaging/web/settings/thumbs/<id>.jpg`（1440×900，由发行版渲染器画出、用户真正看到的那张），
`site/tools/restyle-gallery.mjs` 裁成 16:9 后输出两档尺寸：

```bash
node site/tools/restyle-gallery.mjs      # 需要 packaging/web/settings/thumbs/ 已存在
```

货架图是 1440×900（16:10），站点是 16:9，脚本保留中间 810 行（上下各裁 45）。换上游版本、
重跑 `make-thumbs.mjs` 之后重跑它，站点与插件就不会再对不上。

`assets/stills/settings-ui.jpg` 是旧版设置页截图，**当前页面不再引用**，作为历史素材保留。

## 站点自检

```bash
node site/tools/check-site.mjs
```

起一个本地静态服务器指向 `site/`，然后用
`poc/settings-ui/node_modules/puppeteer-core` 驱动真实 Edge（headless），在
**1920×1080 / 1440×900 / 390×844** 三档视口各跑一遍：

- 无 console error、无 pageerror、无 4xx、无失败请求
- `.tile` 正好 17 格、17 张画廊图都解码成功、每个 `<img>` 有非空 `alt`、每个 `<a>` 有非空 `href`
- 灯箱：点第一格 → 出现 `[role=dialog]` 且可见 → 加载 1600×900 大图 → `Esc` 关闭 →
  焦点回到触发的那一格按钮
- 三档视口都没有横向溢出（`scrollWidth <= innerWidth + 1`）
- `prefers-reduced-motion: reduce` 下没有任何视频在自动播放
- `file://` 直接打开也能用（CSS/JS 加载、画廊仍注入 17 格、无 pageerror）

输出每项 PASS/FAIL，任何一项失败都以退出码 1 结束。跑不了 Edge 时退出码 2 并说明缺什么。

三张界面截图（`player-page` / `player-menu` / `settings-page`）不是这个目录的静态素材，
要用真实 WebView2 宿主（`packaging/native/spw-folia-host.exe` + `packaging/web`）截。
脚本把它单列为第 0 组检查，缺图时会明确报「缺 X 张，来自 Lead 的截屏」，不会混在 404 里。

## 重新生成素材

下面这些画面都是 **Folia 可视化器的真实渲染**，不是画出来的示意图：工具用
无头 Edge 驱动插件打包的同一份产物，走 `poc/webview/server/server.mjs` 实现的
OBS 浏览器源协议截帧。

前置条件：

- `poc/webview/dist/` —— Folia 产物（已被 gitignore，按 `poc/webview/README.md` 重新构建）
- `poc/webview/server/node_modules/` —— `cd poc/webview/server && pnpm install`
- 带 libx264 的完整 ffmpeg（Playwright 自带的是裁剪版，编不了 H.264），
  用 `FFMPEG=/path/to/ffmpeg` 指过去
- Python + Pillow + fontTools（两个 `.py` 脚本用）

```bash
cd poc/webview/server && pnpm install && cd -

# 17 张样式图：直接取插件货架的 17 张小图，裁成 16:9 后出两档尺寸
node site/tools/restyle-gallery.mjs

# 蒙太奇与透明演示要用的样式帧（约 2 分钟）
node site/tools/capture-hero.mjs
node site/tools/capture-scenes.mjs

# 编码全部视频素材 + 海报（只处理 hero / reel / overlay）
FFMPEG=/path/to/ffmpeg bash site/tools/encode.sh

# 把衬线字体子集到页面实际用到的字符
python site/tools/make-font.py
```

`capture-styles.mjs` / `make-gallery.py` 是上一版站点用来从零渲染画廊的工具，站点已改用
`restyle-gallery.mjs`（见上），两者保留但**当前页面不依赖它们**。`capture-styles.mjs` 仍然接受
可选的样式列表与相位列表：`node site/tools/capture-styles.mjs .tmp-capture/gallery lumiere,sonnet 2.2,6.2`，
把截图对准某一行歌词的中段（示例曲目是 16 秒循环，逐字样式在行边界附近几乎是空的）。

`tempera` 与 `monet` 会自己画不透明底板，所以这两个样式关掉透明标志渲染；其余样式合成在
手绘渐变上。

**改了 `index.html` / `style.css` / `main.js` 里的可见文字之后，记得重跑 `make-font.py`**，
否则新字会退回 `style.css` 里声明的系统衬线栈。没装 fontTools 时站点仍然可用，只是标题
用系统宋体渲染。

## 部署

推 `main` 即可，workflow 会把 `site/` 上传成 Pages 产物。

## 许可

页面文案与截图/录像工具跟仓库其余部分一致，AGPL-3.0。画面里的可视化效果是 Folia
（`chthollyphile/Folia`，AGPL-3.0）的渲染结果，页脚有署名。
