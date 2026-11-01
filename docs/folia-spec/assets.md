# Folia 参考素材清单（素材 / 打包 / 合规）

> 上游 Folia **0.7.22**（`folia-major-main`，AGPL-3.0）。本文记录「做 harness 需要哪些素材、哪些其实不存在、
> 以及 AGPL 合规约束」，供打包与合规判断使用。
> 关联：`style-map.md`（样式的字体/缩略图真相）、`settings-ui.md`（设置页字体 tab）、`fullscreen-shell.md`（截图参考）。

---

## 0. 结论先行

| 问题 | 答案 |
|---|---|
| 15 个样式在设置页的缩略图 | 上游**不存在图片素材**。样式 shelf 每格是 `preview/LyricStylePicture.tsx` 的**实时迷你渲染**（`src/components/visualizer/README.md:83` 明说"每个样式由真实渲染器实时绘制"）。harness 直接复用 registry + preview 组件即可，**不要找 PNG**。spw-folia 自己的设置页用的是另行截取的静态 JPG，见 §3。 |
| 可视化器用到的贴图/纹理 | **没有位图纹理**。sonnet/tempera/lumiere/hanabi 的噪点、颗粒、网点、几何全是 shader/程序化生成；唯一位图是 cappella 的头像/表情（`src/components/visualizer/cappella/{avatar,emo}/*.png`）和默认封面占位图。 |
| 字体文件 | **没有随包字体**。唯一 @font-face 是 CDN 上的 Noto Serif SC 400/500（`src/index.css:19-33`），其余依赖系统字体（见 §5）。 |
| 动画模型 | 随 Electron 安装包发布（beat_this / HTDemucs 权重），**不在 web dist 里**，浏览器构建拿不到（`modelsPresent()` 恒 false）。 |
| 可直接照抄的 CSS | 构建产物 `dist/assets/src-*.css`（全站 Tailwind + kit.css 编译结果）。**文件名带 content-hash，跨版本会变，按内容匹配不要硬编码。** |

---

## 1. 素材来源与本地副本

调研期间从上游仓库 `img/` 与安装包 web dist 抽取的素材放在 `research/assets/`，**该目录被 `.gitignore` 忽略**
（`research/assets/` 在忽略列表内），只存在于做过调研的机器上；需要时按本节命令重新抽取。

### 1.1 官方界面截图（`research/assets/screenshots/`，11 个）

全部来自上游仓库 `img/`（README 引用，AGPL-3.0），可作 fullscreen shell / 样式观感参照：

| 文件 | 大小 | 内容 | 说明 |
|---|---|---|---|
| `visualizer.png` | 3.65 MB | 6844×1131 宽幅**拼贴**：时计/绘光/群唱/倾诉等样式同屏展示 | README 头图，非单帧截图 |
| `head2.png` | 2.15 MB | README 另一张头图渲染 | 未在 README.md 引用（仓库遗留） |
| `1.png` | 1.06 MB | 仓库 `img/1.png`，同上组渲染图 | 未被 md 引用 |
| `preview-pendolo.png` | 1.74 MB | **时计** pendolo 单样式全屏 | 竖排一列字的钟面构图 |
| `preview-fume.png` | 872 KB | **浮名** fume | |
| `preview-diorama.png` | 580 KB | **镜台** diorama | three.js 立体字 |
| `preview-pat.png` | 538 KB | **云阶** partita | |
| `preview-cad.png` | 527 KB | **心象** cadenza | |
| `preview-lumi.png` | 498 KB | **流光** classic（英文名 Luminous） | ⚠ README 中文标题写"流光"，与 zh-CN 一致；**不要**误当成 lumiere/绘光 |
| `preview-cappella.jpg` | 106 KB | **群唱** cappella（弹幕化歌词） | |
| `preview-tilt.png` | 91 KB | **倾诉** tilt | |

