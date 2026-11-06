# 上游 Folia 同步

本仓库内嵌的是上游 [`chthollyphile/folia-major`](https://github.com/chthollyphile/folia-major)
的生产 OBS 产物，当前对齐 **0.7.26**（见 `work/folia/folia-major-main/package.json`，
tag `v0.7.26`，commit `cc6226e4`），**17 种歌词样式**。插件版本 **v0.4.19**，支持 SPW **≥ 1.19.0**。

上一棵树（0.7.25）留在 `work/folia/folia-major-0725` 作对照，只读。要回答「这次上游到底改了什么」，
直接 `diff -rq` 两棵树，别凭印象。

上游发新版时按本文走。样式清单是否与上游一致由
`poc/settings-ui/scripts/check-style-sync.mjs` 说了算：它已挂在 `vite build` 上
（`vite.config.ts` 的 `spw-style-manifest-sync` 插件），构建会替你拦；上游源码树不在时自动跳过，
`SPW_STYLE_SYNC=off` 可显式关掉。**SSOT 永远是上游源码**，不是本仓库里的任何副本。

---

## 0. 流程总览

```bash
# 1) 换源码树（§1）
# 2) 构建上游 dist，逐条核对三个必查项（§2）
# 3) 构建设置岛 —— 样式清单闸门也在这里跑
cd poc/settings-ui && npx vite build
# 4) 逐条看报告 / 自动补齐
node scripts/check-style-sync.mjs --check
node scripts/check-style-sync.mjs --write     # 只补纯 id 列表，人判断项仍要手工改
# 5) tsc 不高于基线
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
# 6) 把每个 tab 点一遍（§5，这条挡白屏）
# 7) 收尾闸门全绿（§7）
```

---

## 1. 换上游源码树

上游源码放在 `work/folia/folia-major-main`（`work/` 已 gitignore，是本地检出，**只读**，
不要在里面对上游做定制——定制逻辑集中在 `Shim.js` / `Overlay.js` / `poc/settings-ui`）。

```bash
REF=v0.7.26
# 保留依赖目录：整棵树换掉后 node_modules 要重新搞，而它是从 poc/settings-ui 迁过来的
mv work/folia/folia-major-main/node_modules /tmp/folia-nm
rm -rf work/folia/folia-major-main
git clone --depth 1 --branch $REF https://github.com/chthollyphile/folia-major.git work/folia/folia-major-main
mv /tmp/folia-nm work/folia/folia-major-main/node_modules
ls work/folia/folia-major-main/node_modules | head    # 确认还在
```

`node_modules` 必须是**真实目录**：它含 `@paper-design`、`three`、`pixi.js` 等只在构建时才暴露的
包，丢了 `vite build` 直接解析失败。`vite.config.ts` 的 `ensureFoliaDeps()` 会用
`fs.symlinkSync(..., 'junction')` 在需要时补一条链接（junction 在本机可用）；但**本机 `ln -s`
会降级成目录拷贝**，手工建链接一律用 pwsh `New-Item -ItemType SymbolicLink`。

---

## 2. 构建上游 dist + 三个必查项

```bash
cd work/folia/folia-major-main
NODE_OPTIONS="--use-system-ca" npx vite build
```

### A. `NODE_OPTIONS="--use-system-ca"`（最容易静默出错的一条）

本机 Node 的 `fetch` 验证不了系统代理的 TLS 证书，不加这个会报
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。更糟的是，上游**某些数据文件是「联网失败就跳过」而不是
构建失败**——构建成功、产物能跑，只是少了数据。典型受害者是 `nebbia-strokes.json`（雾笺的
笔顺）：少了它雾笺照样出画面，但笔画顺序是错的，从「构建通过」根本看不出来。

**凡是在上游构建/打包链路里跑 node 脚本的地方，一律加这个环境变量。**

### B. CSS 真的编译了

上游 bundle 用 `@import "tailwindcss"`，这只有在上游源码树**带着** `postcss.config.js` +
`tailwind.config.js` 两个输入文件时才会编译。缺任一个，`vite build` 仍然退出 0，但 CSS 里只剩
未展开的 `@tailwind` 字面量——注入后设置页排版全塌、预览框塌成一条。

```bash
# 主 CSS 是 dist/assets/src-<hash>.css；其余是各入口的小 CSS，查它没意义
CSS=$(ls -S work/folia/folia-major-main/dist/assets/*.css | head -1)
echo "$CSS"                                   # 应为 …/assets/src-<hash>.css
wc -c "$CSS"                                  # 必须 > 200 KB（0.7.26 实测 227,655 B ≈ 222 KB）
grep -c '\.h-full{height:100%}' "$CSS"        # 必须 ≥ 1
grep -c '@tailwind' "$CSS"                    # 必须 = 0
```

> 必须用 `ls -S`（按体积）取最大的那个，不要用 `ls | head -1`——按字母序会取到
> `BravaisStage-*.css`（89 KB、`h-full` 为 0），看起来像构建坏了。这三条在
> `packaging/tools/stage-web.mjs` 里已是硬闸：staged CSS 里还剩 `@tailwind` 或缺
> `.h-full{height:100%}` 都会直接 throw。

### C. `dist/` 真的产出了

```bash
ls work/folia/folia-major-main/dist/index.html work/folia/folia-major-main/dist/assets/*.js | head
```

必须**整棵 dist 都发**，不能只拷冷启动路径上用到的文件：Folia 用动态 `import()` 懒加载每种样式的
chunk（`assets/VisualizerTempera-*.js` 之类），子集会让非默认样式黑屏。`stage-web.mjs` 会检查
确实存在 per-style lazy chunk 并整体拷贝（只排除 PWA/service worker 与 `*.bak`）。

`make-thumbs.mjs` 与宿主用的都是 staging 之后的 `poc/webview/dist/dist`，不是上游那份
`work/.../dist`——后者要先经 `packaging/tools/stage-web.mjs` 落成宿主形态。

---

## 3. 上游新增歌词样式时要改的地方

```bash
cd poc/settings-ui && node scripts/check-style-sync.mjs --check
```

闸门的 SSOT 是上游源码（`src/types/visualizerModes.ts` 的 `BUILTIN_VISUALIZER_MODES` + 各
`src/components/visualizer/<mode>/entry.tsx` 的 `mode`/`order`/`labelKey`/`beatEffects`）。
它核对的位置：

| # | 位置 | 自动? | 说明 |
|---|---|---|---|
| 1 | `poc/settings-ui/vite.config.ts` 的 `STYLE_MODES` | ✅ `--write` | `requireStyleThumbs` 硬闸的 id 列表 |
| 2 | `poc/settings-ui/scripts/make-thumbs.mjs` 的 `MODES` | ✅ `--write` | 缩略图采集列表 |
| 3 | `poc/settings-ui/scripts/make-style-grid.mjs` 的 `MODES` | ✅ `--write` | `docs/images/style-grid.png`（README 总览图） |
| 4 | `poc/webview/host/Overlay.js` 的 `MODES` | ✅ `--write` | 宿主占位 HUD（有设置岛时本来不注入） |
| 5 | `site/tools/capture-styles.mjs` 的 `ALL_MODES` | ✅ `--write` | 宣传站截图 |
| 6 | `site/tools/make-gallery.py` 的 `MODES` | ✅ `--write` | 宣传站画廊 |
| 7 | `poc/settings-ui/src/model/styles.tsx` 的 `STYLE_ENTRIES` | ❌ 人判断 | panel / thumb / beatEffects / ownFontSizeNoticeKey |
| 8 | `poc/settings-ui/src/model/settings.ts` 的 `StyleMode` 联合 | ❌ 人判断 | 加 `\| '<id>'` |
| 9 | 同上文件的 `STYLE_TUNING_KEYS` | ❌ 人判断 | 值 = 上游 `<mode>/tuning.ts` 的 `settingsKey` |
| 10 | 同上文件的 `STYLE_TUNING_DEFAULTS` | ❌ 人判断 | 默认值从 `<mode>/types.ts` import，不要自己编 |
| 11 | 同上文件的 `STYLE_MODE_SHELF_ORDER` | ❌ 人判断 | 顺序 = 各 entry 的 `order` 升序 |
| 12 | `poc/settings-ui/src/model/transparencyCompat.ts` 的 `STYLE_COMPAT` | ❌ 人判断 | 透明窗口能否用，见 §3.3 |
| 13 | `site/main.js` 的 `STYLES` | ❌ 人判断 | 要写 zh/en 名（闸门只校验 id 集合） |

`--write` 故意只碰**纯 id 列表**；`styles.tsx` / `settings.ts` / `transparencyCompat.ts` 要人判断
（用哪个 panel、透明分类、默认值从哪来），机器代劳会写出看着对实则错的 entry。所以 `--write`
之后脚本仍会 exit 1，直到人判断项也改完。

### 3.1 加 `STYLE_ENTRIES` entry：照抄上游，不要自己编

模板（以 `machi` 为例，字段全部来自上游 `machi/entry.tsx`）：

```ts
{
    mode: 'machi',
    order: 27,                                  // 上游 entry 的 order，别猜
    labelKey: 'ui.visualizerMachi',             // 上游 entry 的 labelKey
    labelFallback: '町景',                       // 上游多半写英文名，这里写中文
    thumb: stylePreviewUrl('machi'),            // 永远 = mode
    renderSettingsPanel: panel(MachiSettingsPanel),
    ownFontSizeNoticeKey: 'options.machiFontSizeAutoNotice',   // 上游没有就别写
    beatEffects: [ /* 逐字照抄上游 entry 的 beatEffects */ ],
},
```

- **`thumb` 永远等于 `mode`**（`stylePreviewUrl(mode)`）。写成别的 id 闸门会报。
- 面板取上游 `<mode>/<Mode>SettingsPanel`。多数是 default export，但 `settingsPanels.tsx` 里那批
  （Classic / Partita / Fume / Tilt / Claddagh / Cappella / Diorama）与 `MonetSettingsPanel` 是
  具名导出——**先看上游那个文件怎么导出的**。
- **上游没有 `renderSettingsPanel` 的样式就别写**：本地 entry 上留空，设置页会显示「这个样式没有参数」。
  0.7.26 里只有 `still` 是这样（心象在 0.7.26 才第一次有面板）。
- `beatEffects` 的 id 来自 `@/services/beatFx/beatEffects` 的 `BEAT_EFFECT_IDS`；上游没有的 id
  不要编。`source` 是 `'beats' | 'drums' | 'stems'`，`parts` 可选。**一个样式的 `beatEffects` 是数组，
  上游加一条就要跟着加一条**（0.7.26 的雾笺从一条变两条，漏加是 `check-style-sync --check` 唯一能
  抓到的差异类型之一），`parts` 里每个 key 与 nameKey 也要逐字照抄。
- 闸门**故意不校验 `labelFallback`**（上游写英文、本页要显示中文）。别为了「让闸门过」把中文名
  改回英文；也**不要从 `labelKey` 反推样式 id**（`cadenza` 的 key 是 `ui.visualizerCadenze`，
  上游拼写如此）。id 一律以 entry 的 `mode:` 字面量为准。

### 3.1.1 tuning 键变了怎么办

上游给某个样式的 tuning 加字段是常事（0.7.25 给凝彩加三个景深键、0.7.26 给 8 个样式加 `render`、
给经典/云阶加 `avoidOverlap`、给町景加 `simulatedBeat` 并把 `quality` 改成带 `revision` 的嵌套对象）。
本页**不需要手抄字段清单**：`model/settings.ts` 的 `STYLE_TUNING_DEFAULTS` 直接 import 上游的
`DEFAULT_*_TUNING`，`model/mergeTuning.ts` 又是 defaults-first 的合并，所以老树缺的键会自动补上。

两处仍然要人看：

- **嵌套对象**：`mergeTuning` 是 **shallow** 合并，扁平字段（`render`）没问题，嵌套字段
  （`machi.quality`）会整块采用树里的值。若上游同时给了读时迁移（`machi/machiTuning.ts` 的
  `normalizeMachiQuality` 看 `quality.revision` 判别老存档），**迁移是上游的活，不要在本页再写一遍**
  ——写第二遍会让同一个值被迁移两次。
- **面板上真的新增了控件吗**：只有面板渲染出来的字段才是用户能改的；上游在 tuning 里加字段不等于
  面板有那一行（0.7.26 的「渲染」组挂在 10 个样式的面板上，但不是每个有 `render` 的样式都有控件，
  见 §3.1.2）。

### 3.1.2 「渲染」组（分辨率 / 抗锯齿）挂在哪

0.7.26 的 #929 给歌词画布加了分辨率倍数与抗锯齿，分两层：

- **全局挡位** `lyricRenderQuality`（`{scale, antialias}`，默认 `{1, 'auto'}`）住在上游
  `useVisualizerSettingsStore`，控件在「动画与性能」页（`GraphicsPage.tsx` 的 `PERFORMANCE` 组）
  ——**这一页本插件不注入**。
- **每个样式一份覆盖** `render: {scale: 'global'|<倍数>, antialias: 'global'|'on'|'off'}`，写在样式
  tuning 里，由 `LyricRenderQualityRows` 渲染成「分辨率」「抗锯齿」两行。

哪些样式有这份覆盖、面板怎么显示，是两件事（都以上游源码为准）：

| 有 `render` 覆盖的 tuning | 面板渲染该组 | 面板只有分辨率一行 |
|---|---|---|
| `cadenza` `diorama` `fume` `hanabi` `lumiere` `monet` `nebbia` `pendolo` `sonnet` `tempera`（10 个） | `cadenza` `diorama` `fume` `hanabi` `lumiere` `monet` `nebbia` `pendolo` `sonnet` `tempera`（10 个） | `cadenza` `fume` `monet` `nebbia`（`antialias={false}`，2D canvas） |

町景走的是自己那套 `quality`（`renderScale` / `antialias` 可取 `'global'`，见
`machi/types.ts` 的 `MACHI_FOLLOW_GLOBAL`），**不经 `LyricRenderQualityRows`**，所以数「有 render
键的样式」时它不算在内。

凡是 `LyricRenderQualityRows` 渲染出来的行，都从 store 读全局挡位的当前值来写说明文字
（`formatLyricRenderScale(global.scale)` / `LYRIC_ANTIALIAS_LABEL_KEYS[global.antialias]`）。
**store 里缺 `lyricRenderQuality` 字段会让这两行抛错**——这就是 0.7.26 换树后必须给本地 store
补上该字段（含默认值 `{scale: 1, antialias: 'auto'}` 与 setter）的原因，与 §5 的必填 prop 是同一类坑。

### 3.2 货架顺序写错 = 整个设置页白屏

`styles.tsx` 底部有**模块加载期断言**：`STYLE_ENTRIES` 按 `order` 排出来的 mode 序列，必须与
`settings.ts` 的 `STYLE_MODE_SHELF_ORDER` 逐项相等，否则 `throw`。这个 throw 发生在模块加载期，
所以表现是**整个设置岛白屏**，不是某个 tab 出错。

新增样式时，`order` 与 `STYLE_MODE_SHELF_ORDER` 的插入位置必须同时改，且按 `order` 升序。

### 3.3 `STYLE_COMPAT` 怎么分类

判据：透明窗口 = 色键 `rgb(1,0,1)`（见 [`docs/live-transparency.md`](live-transparency.md)），
任何 `0 < alpha < 1` 的像素都会被合成到键色上。

- `native`：关掉 `background.transparent` 后屏幕上只剩字形/线稿（alpha 覆盖很小）。
- `tuned`：有大块半透明层，但**能靠该样式自己的 tuning 键去掉**（在 `transparentStyleTuning`
  里加 override，并注明去掉了哪一层、依据是什么）。
- `unsupported`：没有任何 tuning 能去掉（`monet` 的人像板就是样式本身；`lumiere` 在浅色主题下
  是大面积暗场）。

若上游 `entry.tsx` 里是 `background: false`（自己画整屏），基本就是 `unsupported`：整屏场景的
氛围/雾/辉光/反射天然半透明，色键下必然糊成一片，而且没有哪个 tuning 键能「去掉场景」。
**没实测就在注释里写明「未实测」**，不要写成已测量。

`background` 也可以是一个**函数**（0.7.26 的雾笺就是这么写的：按 tuning 的「窗外」与页面透明状态
决定画不画共用背景）。这种情况下判据要看「最坏的运行态」而不是声明形状：雾笺的窗外街景照样是整屏
场景，所以仍是 `unsupported`；但如果哪个样式靠这个函数能在某个设置下退回「只在共用背景上画字」，
那它可能是 `tuned`——去读那个函数，不要只看它是不是 `false`。
`background.ts` 的 `STYLE_COMPAT` 注释里如果写着「`background: false`」作为依据，函数化之后那句话
就过期了，顺手改掉。

---

## 4. 缩略图重采

```bash
cd poc/settings-ui
npm run thumbs                 # 只补缺的
npm run thumbs -- --force      # 全部重采（上游改了某个样式的观感时必须这样）
npm run thumbs -- --only=machi,nebbia   # 只重采指定样式
node scripts/make-style-grid.mjs        # 重出 docs/images/style-grid.png
```

依赖 **staged bundle** `poc/webview/dist/dist` 与宿主 exe `poc/webview/host/build/spw-folia-host.exe`
（缺一就 throw），产物是 `public/thumbs/<mode>.jpg`（1440×900，q82）。`public/thumbs` 是**构建
输入**、被 gitignore，所以换一台机器必须先跑一遍；`stage-web.mjs` 会因为缺图直接 throw（表现是
设置页的破图图标）。

### 4.1 截图时机是标定出来的，不是拍脑袋设的

**不要用 `--shot-at`。** 它量的是宿主 tick 时钟，不是歌词时间轴：宿主收不到插件的 `state` 时走
自由运行分支，而页面要等导航完成、React 挂载、渲染器初始化、开场标题卡动画走完——实机时钟和墙钟
对不上，且每次漂移量不同。实测 `--shot-at 6500` 与 `--shot-at 13000` 拍到的是同一张标题卡，
所以「把 6500 改成 9000」这种线性外推是错的。

`make-thumbs.mjs` 的做法是**不猜时间**：

1. 在 `--keep-alive` 下按 10 Hz 往宿主 stdin 发 `{t:"state",posMs}`，把播放位置**钉**在已知
   的 posMs（`ApplyState` 收到新鲜 state 就走锚点分支）。state 超过 500 ms 视为过期并回落到自由
   运行，**所以必须持续重发**。
2. posMs 取自 `poc/webview/host/DefaultConfig.json` 自己的歌词时间轴，每行取 **78%** 处
   （词全部落位、还没开始淡出、下一行还暗着）。demo 曲目/歌词改了，截图点自动跟着走。不同样式
   轮换不同歌词行，免得 17 张图全是同一句。
3. 多候选 + 打分：不同样式的歌词可见窗口不一样，同一位置也会时有时无。所以按「多个歌词行 ×
   多帧」采样，再用下面的墨量分数挑最好的一张。
4. 截图前用 CSS 硬隐藏 spw 自己的 chrome（`[data-spw-chrome]`、`.spw-playback*`）——它的 idle
   计时器是个竞态，不能指望它自己收起来。

### 4.2 「这张图有没有拍到歌词」用腐蚀后墨量判断

朴素亮像素数会被**五线谱**骗：classic / partita / pendolo / cappella / diorama / monet 都画谱线 +
音符头，亮度和真歌词一样高，但一个字都没有。判字形靠**笔画粗细**：1–2 px 的谱线过一遍 9×9 腐蚀
就没了，大号歌词的粗笔画还在。打分方式是「取中间竖带 → 相对本帧中位数取亮 → 9×9 腐蚀 → 计数」。

中间竖带（宽 28%–72%、高 28%–74%）也有讲究：歌词在画面中间，谱线几乎横贯全宽，取全宽会被谱线
主导。脚本会把每张图的 `ink=` 分数打出来，**低于 0.05 大概就是没歌词**：

```bash
cd poc/settings-ui && npm run thumbs -- --force 2>&1 | grep "ink="
```

### 4.3 样式固有差异（不是时机问题，别再追）

`classic` `cadenza` `claddagh` `cappella` `pendolo` `monet` 这 6 个样式走的是「先画谱线、歌词再压
上去」那类渲染路径，歌词层出现得更晚、更容易在采样窗口里错过。当前处置是**接受现状**，靠 4.1 的
多候选采样尽量捞到有歌词的帧。真要彻底解决，方向是改 demo 歌词时间轴（让某一行持续更久、或歌词
更密），而不是继续调时间点。

### 4.4 重采后必须逐张肉眼看

脚本「跑成功」不等于图能用——上面所有坑都是这么发现的。17 张必须**逐张**核对，标准是「一眼能
认出是哪个样式，且至少有一行清晰可读的歌词」（`still` 这类极简样式例外）。只看 `ink=` 分数不够：
分数高但拍到的是错行、或画面糊掉，脚本判断不出来。

拼图脚本是一次性的本地核对工具，不必入库；把 `public/thumbs/<mode>.jpg` 按货架顺序拼成网格、
每格标上 `<序号>. <mode>` 即可，看完整批删掉。带 Pillow 的 python（本机 DSH 运行时那个）就够用。

### 4.5 站点图从同一批缩略图派生

`site/assets/styles/*.jpg`（960×540 q85）与 `site/assets/styles/large/*.jpg`（1600×900 q82）是
README 与宣传站用的同一批画面，**定稿后必须同步**，否则宣传站和设置页不一致。直接从
`public/thumbs` 派生：两者同为 16:10，居中裁切后缩放即可（`Image.LANCZOS`，quality 85 / 82，
`optimize=True, progressive=True`）。

> 不要用 `site/tools/capture-styles.mjs` 重采一遍：它要 Playwright + 起一个 server，采出来又是
> 另一套画面，两边永远对不齐。它的 id 列表由 `check-style-sync.mjs` 校验，保留即可。

---

## 5. 构建后必须把每个 tab 点一遍

上游给复用组件加一个**必填 prop** 是这类白屏的标准成因：0.7.25 给
`VisPlaygroundSettingsPanel` 加了 `subtitleOverlayLayout`，而上游组件内部
`getSubtitleOverlayRows(layout)` 直接 `layout.split('+')`、**没有默认值**——本页只要漏传这个
prop，点「字幕」tab 就是一个 `TypeError`。设置岛**没有 ErrorBoundary**，整个岛当场白屏。

这条现在是由「传进去」而不是「剥掉」来满足的：本页 store 持有 `subtitle.subtitleOverlayLayout`
（默认 `DEFAULT_SUBTITLE_OVERLAY_LAYOUT`），`App.tsx` 把它和 `onSubtitleOverlayLayoutChange`
一起传进面板，并随 `ObsBrowserSourceConfig` 下发。**下次上游再加必填 prop 时照这个方向做**：
把状态补进 store、接上回调、发布出去；只有「本页确实无法提供数据源」的控件才走
`SETTINGS_SURGERY` 剥离（判据见 [`docs/known-inert-settings.md`](known-inert-settings.md)）。

自动化替代（临时脚本放 `.scratch/`，用完删）：起 `npx vite dev --port 18090`，
打开 `http://localhost:18090/dev.html`，依次点「歌词动画 / 背景 / 字体 / 字幕」四个
`[role="tab"]`，每次点击后断言 `.st-window` 仍存在——不存在就是白屏（多半是必填 prop 缺失）。
每个 tab 里再点开几个样式的设置面板，覆盖到新样式自己的 panel（心象、雾笺、町景各开一次：
心象只该有「渲染」一组，雾笺该有「窗外 / 玻璃 / 景物 / 渲染」等组，町景该有它的质量三档）。

`vite.config.ts` 的 `SETTINGS_SURGERY` 用 marker 定位要摘掉的上游控件。**marker 失配会直接
throw 并指名是哪个 marker**——那是在告诉你「上游改了这段源码，去看新源码重写 marker」，
不是要你放宽检查。反过来，**上游给某个控件改了措辞或结构、而本页其实已经能支持它时，
删掉那条 surgery 而不是改 marker 去继续剥**。

---

## 6. 合规检查

新增样式如果带第三方数据/字体/图像，补 `THIRD_PARTY_NOTICES.md` 与
`packaging/licenses-src/THIRD-PARTY.md`。雾笺的笔顺数据（`nebbia-strokes.json`）就是这类。
许可与不随包分发的组件见 [`docs/licensing.md`](licensing.md)。

---

## 7. 收尾闸门（全部必须绿）

```bash
cd poc/settings-ui
node scripts/check-style-sync.mjs --check                    # 样式清单与上游一致
npx vite build                                              # thumbs / surgery marker / CSS 都在这过
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS" # 不高于基线（0.7.26 树上基线 311）

cd <repo>
node packaging/tools/stage-web.mjs                          # staging（含 splash / thumbs / CSS 硬闸）
node packaging/tools/verify-all.mjs                         # 打包后总门禁
```

`vite build` 与 `stage-web.mjs` 的失败信息都写明了「为什么」和「下一步跑什么」，照做即可。

---

## 8. 已知的既有噪声（不是你的锅）

- `npx tsc --noEmit` 会报约 **311** 个错误，**全部**来自 `work/` 里的上游源码（Electron/Node
  类型缺失、`@/` 别名解析）与本页既有代码。基线会变（换上游树就会变：0.7.25 上是 297，换到
  0.7.26 是 311），**动手前先自己跑一次记下数字，只要不新增就行**。不要顺手去「修」那些
  `@/...` 的 Cannot find module。
- `vite build` 会警告部分 chunk > 500 kB（上游 OBS bundle 的既有形态）。

---

## 9. 常见误判

- **「闸门报错说明我改坏了」**：不一定。`check-style-sync --check` 报错只是说「本地副本与上游不
  一致」，可能是上游刚加了样式你还没跟。先读它「上游有、本地缺」那一行。**它只比对
  `STYLE_ENTRIES` 的 order / labelKey / thumb / beatEffects、`StyleMode`、`STYLE_MODE_SHELF_ORDER`**，
  面板选型、`labelFallback`、透明分类都不在校验范围里——闸门绿了不等于这几项对。
- **「`--write` 为什么只改了几个文件」**：故意的，见 §3 的表。
- **「`cadenza` 的 labelKey 少个 z，顺手修一下」**：是上游拼写如此，**不要改**，也不要从 labelKey
  反推样式 id。
- **「上游加了 `modKeys` / `modPatch`，本页要不要跟」**：不要。那是 Folium mod 的读写白名单
  （`folium.visualizer.setTuning`），本页不渲染 mod，`folium` 桩是空 registry；上游 0.7.26 给
  15 个 tuning 都加了这一块，与本页无关，**不要去补**。
- **「上游 tuning 多了 `render` / `quality.revision`，本页要不要写迁移」**：不用写代码，但要确认
  两件事：`STYLE_TUNING_DEFAULTS` 是从上游 import 的（自动跟上），以及 `mergeTuning.ts` 的
  shallow 合并对**嵌套**字段不会做深合并——`render` 是扁平对象，没问题；`machi.quality` 是嵌套
  对象，老树里的 `quality` 会整块胜出，`revision` / 跟随全局由上游自己的
  `normalizeMachiQuality` 迁移读出来（见 §3.1 的注）。

---

## 10. 上游帧率限流器的缺陷（结论仍然有效）

### 10.1 根因

`work/folia/folia-major-main/src/utils/frameRateLimiter.ts`：

```ts
const intervalMs = 1000 / frameRate - FRAME_INTERVAL_TOLERANCE_MS;   // tol = 1
return lastProcessedTimestampMs === 0 || timestampMs - lastProcessedTimestampMs >= intervalMs;
```

**根因是那个 `- 1 ms` 容差**：它让所需帧间隔刚好比目标 vsync 略短一点点，于是在整数个 vsync 上
永远「差一点点」，退化成「每 N 帧放行一次」的下一档。所以这**不是某一档的特例**——在非
60/120 Hz 屏幕上**每个档位都会偏**。

### 10.2 实测与由此产生的约束

按 `intervalMs = 1000/target - 1`、取 `ceil(need/vsync)` 帧放行一次建模：

| 显示器 | vsync | 120 档 → 实际 | 90 档 → 实际 | 60 档 → 实际 |
| --- | --- | --- | --- | --- |
| 60 Hz | 16.67 ms | 60 | 60 | 60 |
| **120 Hz（本机实测）** | **8.33 ms** | **120** | **60** | **60** |
| 144 Hz | 6.94 ms | **72** | **72** | **48** |
| 165 Hz | 6.06 ms | **83** | **83** | **55** |

本机（120 Hz）实测复核：`off` → 120、`120` → 120、`90` → 60、`60` → 60，与建模一致。

由此产生的约束：

- 上游 UI 里的「120 / 90 / 60」只是**标称值**，实际值随显示器刷新率变化；`off`（无限制）是唯一
  「跟随显示器」的档位。
- **不要在本地截断/改写任何档位值**——那会让「选了 90」和「选了 60」在上游看来不同，也会掩盖
  120 档在 144 Hz 屏上只有 72 这个事实。
- 因此本仓库**不把这个有缺陷的链路暴露给用户**：配置页的帧率项在 v0.4.10 整条删除（配置项 +
  Kotlin 读取 + 宿主 cap 注入 + Shim 写 localStorage）。宿主仍**接受并忽略**旧的 `--frame-rate`
  参数，只为让带旧参数的插件包照常 spawn；`Shim.js` 在每次文档创建时清掉旧键
  `visualizer_frame_rate`（上游的 `installGlobalVisualizerFrameRateLimiter()` 启动时会读它，只要
  残留任何非 `off` 值，升级后的页面就会被**永久静默限流**）。清掉的原值随 `ready` 的
  `frameRateCleared` 字段上报。
- 判断「限流器装没装」要上游的 `__foliaNativeRequestAnimationFrame`，**不要只看 fps 数字**——
  显示器刷新率是硬天花板，`off` 与 `120` 在 120 Hz 屏上 fps 完全相同。宿主 `--fps-log` 的
  `capped` 字段就是这个标记。
- 若上游将来修好这个容差，与本仓库无关（设置已不存在）；若要重加，先按上表复核实际值。

被删除的设置本身（UI 类型、Kotlin 归一化、删除理由）记录在
[`docs/known-inert-settings.md`](known-inert-settings.md) 与
[`docs/settings-ui-impl.md`](settings-ui-impl.md)，这里不再重复。

---

## 11. SPW 宿主升级后的反射回归

SPW 是 R8 混淆构建，**每次版本构建都会重新生成混淆的类名与方法名**，同一版本的 Windows /
Linux 构建之间也不同。插件里任何写死的混淆标识符都会在下一次播放器更新时变成
`ClassNotFoundException` / `NoSuchMethodException`。定位策略（分层解析、以结构而非名字为准）与
菜单/hook 侧的完整说明在 [`docs/hook-target.md`](hook-target.md) 与
[`docs/lessons.md`](lessons.md) §2；本节只讲**升级后怎么验证**。

播放队列模型由 `HostMemberResolver.kt` 解析，两条与名字无关的策略：

1. **Kotlin `@Metadata` 的属性名 + 声明顺序**（首选）。R8 默认保留 metadata，里面仍是源级属性名
   `mode / normalQueue / normalIndex / randomQueue / randomIndex`，再用**字段表顺序**把成员对上去。
2. **结构形状**（metadata 被剥掉时）：返回类型 + 位置关系。`listIntPairs` 只认
   「`(List, int)` 成对且顺序与字段表一致」，对不上就返回空、让调用方走兜底，**绝不猜**。
3. 写死的旧 id 只作最后兜底。

两个可复跑脚本在 `poc/webview/host/repro/`（头部注释含完整用法与期望输出）：

| 脚本 | 作用 | 何时跑 |
| --- | --- | --- |
| `VerifyResolver2.java <宿主 jar>` | 对**真实宿主 bytecode** 断言：metadata 顺序、五个访问器全部解析且 normal ≠ random、类型正确、写死名与 metadata 一致、队列元素可定位、「源级 getter 名在混淆类上不存在」的负向检查 | **每次 SPW 升级后必跑**；任何 FAIL 说明解析退化到了更低的兜底层 |
| `RenameSim.java` | 负向：模拟写死名与访问器名全被改名，断言解析器**拒绝猜**而不是静默错配 | 改动 `HostMemberResolver` 后跑 |

宿主 jar 是 polyglot ZIP（伪装成 `app/ffmpeg-x64.dll`，约 111 MB / 42k entries），**路径必须
传参**（Steam 版 / MSIX 版 / 自定义路径都不同），不要写死。

```bash
JH="C:/Program Files/Java/jdk-25.0.2"
KS=$(find ~/.gradle -name 'kotlin-stdlib-2*.jar' | head -1)
CP="spw-folia/build/classes/kotlin/main;spw-folia/build/classes/java/main;$KS"
"$JH/bin/javac" -cp "$CP" -d poc/webview/host/repro/out poc/webview/host/repro/*.java
"$JH/bin/java" -cp "poc/webview/host/repro/out;$CP" VerifyResolver2 "<宿主 jar>"
"$JH/bin/java" -cp "poc/webview/host/repro/out;$CP" RenameSim
```

期望：`VerifyResolver2` 输出 `10/10 passed` 且 exit 0；`RenameSim` 输出一行 `PASS` 且 exit 0。

**验证边界（别误读）**：这两个脚本只覆盖**反射层**对真实宿主 bytecode 的正确性。仓库里**没有**
能驱动一次真实 SPW 播放队列的端到端手段（插件无法在本仓库里装进运行中的 SPW），所以**队列 UI
的渲染层没有真机验证覆盖**——那部分依赖真机手动点一遍。

---

## 12. 升级后的版本号核对

一次完整的上游升级会牵动这几处，改完逐条对：

| 位置 | 期望 |
| --- | --- |
| `work/folia/folia-major-main/package.json` 的 `version` | 目标上游版本（当前 `0.7.26`） |
| `spw-folia/src/main/kotlin/dev/spw/folia/FoliaPlugin.kt` 的 `PLUGIN_VERSION` | 插件版本（当前 `0.4.19`） |
| `spw-folia/build.gradle.kts` 的 `version` 与 `PluginVersion` | 同上，三处必须一致（`verify-all.mjs` 会查） |
| `poc/settings-ui/src/model/settings.ts` 的 `STYLE_MODE_SHELF_ORDER` | 17 项，顺序 = 上游 `order` 升序 |
| `packaging/licenses-src/NOTICE.md` / `SOURCE-OFFER.md` / `THIRD-PARTY.md` 的上游 tag、commit、样式数 | 见 [`docs/licensing.md`](licensing.md) §4；改真源再 `bash packaging/build-package.sh` 同步 `packaging/licenses/` |
| 仓库根 `THIRD_PARTY_NOTICES.md` 的版本列 | 同上 |
| `docs/architecture.md` 开头的版本句、`docs/folia-spec/README.md` 的「事实基线」行 | 同上 |

样式数可以用一条命令复核：`node poc/settings-ui/scripts/check-style-sync.mjs --check` 会打印
「上游 N 个样式」并逐项比对本地清单。