> 缺 sonnet(商籁)、tempera(凝彩)、lumiere(绘光)、hanabi(花火)、monet(莫奈)、claddagh(回环)、still(静止) 的官方图
> —— 这些样式要观感只能靠跑起来或用户截图。

### 1.2 运行时位图素材（`research/assets/folia/app-assets/`，26 个）

| 目录 | 文件 | 用途 | 源码位置 |
|---|---|---|---|
| `app-assets/cappella/avatar/` | 15 个 PNG（avatar2–6、8–17；**没有 avatar7**） | 群唱样式里的角色头像，`import.meta.glob('./avatar/*.png')` 打包；`avatarImages.ts`，`customPacks.ts` 用户可覆盖 | `src/components/visualizer/cappella/avatar/` |
| `app-assets/cappella/emo/` | 9 个 PNG：happy1/love1/normal1/sleepy1-3/vibe1-3 | 群唱弹幕里的表情贴纸，`emoImages.ts` glob | `src/components/visualizer/cappella/emo/` |
| `app-assets/covers/` | `placeholder_cover.jpg`、`placeholder_cover-2.jpg` | 无封面歌曲的占位封面（全站默认封面），被 visualizer 直接 import | 仓库根 `assets/`（Vite root assets 目录） |

- 头像/表情有 `README.md` 说明目录约定；用户自定义包（`customPacks.ts`）走 IndexedDB/localStorage，不进安装包。
- monet 的肖像、tempera 的 layerImages 都是**用户自己的图片**，没有内置素材（harness 需要自己允许用户选图或留空）。

### 1.3 浏览器可直接加载的入口 & CSS（`research/assets/folia/`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `entries/index.html` | 10,935 B | 构建产物主页面（`#app` + `main-*.js`） |
| `entries/stage-client.html` | 43,548 B | **不是**播放器：是 "Folia Stage API Docs" 页面（mod/舞台 API 文档）。若做 mod/stage 集成可参考其 API 文档结构 |
| `entries/mod-export.html` | 1,838 B | mod 导出页面 |
| `entries/runtime-config.js` | 182 B | 运行时配置注入（`window.__FOLIA_CONFIG__` 之类），Electron 主进程/部署可覆盖 |
| `css/src-*.css` | ~215 KB | **全站样式**：Tailwind + `--text-primary` 等主题变量 + kit.css，React island 必须带它才有正确观感 |
| `css/bootstrap-*.css` | ~49 KB | 启动 shell 样式 |
| `css/stageClient-*.css` | ~8 KB | Stage API 文档页样式 |
| `css/playerOverlayLayout-*.css` | ~1 KB | 播放器覆盖层布局（hotspot/back 按钮定位） |

> 文件名带 content-hash，跨版本会变；写 harness 时**按内容找**（`src-*.css` 为主样式包），不要硬编码 hash。

---

## 2. 安装包（app.asar）结构

```
<Folia 安装目录>/resources/app.asar
├── build/            # 打包元数据（icon 等）
├── dist/             # 前端构建产物 ← 唯一和 webview 相关的部分
│   ├── index.html / stage-client.html / mod-export.html
│   ├── assets/       # JS chunk + 少量 png/jpg 组 + css
│   ├── manifest.webmanifest / registerSW.js / sw.js / workbox-*.js
│   ├── folia-cover-sw.js / icon.svg / runtime-config.js
├── electron/         # 主进程 cjs（播放、分析、模型、下载…）← webview 不需要
├── node_modules/     # 依赖（three 等已在 dist chunk 里，这里的是主进程用）
├── shared/           # 主/渲染共享代码
└── package.json      # 版本号
```

- `dist/assets/` 体积 Top：`_virtual_icu-folia-dict-*.js`、`bootstrap-*.js`、`three-*.js`（three.js 单独成 chunk，
  仅镜台等用）、`_virtual_icu-folia-hmm-*.js`、`providerRegistry-*.js`、`lib-*.js`、`sonnetDebug-*.js`。
- 位图只有 27 个（15 avatar + 9 emo + 2 placeholder + 1 其它 png 组合），无 `woff/ttf/otf/mp3/ogg/wav/glb/bin`。
- 解包命令（本机路径按实际安装位置替换）：
  ```bash
  npx --yes @electron/asar extract "<Folia 安装目录>/resources/app.asar" <解包目录>
  ```
- 若只要前端：把解包后的 `dist/` 整个目录扔进任意静态服务器就能跑（`index.html` 是完整 SPA，Electron IPC 缺失时
  部分功能降级）。

---

## 3. 样式"缩略图"到底怎么来的

- 上游设置页样式网格：`VisPlayground.tsx:519` 渲染 `LyricStylePicture`，它是 `preview/` 里的组件树，
  **用该样式真实的 renderer 画一个缩小样片**（`preview/LyricPreviewContext` 提供样片歌词 + 假时钟/假音频）。
- 样片数据：`preview/LyricStylePicture.tsx` + `previewPlaceholder.ts`（`default` 样片 = 神文之诗 4 行、14.4s 循环；
  `reserved` 样片 = 野芝麻 13.6s）。
- 因此：**改样式图 = 改渲染器**，没有静态资源可替换；也不存在"缺图"问题。
- spw-folia 的设置页走的是另一条路：**离屏渲染后截图落盘成静态 JPG**，运行时按 `settings/thumbs/<mode>.jpg` 取
  （`poc/settings-ui/src/model/assetBase.ts:31`，15 张）。这批 JPG 是本项目自己的产物，随 `.spmod` 分发；
  生成与打包细节见 `settings-ui-impl.md`。

---

## 4. 音视频/分析资源（不在 dist）

| 资源 | 位置 | 需要吗 |
|---|---|---|
| beat_this 权重 | 安装包内 `electron/analysis/` 模型路径（`modelPaths.cjs`） | 智能动感才需要；webview 跳过后所有样式正常渲染 |
| HTDemucs 鼓分离权重 | 同上 | 同上（`pendolo.drumhead` 仿真鼓面等） |
| FFmpeg / yt-dlp 等 | 安装包 `resources/bin`（受平台限制） | 不需要 |
| 封面/歌词缓存 | 用户数据目录 | 不需要，harness 自己传 `coverUrl`/`lines` |

---

## 5. 字体

- **无随包字体文件**（仓库和 dist 都没有 woff/ttf/otf）。
- `src/index.css:19-33` 仅两条 `@font-face`：`Folia Noto Serif SC` 400/500，`src` 指向
  `https://cdn.jsdmirror.cn/npm/@fontsource/noto-serif-sc@5.2.9/files/noto-serif-sc-chinese-simplified-{400,500}-normal.woff2`
  （OFL 字体，CDN 分发）。
- 字体栈（`src/utils/fontStacks.ts`）：
  - sans：`"Inter", "Noto Sans CJK SC", "Noto Sans JP", "Source Han Sans SC", "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif`
  - serif：`"獅尾四季春加糖SC", "Iowan Old Style", "Noto Serif CJK SC", …, Georgia, serif`
    （`SUGAR_SERIF_FAMILY` 只是名字，字体本身不随包，没装就回退系统宋体）
  - mono：`"IBM Plex Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", …, Consolas, monospace`
  - 字幕另有一套 `TRANSLATION_FONT_STACKS`（serif 里额外含 `"Folia Noto Serif SC"`）。
- 用户自定义字体：`src/services/customLyricsFont.ts` 接受 `.woff2/.woff/.ttf/.otf` 上传，存 IndexedDB；`FontPicker.tsx`。
- 字重 100–900 / step 10；歌词字号倍率 `clamp 0.85–1.4`；字幕字号独立倍率同范围（`subtitleFontSizes.ts`）。
- **离线/内嵌风险**：CDN 字体在无网或内网环境加载失败 → serif 样式回退系统宋体（观感差异可接受）。插件若要稳定，
  可把这两个 woff2 打进 WebView 资源并用同 family 名声明（OFL 允许，附 OFL 许可文本即可）。

---

## 6. 授权（AGPL-3.0）与合规约束

Folia 仓库根 `LICENSE` = **GNU AGPL-3.0**（项目版权见 `CONTRIBUTORS.md`）。这对 spw-folia 是硬约束：

1. **托管 / 改编 = 衍生作品**：把 Folia 的 `src/components/visualizer/**`（以及 i18n、styles、settings kit）打进
   插件再分发，插件整体必须按 **AGPL-3.0** 发布，并提供完整对应源码（含我们对 Folia 代码的修改）。
2. **网络服务也算分发**：AGPL §13 要求通过网络提供服务的用户也能拿到源码；插件若内置 WebView 加载本地打包的
   Folia 代码，同样算分发。
3. **必须保留**：版权声明、LICENSE 文件、文件头注释（如 `// Copyright (c) 2026 chthollyphile` 这类作者头，
   hanabi/lumiere 等文件有）。
4. **商标/名称**：AGPL 不授商标权；"Folia"名字/图标不应当作自己的品牌，插件名用 `spw-folia`，注明
   "Folia 可视化代码 © Folia 作者，AGPL-3.0"。
5. **素材来源**：§1 的截图/头像/表情/占位封面都是 Folia 项目素材（AGPL-3.0，随项目分发）；字体 **Noto Serif SC /
   Noto Sans = SIL OFL 1.1**（随 CDN 分发，自带授权），Inter = SIL OFL 1.1，獅尾四季春加糖SC 为第三方字体
   （未随包，使用前自行确认授权）。
6. 仓库根需有 `LICENSE`（AGPL-3.0 全文）+ NOTICE 类说明，列 Folia 版本（0.7.22）、来源 URL、修改点；设置页/关于页
   标注"基于 Folia（AGPL-3.0）"。**当前实际落地的是 `THIRD_PARTY_NOTICES.md` 与 `packaging/licenses/`，以它们为准。**

---

## 7. 重新抽取素材的命令

```bash
# 1) 解包安装包（路径按实际安装位置替换）
npx --yes @electron/asar extract "<Folia 安装目录>/resources/app.asar" <解包目录>

# 2) 官方截图来自上游仓库 img/，直接从 checkout 拷贝
cp <folia-major-main>/img/{visualizer.png,head2.png,1.png,preview-*} research/assets/screenshots/

# 3) 运行时位图素材
cp -r <解包目录>/dist/assets ./research/assets/folia/  # 按需挑 avatar/emo/cover

# 4) 注意：research/assets/ 在 .gitignore 内，不会入库；需要复现时按本节重跑
```

---

## 8. 证据索引

| 结论 | 证据 |
|---|---|
| 缩略图是实时渲染 | 上游 `README.md:83`；`src/components/visualizer/window/VisPlayground.tsx:519`；`src/components/visualizer/preview/LyricStylePicture.tsx` |
| 无随包字体 | 仓库 + 解包后的 `dist/` 全盘搜 `*.woff*/*.ttf/*.otf` = 0；`src/index.css:19-33` 仅 CDN @font-face |
| 头像/表情 glob 打包 | `src/components/visualizer/cappella/avatarImages.ts`、`emoImages.ts`、`customPacks.ts` |
| 占位封面 | 仓库根 `assets/placeholder_cover{,-2}.jpg`；visualizer import 路径 `../../../assets/placeholder_cover.jpg` |
| spw-folia 用静态 JPG | `poc/settings-ui/src/model/assetBase.ts:31`（`settings/thumbs/<mode>.jpg`） |
| AGPL-3.0 | 上游 `LICENSE` 首行；本仓库 `THIRD_PARTY_NOTICES.md` |
