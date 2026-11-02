# 上游 Folia 升级跟进 checklist

上游（`chthollyphile/folia-major`）发新版时照这份清单走。每条都是**踩过的坑**，不是理论步骤。

配套闸门：`poc/settings-ui/scripts/check-style-sync.mjs` —— 样式清单是否与上游一致，它说了算。
它已挂在 `vite build` 上（`vite.config.ts` 的 `spw-style-manifest-sync` 插件），所以**构建会替你拦**。
上游源码树不在时自动跳过；`SPW_STYLE_SYNC=off` 可显式关掉。

---

## 0. 一句话流程

```bash
# 1) 换源码树（见 §1）
# 2) 构建上游 dist（见 §2，含三个必查项）
cd poc/settings-ui
# 3) 构建设置岛 —— 样式清单闸门 spw-style-manifest-sync 也在这里跑
npx vite build                                # 失败会指名道姓，别忽略
# 4) 逐条看报告 / 自动补齐（build 已跑过一次，这两步是为了 --write 修机器能修的部分）
node scripts/check-style-sync.mjs --check
node scripts/check-style-sync.mjs --write     # 纯 id 列表自动补齐（改完仍需人判断项）
# 5) tsc 不高于基线
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"
# 6) 开机点一遍每个 tab（见 §5，这条能挡住白屏）
```

---

## 1. 换源码树

上游源码放在 `work/folia/folia-major-main`（`/work/` 已 gitignore，是本地检出，**只读**）。

```bash
# 目标版本
REF=v0.7.25

# 保留依赖目录：整棵树换掉后 node_modules 得重新搞，而它是从 poc/settings-ui 迁过来的
mv work/folia/folia-major-main/node_modules /tmp/folia-nm
rm -rf work/folia/folia-major-main
git clone --depth 1 --branch $REF https://github.com/chthollyphile/folia-major.git work/folia/folia-major-main
mv /tmp/folia-nm work/folia/folia-major-main/node_modules
```

**坑**
- `work/folia/folia-major-main/node_modules` 是必需的真实目录（不是符号链接降级来的）。它由
  `poc/settings-ui/node_modules` 迁移而来，含 `@paper-design` 等只在构建时才暴露的包。整个换树时
  一定要先搬走再搬回来；丢了的话 `vite build` 会在解析 `three` / `pixi.js` 时报错。
- 本机 `ln -s` 会**降级成目录拷贝**。需要真符号链接时用 pwsh `New-Item -ItemType SymbolicLink`。
  （`vite.config.ts` 的 `ensureFoliaDeps()` 用 `fs.symlinkSync(..., 'junction')`，那条没问题。）
- 换完检查 `node_modules` 还在：`ls work/folia/folia-major-main/node_modules | head`。

## 2. 构建上游 dist + 三个必查项

```bash
cd work/folia/folia-major-main
NODE_OPTIONS="--use-system-ca" npx vite build
```

### 必查项 A：`NODE_OPTIONS="--use-system-ca"`（最容易静默出错的一条）

本机 Node 的 `fetch`**验证不了系统代理的 TLS 证书**，不加这个会报
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`。更糟的是：**某些数据文件是「联网失败就跳过」而不是失败**，
于是构建**成功**、产物**能跑**，只是少了数据。

典型受害者：`nebbia-strokes.json`（雾笺的笔顺数据）。少了它，雾笺照样出画面，但笔画顺序是错的 ——
这种 bug 极难从「构建通过」发现。

> 凡是上游构建/打包链路里跑 node 脚本的地方，一律加 `NODE_OPTIONS="--use-system-ca"`。

### 必查项 B：CSS 真的编译了（P4-14 静默失败）

上游 bundle 用 `@import "tailwindcss"`，这只有在上游源码树**带着** `postcss.config.js` +
`tailwind.config.js` 两个输入文件时才会编译。缺了任意一个，`vite build` **仍然成功**，但 CSS 里
只有未展开的 `@tailwind` 字面量 —— 注入后整个设置页排版全塌。

三条一起查（`packaging/tools/stage-web.mjs` 里已做成硬闸）：

```bash
# 主 CSS 是 dist/assets/src-<hash>.css（shelves 级的大表）；其余是各入口的小 CSS，查它没意义。
CSS=$(ls -S work/folia/folia-major-main/dist/assets/*.css | head -1)
echo "$CSS"                                    # 应为 …/assets/src-<hash>.css
wc -c "$CSS"                                   # 必须 > 200 KB（0.7.25 约 249 KB）
grep -c '\.h-full{height:100%}' "$CSS"         # 必须 ≥ 1
grep -c '@tailwind' "$CSS"                     # 必须 = 0
```

> 别用 `ls ... | head -1`（按字母序，会取到 `BravaisStage-*.css`，89 KB、`h-full` 为 0，
> 看起来像是构建坏了）。用 `ls -S` 按体积取最大那个。

### 必查项 C：`dist/` 真的产出了

```bash
ls work/folia/folia-major-main/dist/index.html work/folia/folia-major-main/dist/assets/*.js | head
```

`poc/settings-ui/scripts/make-thumbs.mjs` 与宿主都用这份 dist，没有它后面全部没法验证。

## 3. 上游新增歌词样式时，要改的地方

**先跑闸门，它会告诉你缺哪些**：

```bash
cd poc/settings-ui && node scripts/check-style-sync.mjs --check
```

闸门的 SSOT 是**上游源码**（`src/types/visualizerModes.ts` 的 `BUILTIN_VISUALIZER_MODES` +
各 `src/components/visualizer/<mode>/entry.tsx`），不是本仓库里的任何一份副本。它核对的位置：

| # | 位置 | 能否自动 | 说明 |
|---|---|---|---|
| 1 | `vite.config.ts` 的 `STYLE_MODES` | ✅ `--write` | `requireStyleThumbs` 硬闸的 id 列表 |
| 2 | `scripts/make-thumbs.mjs` 的 `MODES` | ✅ `--write` | 缩略图采集列表 |
| 3 | `scripts/make-style-grid.mjs` 的 `MODES` | ✅ `--write` | `docs/images/style-grid.png`（README 那张总览图） |
| 4 | `poc/webview/host/Overlay.js` 的 `MODES` | ✅ `--write` | 宿主占位 HUD（`--no-overlay` 可关） |
| 5 | `site/tools/capture-styles.mjs` 的 `ALL_MODES` | ✅ `--write` | 宣传站截图 |
| 6 | `site/tools/make-gallery.py` 的 `MODES` | ✅ `--write` | 宣传站画廊 |
| 7 | `src/model/styles.tsx` 的 `STYLE_ENTRIES` | ❌ 人判断 | 要定 settings panel / thumb / beatEffects / ownFontSizeNoticeKey |
| 8 | `src/model/settings.ts` 的 `StyleMode` 联合 | ❌ 人判断 | 加 `\| '<id>'` |
| 9 | `src/model/settings.ts` 的 `STYLE_TUNING_KEYS` | ❌ 人判断 | 值 = 上游 `<mode>/tuning.ts` 的 `settingsKey` |
| 10 | `src/model/settings.ts` 的 `STYLE_TUNING_DEFAULTS` | ❌ 人判断 | 新样式的默认值通常**自己带**在 `<mode>/types.ts`，从那里 import |
| 11 | `src/model/settings.ts` 的 `STYLE_MODE_SHELF_ORDER` | ❌ 人判断 | 顺序 = 各 entry 的 `order` 升序 |
| 12 | `src/model/transparencyCompat.ts` 的 `STYLE_COMPAT` | ❌ 人判断 | 透明窗口能否用，见 §3.3 |
| 13 | `site/main.js` 的 `STYLES` | ❌ 人判断 | 要写 zh/en 名 |

```bash
# 机械的 6 处一次补齐
node scripts/check-style-sync.mjs --write
# 剩下的人判断项会继续报出来，逐条改完再跑 --check 到 exit 0
node scripts/check-style-sync.mjs --check
```

### 3.1 加 `STYLE_ENTRIES` entry：照抄上游，不要自己编

模板（以 0.7.25 的 machi 为例，**全部来自上游 `machi/entry.tsx`**）：

```ts
{
    mode: 'machi',
    order: 27,                                   // 上游 entry 的 order，别猜
    labelKey: 'ui.visualizerMachi',              // 上游 entry 的 labelKey
    labelFallback: '町景',                        // 上游 labelFallback 或中文名
    thumb: stylePreviewUrl('machi'),             // 一律 = mode
    renderSettingsPanel: panel(MachiSettingsPanel),
    ownFontSizeNoticeKey: 'options.machiFontSizeAutoNotice',   // 上游没有就别写
    beatEffects: [ /* 逐字照抄上游 entry 的 beatEffects */ ],
},
```

要点：
- **`thumb` 永远等于 `mode`**（`stylePreviewUrl(mode)`）。写成别的 id 闸门会报。
- 面板取上游 `<mode>/<Mode>SettingsPanel`。多数是 default export，
  但 `settingsPanels.tsx` 里那批（Classic/Partita/Fume/Tilt/Claddagh/Cappella/Diorama）是具名导出，
  `MonetSettingsPanel` 也是具名的 —— **先看上游那个文件怎么导出的**。
- `beatEffects` 的 id 来自 `@/services/beatFx/beatEffects` 的 `BEAT_EFFECT_IDS`。上游没有的 id
  **不要编**；`source` 是 `'beats' | 'drums' | 'stems'`，`parts` 是可选的（雾笺的 `rain`/`bump`）。
- **`labelFallback` 上游常写英文**（`Tempera` / `Claddagh` / `Still`…），本页要显示中文名。
  闸门因此**故意不校验 labelFallback** —— 别为了「让闸门过」把中文名改回英文。

### 3.2 货架顺序会直接决定会不会白屏

`styles.tsx` 底部有**模块加载期断言**：`STYLE_ENTRIES` 按 `order` 排出来的 mode 序列，必须与
`settings.ts` 的 `STYLE_MODE_SHELF_ORDER` **逐项相等**，否则 `throw`。这个 throw 发生在模块加载期，
所以表现是**整个设置页白屏**，不是某个 tab 出错。

所以新增样式时，`order` 与 `STYLE_MODE_SHELF_ORDER` 的插入位置必须同时改，且按 order 升序。

### 3.3 `STYLE_COMPAT` 怎么分类

判据：透明窗口 = **色键 `rgb(255,0,255)`**，任何 alpha < 1 的像素都会和品红混合 → 粉雾。

- `native`：关掉 `background.transparent` 后屏幕上只剩字形/线稿（alpha 覆盖 < 24%）。
- `tuned`：有大块半透明层，但**能靠该样式自己的 tuning 键去掉**（在 `transparentStyleTuning` 里加
  override，写明去掉了哪一层、依据是什么）。
- `unsupported`：没有任何 tuning 能去掉（monet 的人像板就是样式本身；lumiere 在浅色主题下 94% 暗场）。

新增样式若 `entry.tsx` 里是 `background: false`（自己画整屏），基本就是 `unsupported`：
整屏场景的氛围/雾/辉光/反射天然半透明，色键下必然粉雾，而且没有哪个 tuning 键能「去掉场景」
（去掉了就没这个样式了）。**没实测就在注释里写明「未实测」**，别写成已测量。

## 4. 缩略图重采

```bash
cd poc/settings-ui && npm run thumbs            # 只补缺的
cd poc/settings-ui && npm run thumbs -- --force # 全部重采（上游渲染器改了样子时用）
```

- 依赖 **staged bundle** `poc/webview/dist/dist`（不是上游的 `work/.../dist` —— 那份要先经
  `packaging/tools/stage-web.mjs` 落成宿主用的形态）与宿主 exe
  `poc/webview/host/build/spw-folia-host.exe`，缺一就 throw。
- 输出 `public/thumbs/<mode>.jpg`（1440×900，q82），`public/thumbs` 是**构建输入**、被 gitignore。
- 上游**改了某个样式的观感**时一定要 `--force` 重采，否则货架还是旧图（用户看到的第一印象）。

### 4.1 截图时机是**标定出来的**，不是随便设的

**别用 `--shot-at`。** 它量的是宿主 tick 时钟，不是歌词时间轴：宿主收不到插件的
`{t:"state"}` 时走 free-running 分支（`HostForm.PostState` 的 `freePosMs += elapsed`，日志里
`statesReceived=0`），而页面要等 nav-done 之后 React 挂载 + 渲染器初始化 + 开场标题卡动画，
实机时钟和墙钟对不上，且**每次运行漂移量不同**。实测：`--shot-at 6500` 与 `--shot-at 13000`
拍到的是同一张「Spike Track」标题卡 —— 所以「把 6500 改成 9000」这种线性外推是错的。

`make-thumbs.mjs` 现在**不猜时间**，做法是：
1. 在 `--keep-alive` 下按 10 Hz 往宿主 stdin 发 `{t:"state", posMs}`，把播放位置**钉**在
   一个已知的 posMs 上（`ApplyState` 收到 fresh state 就走锚点分支）。`state` 超过 500 ms 视为
   过期并回落到 free-running，**所以必须持续重发**。
2. posMs 取自 `DefaultConfig.json` 自己的歌词时间轴（每行 78% 处：词全部落位、还没开始淡出）。
   这样 demo 曲目/歌词改了，截图点自动跟着走。
3. 截图前用 CSS 把 spw 自己的播放器 chrome 摘掉（`.spw-playback*`、`[data-spw-chrome]`）——
   它靠 idle 计时器自己隐藏（`PlaybackBar.tsx` IDLE_HIDE_MS = 2600），而那是竞态。
4. **多候选 + 打分**：不同样式的歌词可见窗口不一样，同一位置同一时刻也会时有时无。所以按多个
   歌词行 × 多帧采样，再用「字形墨量」打分挑最好的一张。

### 4.2 歌词是否拍到了，用**腐蚀后墨量**判断（不要用朴素亮像素）

朴素亮像素数会被**五线谱**骗：classic / partita / pendolo / cappella / diorama / monet 都会画
谱线 + 音符头，亮度和真歌词一样高，但一个字都没有。判别字形靠**笔画粗细**：
1–2 px 的谱线/细线过一遍 9×9 腐蚀就没了，大号歌词的粗笔画还在。所以打分是
「取中间竖带 → 相对本帧中位数取亮 → 9×9 腐蚀 → 计数」。实测真歌词帧是纯谱线帧的 5–8 倍，区分度够。

> 中间竖带（宽 28%–72%、高 28%–74%）也有讲究：歌词在画面中间，谱线几乎横贯全宽，取全宽会被谱线主导。

### 4.3 已知的**样式固有差异**（不是时机问题，别再追）

**这 6 个样式在 demo 曲目下很容易只拍到谱线/空画面**：`classic` `cadenza` `claddagh`
`cappella` `pendolo` `monet`。它们走的是「先画谱线，歌词再压上去」那一类渲染路径，歌词层比别的
样式更晚出现、更容易在采样窗口里错过。

当前的处置：**接受现状**，靠 4.1 的多候选采样尽量捞到有歌词的帧。`make-thumbs.mjs` 会把每张图的
`ink=` 分数打出来，**低于 0.05 就说明这张大概没歌词**：

```bash
cd poc/settings-ui && npm run thumbs -- --force 2>&1 | grep "ink="
```

真要彻底解决，方向是**改 demo 歌词时间轴**（让某一行持续更久、或歌词更密），让「一直在唱」对抗
「时机不确定」；而不是继续调时间点。注意这点还没验证过，别当成已知答案。

### 4.4 重采后**必须**拼 contact sheet 逐张看

脚本「跑成功了」不等于图能用 —— 上面所有坑都是这么发现的。17 张拼一张图逐张核对，标准是
**每一张都能一眼看出是哪个样式，且至少有一行清晰可读的歌词**（`still` 这种极简样式例外）。

```bash
# 需要 Pillow 的 python（DSH 运行时那个带）
PY="C:/Users/24037/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/python/python.exe"
"$PY" - <<'EOF'
from PIL import Image, ImageDraw
import os
d = 'poc/settings-ui/public/thumbs'
modes = ['sonnet','tempera','lumiere','hanabi','machi','nebbia','classic','cadenza','partita',
         'fume','tilt','claddagh','monet','pendolo','cappella','diorama','still']
COLS,TW,TH,PAD,LAB = 4,480,300,10,22
rows=(len(modes)+COLS-1)//COLS
sheet=Image.new('RGB',(COLS*(TW+PAD)+PAD, rows*(TH+LAB+PAD)+PAD),(18,18,20))
dr=ImageDraw.Draw(sheet)
for i,m in enumerate(modes):
    im=Image.open(os.path.join(d,m+'.jpg')).convert('RGB').resize((TW,TH), Image.LANCZOS)
    x=PAD+(i%COLS)*(TW+PAD); y=PAD+(i//COLS)*(TH+LAB+PAD)
    sheet.paste(im,(x,y)); dr.text((x+4,y+TH+5), f"{i+1}. {m}", fill=(230,230,235))
sheet.save('research/style-model-verify/thumbs-sheet.jpg','JPEG',quality=90)
print('ok')
EOF
```

### 4.5 站点图要从同一批缩略图派生（别各采各的）

`site/assets/styles/*.jpg`（960×540 q85）与 `site/assets/styles/large/*.jpg`（1600×900 q82）是
README / 宣传站用的同一批画面。**定稿后必须同步**，否则宣传站和设置页不一致（会更旧）。直接
从 `public/thumbs` 派生最省事（两者同源，都是 16:10）：

```bash
"$PY" - <<'EOF'
from PIL import Image
import os
modes = ['sonnet','tempera','lumiere','hanabi','machi','nebbia','classic','cadenza','partita',
         'fume','tilt','claddagh','monet','pendolo','cappella','diorama','still']
def cover(im,w,h):
    sw,sh=im.size; want=w/h
    if sw/sh>want:
        nw=int(sh*want); im=im.crop(((sw-nw)//2,0,(sw-nw)//2+nw,sh))
    else:
        nh=int(sw/want); im=im.crop((0,(sh-nh)//2,sw,(sh-nh)//2+nh))
    return im.resize((w,h), Image.LANCZOS)
for sub,w,h,q in [('styles',960,540,85),('styles/large',1600,900,82)]:
    out=os.path.join('site/assets',sub); os.makedirs(out,exist_ok=True)
    for m in modes:
        cover(Image.open(f'poc/settings-ui/public/thumbs/{m}.jpg').convert('RGB'),w,h)\
            .save(f'{out}/{m}.jpg','JPEG',quality=q,optimize=True,progressive=True)
print('site images synced')
EOF
```

> 别再用 `site/tools/capture-styles.mjs` 重新采一遍：它要 Playwright + 跑一个 server，而且采出来
> 又是另一套画面，两边永远对不齐。它的列表已由 `check-style-sync.mjs` 校验，保留即可。

## 5. 构建后必须点一遍所有 tab（能挡住白屏的那一类）

0.7.25 的真实事故：上游给 `VisPlaygroundSettingsPanel` 加了一个**必填 prop**
`subtitleOverlayLayout`，而 `App.tsx` 传不了它（本页 store 没有这个字段）。组件内部
`getSubtitleOverlayRows(layout)` 直接 `layout.split('+')`，**没有默认值** → `TypeError`。
设置岛**没有 ErrorBoundary**，所以点「字幕」tab 时整个岛直接白屏。

当时的处置：在 `vite.config.ts` 的 `SETTINGS_SURGERY` 里加了 6 条 surgery 把该控件（及其 prop、
类型 import）整体摘掉。

**以后上游再加必填 prop，会以完全相同的方式炸。** 所以：

```bash
cd poc/settings-ui && npx vite dev --port 18090
# 打开 http://localhost:18090/dev.html
# 点一遍：歌词动画 / 背景 / 字体 / 字幕 四个 tab，每个 tab 里再点开几个样式的设置面板
```

自动化替代（临时脚本放 `poc/settings-ui/scripts/`，用完删）：

```js
const tabs = ['歌词动画', '背景', '字体', '字幕'];
for (const label of tabs) {
    await page.evaluate(t => [...document.querySelectorAll('[role="tab"]')]
        .find(n => n.textContent.trim() === t)?.click(), label);
    await sleep(700);
    const alive = await page.evaluate(() => !!document.querySelector('.st-window'));
    if (!alive) throw new Error(`tab ${label} 挂了（多半是必填 prop 缺失 → 白屏）`);
}
```

`surgery` 的 marker 失配会**直接 throw 并指名是哪个 marker** —— 那是在告诉你「上游改了这段源码，
去看新源码重写 marker」，不是要你去放宽检查。

## 6. 合规检查

新增样式如果带了第三方数据/字体/图像，补 `THIRD_PARTY_NOTICES.md` 与
`packaging/licenses-src/THIRD-PARTY.md`。雾笺的笔顺数据（`nebbia-strokes.json`）就是这类。

## 7. 收尾闸门（全部必须绿）

```bash
cd poc/settings-ui
node scripts/check-style-sync.mjs --check              # 样式清单与上游一致
npx vite build                                        # thumbs / surgery marker / CSS 都在这过
npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"   # 不高于基线（当前 297，都是既有噪声）

cd <repo>
node packaging/tools/stage-web.mjs                    # staging（含 splash / thumbs / CSS 闸门）
```

`vite build` 与 `stage-web.mjs` 的失败信息都写明了「为什么」和「下一步跑什么」，照做即可。

## 8. 已知的既有噪声（不是你的锅）

- `npx tsc --noEmit` 会报 ~297 个错误，**全部**来自 `work/` 里的上游源码（Electron/Node 类型缺失、
  `@/` 别名解析）与本页既有代码。基线在变，改前先自己跑一次记下数字，**只要不新增**就行。
- `vite build` 会警告部分 chunk > 500 kB（`db.js` 2 MB 等），这是上游 OBS bundle 的既有形态。

## 9. 常见误判

- **「闸门报错说明我改坏了」**：不一定。`check-style-sync --check` 报错是在说「本地副本与上游不一致」，
  可能是上游刚加了样式而你还没跟。先读它的「上游有、本地缺」那一行。
- **「`--write` 为什么只改了 6 个文件」**：故意的。`styles.tsx` / `settings.ts` /
  `transparencyCompat.ts` 需要人判断（用哪个 panel、透明分类、默认值从哪 import），机器代劳会写出
  看似正确实则不对的 entry。`--write` 之后仍会 exit 1，直到人判断项也改完。
- **「`cadenza` 的 labelKey 是 `ui.visualizerCadenze`」**：是上游拼写如此（少个 z）。**不要**从
  labelKey 反推样式 id，也不要「顺手修正」这个 key —— id 一律以 entry 的 `mode:` 为准。

## 10. `preference_config.json` 的帧率项（v0.4.9 引入）—— ⚠️ **v0.4.10 已删除该设置**

> **撤回提示（2026-11-02，v0.4.10）：整个「帧率」设置已从本仓库移除**，不是停用、不是隐藏，
> 是**链路整体删除**。按代码现状逐条对照（改这段前先 `grep` 一遍，别信本文）：
>
> - `spw-folia/src/main/resources/preference_config.json` 里 `frameRate` 那一项**整条删除**（现存
>   三个 `switch` + 一个 `button`）。
> - 插件侧 `FoliaPlugin.readFrameRate()` / `normaliseFrameRate()` / `FRAME_RATE_KEY` 与
>   `FoliaHostBridge.frameRate` 字段**已删除**，插件不再向宿主传 `--frame-rate`。
> - 宿主 `Program.cs` 的 `FrameRateScript()` 与「把 cap 写进 localStorage」的注入**已删除**；但
>   `--frame-rate` 这个**参数名仍被接受并忽略**（`case "--frame-rate": Next(argv, ref i); break;`），
>   目的是让还带旧参数的插件包照常 spawn，而不是撞上「未知参数」。`HostForm.WriteFpsSample()` 里
>   的 `frameRate` 字段同样删了，`capped` 保留（它是「限流器装没装」的 ground truth）。
> - `Shim.js` 不再**写** localStorage，反而在每次文档创建时**清掉**旧键
>   `visualizer_frame_rate`（`clearLegacyFrameRateCap()`），因为上游
>   `installGlobalVisualizerFrameRateLimiter()` 会在启动时读这个键，只要残留任何非 `off` 值，
>   升级后的页面就会被**永久静默限流**。清掉时的原值会随 `ready` 消息的 `frameRateCleared`
>   字段上报，用来证明升级确实解除了旧 cap。
> - 验收脚本 `docs/archive/verify-frame-rate-v0.4.9.mjs` 保留为历史（v0.4.9 时期的脚本），不再跑。
>
> 理由见 §10.2 的结论：默认 `off` 本来就是「跟随屏幕刷新率」，而上游那 `-1 ms` 容差让**每个档位**
> 都达不到标称值（120 Hz 屏上 90 档只有 60），留一个「选了也不准」的下拉比不给更糟。
> **「删设置」不等于「删效果」**：真正的坑是那个 localStorage 键的残留，不是 UI 项本身——见上一条。
> 变更记录见 [`docs/release-notes-v0.4.10.md`](release-notes-v0.4.10.md)。
>
> **本节以下内容保留为历史技术分析**：§10.2 对上游限流器缺陷的结论**至今有效**，而且正是删除该
> 设置的理由；§10.1/§10.3 只描述当时（v0.4.9）的实现与踩过的坑，**不再是指令**——除非有一天要把
> 这个设置重新加回来，否则不要照着它们改代码。§10.4 的开屏首帧修复与帧率无关，**仍然有效**。

### 10.1 `list` 类型与降级方案（历史，v0.4.10 已随设置一起删除）

配置页的「帧率」项用的是 `type: "list"`，依据是社区插件 spw-island 的
`src/main/resources/preference_config.json`（`entries` / `entry_values` 平行数组，
`entry_values` 为字符串）。**`switch` 和 `button` 之外的类型在本仓库没有任何本地实证**——
`docs/` 不记录 schema，workshop API jar 只有读取侧 `ConfigManager`，gradle 插件不校验 json，
SPW 宿主程序也不在这台开发机上，所以**无法在本机验证配置页能不能渲染 `list`**。

**万一用户反馈配置页该项不显示/整页渲染不出来**（历史处置，v0.4.10 已无该项）：把 `type` 从
`list` 换成 `switch` 即可（语义变成「限制帧率」开关，开=120、关=无限制），`key` 保持 `frameRate`，
`default_value` 改成 `false`。

Kotlin 侧当时已经为此解耦：`FoliaPlugin.readFrameRate()` 只读一个字符串并交给
`normaliseFrameRate()`，**不认任何 UI 类型**；`normaliseFrameRate()` 接受 `off/120/90/60`
（另容忍 `"120.0"` 这种 JSON 往返产物），其余一律回落 `off`，且从不抛异常。**这段代码在 v0.4.10
已删除**——v0.4.11 起 `preference_config.json` 分成三组共四个 `switch`（播放页：打开过渡动画 /
显示播放条 / 显示问题反馈按钮；诊断与日志：详细日志）与一个 `button`（支持与反馈：出现问题），
全部是有本地实证的类型。

### 10.2 ⚠️ 上游限流器达不到标称值（上游缺陷，非本仓库问题；所有档位都受影响）

`work/folia/folia-major-main/src/utils/frameRateLimiter.ts`：

```ts
const intervalMs = 1000 / frameRate - FRAME_INTERVAL_TOLERANCE_MS;   // tol = 1
return lastProcessedTimestampMs === 0 || timestampMs - lastProcessedTimestampMs >= intervalMs;
```

**根因是那个 `- 1 ms` 容差**：它让所需的帧间隔刚好比目标 vsync 略短一点点，于是在整数个 vsync
上永远「差一点点」，退化成「每 N 帧放行一次」的下一档。所以这**不是 90 一档的特例**——在非 60/120 Hz
屏幕上**每个档位都会偏**。

按 `intervalMs = 1000/target - 1`、取 `ceil(need/vsync)` 帧放行一次建模：

| 显示器 | vsync | 120 档 → 实际 | 90 档 → 实际 | 60 档 → 实际 |
| --- | --- | --- | --- | --- |
| 60 Hz | 16.67 ms | 60 | 60 | 60 |
| **120 Hz（本机实测）** | **8.33 ms** | **120** | **60** | **60** |
| 144 Hz | 6.94 ms | **72** | **72** | **48** |
| 165 Hz | 6.06 ms | **83** | **83** | **55** |

本机（120 Hz）实测复核：`off` → 120、`120` → 120、`90` → 60、`60` → 60，与建模一致。

结论与约定：

- 上游 UI 里的「120 / 90 / 60」只是**标称值**；实际值随显示器刷新率变化，`off`（无限制）是唯一
  「跟随显示器」的档位。
- **不要在本地截断/改写任何档位值**（那会让「选了 90」和「选了 60」在上游看来不同，也会掩盖
  120 档在 144 Hz 屏上只有 72 这个事实）。
- **v0.4.10 的处置：不再把这条有缺陷的链路暴露给用户。** 既然 `off` 才是真正跟随刷新率的档位，
  而其余三档在非 60/120 Hz 屏上必然偏，那就不如删掉整个选项——这是 v0.4.10 删除该设置的直接
  理由，也是本节唯一还有约束力的结论。
- 上游后续若修好这个容差，与本仓库无关（设置已不存在）；若将来要重加，先按本节表格复核实际值。
- 验收时看 upstream 的 `__foliaNativeRequestAnimationFrame` 是否安装来判断「设置送达了」，
  不要只看 fps 数字——显示器刷新率是硬天花板，`off` 与 `120` 在 120 Hz 屏上 fps 完全相同。
  宿主 `--fps-log` 仍输出 `capped` 字段（v0.4.10 起 `frameRate` 字段已随设置删除）。
- 用户可见文案（`preference_config.json` 的 `summary`）当时已写明「选定值可能达不到标称值」；
  v0.4.10 之后这条文案连同整个条目一起不存在了。

### 10.3 v0.4.9 帧率实现的三个坑（**历史**：v0.4.10 已随设置一起移除，改动相关代码前必读但别照抄）

> 这三条描述的是 v0.4.9 的实现，相关代码在 v0.4.10 已全部删除。留下它们是因为其中**两条是通用
> 的工程教训，与帧率无关**：嵌入式资源（`Shim.js`）改完必须重编 exe；`--fps-log` 只写白名单字段。
> 第 3 条（`--frame-rate` 必须无条件传）已随参数一起失效。

1. **`Shim.js` 是编译进 exe 的嵌入式资源**（`Program.ShimScript()` →
   `Assembly.GetManifestResourceStream("Shim.js")`）。改了 `Shim.js` **必须重新跑
   `bash poc/webview/host/build.sh`** 才生效——否则你跑的是旧 exe，表现是「代码明明改了但页面行为
   不变」。本次实现时踩过：给 fps 消息加了 `capped`/`frameRate` 字段，但没重编，`--fps-log` 里
   一直没有这两个字段，误以为逻辑写错，实际是旧资源。
   `.cs` 改了同理（要编译），而 `.json` 类的**插件**资源改完要重新
   `./gradlew build` 才进 `.spmod`。
2. **`--fps-log` 只写白名单字段**。`HostForm.WriteFpsSample()` 是手工拼的 JSON 字符串，不是把
   页面消息原样转存；给页面侧新增的任何字段都**必须同步加到这里**，否则它永远不会出现在日志里。
   本次踩过同一个坑（`capped` 加进了 `Shim.js` 却漏了 `WriteFpsSample`）。
3. **（已失效，v0.4.10）`--frame-rate` 必须无条件传**（包含 `off`）。宿主写 localStorage 时不比较
   大小、不做「只在变化时写」的优化，否则上一次会话留下的 cap 会残留，用户选了「无限制」却仍被
   限流。当时在 `verify-frame-rate.mjs` 的 stale-value 用例里钉死这条；该参数与脚本都已删除。

### 10.4 v0.4.9 M2：开屏因「首帧」判定过晚而多留 907 ms（已修，用户可感知，**与帧率设置无关，仍然有效**）

`firstPageFrameAt` 原先取自第一条 `fps` 消息，而 `Shim.js` 的 fps 只在**满 1 秒窗口**后才发一次，
于是「首帧」实为「首个 fps 窗口结束」，晚约 **850 ms**（实测 853–863 ms）。splash 揭幕闸门是
`max(shownAt + splashMinMs, firstFrameAt + SplashFrameGraceMs)`，首帧虚高直接拉长了开屏停留。

实测（`--splash-duration 0.8`，`splash reveal` 行的 `shownForMs`）：

| | firstPageFrameAt | shownForMs | 超出 minMs |
| --- | --- | --- | --- |
| 改前（`source=fps-window`） | 1505 ms | 1907 ms | +1107 ms |
| 改后（`source=first-frame`） | 586 ms | **1000 ms** | **+200 ms** |

即开屏少留约 **907 ms**，用户的「开屏怎么还不走」随之消失。做法：`Shim.js` 在**首个 rAF 回调**里
额外发一条 `{type:'first-frame'}`；`HostForm` 认这个类型，并保留 `fps` 分支作为旧 bundle 的兜底
（日志会标 `source=fps-window`，便于区分）。

**连带改了一条回归断言**：`verify-splash.mjs` 的 run 3 原在 1500 ms 断言「splash 仍在屏上」——
M2 之后它在约 995 ms 就**正确地**揭开了，那条断言等于把旧的错误时序钉死。现改为「用 `splash shown`
日志证明曾经显示过 + 用 `splash reveal` 行证明时序正确」。这是**断言跟随正确行为**，不是为了让测试
通过而放宽标准；改动处已在脚本里注明原因。

## 11. SPW 宿主升级时的反混淆检查

SPW 是 R8 混淆构建，**每次版本构建都会重新生成被混淆的类名与方法名**，且同一版本的 Windows /
Linux 构建之间也会不同。插件里任何写死的混淆标识符都会在下一次播放器更新时变成
`ClassNotFoundException` / `NoSuchMethodException`。

### 11.1 文章出处

Steam 创意工坊讨论区，作者 **GaodaGG**（Salt Player 官方开发者，帖子带 `[developer]` 标记），
2025-10-20，标题《【插件开发建议】关于插件调用 Hook API 时的反混淆：请利用反射与 Metadata 动态定位》。
四条建议：

1. **切勿在代码里直接写死（Hardcode）明显经过混淆的类名和方法名**——写死了播放器一更新就失效。
2. 同一版本内 **Windows / Linux 的方法名也不同**。
3. 用**反射（Reflection）**或解析 **Metadata（Kotlin `@Metadata` / `kotlin-reflect`）** 动态获取；
   依靠**编译后不会改变的特征**检索：Metadata 里保留的函数/属性元数据、**参数类型组合**、
   **返回值类型**、实现的接口、特定成员变量。
4. **定位成功后把 `Method` / `Field` 缓存起来复用**，避免频繁反射或重复解析 Metadata 影响性能。

（原文约 709 字符，抓取快照见本地 `.scratch/task7/article.txt` / `ref.html`，不入库。）

### 11.2 本仓库的落地情况

| 位置 | 状态 |
| --- | --- |
| `HostTargets.kt` + `HostMenuDiscovery.kt` + `HostBytecodeIndex.kt` | **本来就已达标**（甚至超出文章要求）：分层解析，主路径是扫宿主自己的 bytecode 按形状（调用图 / 参数表 / 自类型默认参桥）识别，注释明确写 `never by an obfuscated name`，结果按宿主版本缓存到 `host-targets.json` |
| `FoliaPlaybackControls.kt` | **本次（M1）改造**。此前写死了 5 个混淆标识符（`\u037F`、`\u0528`…`\u052B`），是文章点名的那种写法 |
| `FoliaTrayMenu.kt` / `FoliaTrayNative.kt` / `FoliaMenuItem.kt` | 走反射且全部 `runCatching` 包裹，名字属于 compose-native-tray 的非混淆 API，风险低 |

`FoliaPlaybackControls` 现在的**三层解析**（`HostMemberResolver.kt`）：

1. **元数据属性顺序 + 字段表**（首选）——从 `@Metadata` 的 `d2` 表取源级属性名顺序
   （`mode, normalQueue, normalIndex, randomQueue, randomIndex, readyToSave`），再用**字段声明顺序**
   把成员对上去。两者都是「编译后不变」的特征。
2. **`listIntPairs`**——纯结构：两组 `(List, int)` 按字段表顺序配对。
3. **写死名兜底**——元数据被剥掉的构建仍按改动前的行为工作。

### 11.3 两个坑（都是实测踩出来的，别重蹈）

**坑 1：`getDeclaredMethods()` 的顺序不是声明顺序，`getDeclaredFields()` 的顺序才是。**

同一宿主实测：

```
字段顺序  : \u037F Mode, \u0528 List, \u0529 int, \u052A List, \u052B int, \u052C boolean
getter顺序: \u052B int,  \u0529 int,  \u052A List, \u037F Mode, \u0528 List, \u052C boolean   ← 打乱
```

所以「按返回类型分桶再 zip」会**静默把 normal 和 random 互换**。用户看到的是「随机播放显示成顺序
队列」，而日志、崩溃、单测全都正常。**顺序权威只用字段表**。

**坑 2：`@Metadata` 里的属性名不能直接拿去 `findMethod`。**

R8 把**方法名也改了**，`getNormalQueue()` 这种名字在 class 文件里根本不存在（实测确认）。
元数据只提供「属性名的**顺序**」；成员本身要靠字段表按「字段名 == 访问器名 + 同类型」对齐。
`VerifyResolver2` 里那条 negative 检查就是钉住这一点。

**补充**：`Class.forName("…PlaybackQueueItem")` 也不成立——`PlaybackQueueItem` 是**源名**，
只以引用形式存在于元数据里；class 文件里它是单个混淆字符（当前版本 `\u037F`）。
定位要靠「形状 + 元数据属性 `id`/`data`」，不能靠 `forName`。

### 11.4 失败策略原则：**绝不用单向闩锁锁死功能**

原实现有 `permanentlyUnavailable` 单向闩锁：一旦抛 `ClassNotFoundException` / `NoClassDefFoundError`
就把播放控制**永久关闭到进程结束**。这在活宿主里不成立——首次调用时队列类可能还没被那个 loader
加载；宿主热更新换 classpath 也只报一次。结果就是「播放控制栏整个消失，用户必须重启 SPW」。

现在的策略（`FoliaPlaybackControls.handles()`）：

```kotlin
MAX_RESOLVE_FAILURES = 4          // 连续失败 4 次
EXHAUSTED_RETRY_MS   = 120_000L   // 之后每 2 分钟慢探一次，到期自动清零重试
```

代价是每 2 分钟一次失败的反射（可忽略），换来「会自己恢复」。
**写任何宿主探测代码都照这个来：退避 + 自动恢复，不要写单向闩锁。**

### 11.5 怎么验证

两个可复跑脚本在 `poc/webview/host/repro/`（头部注释含完整用法与期望输出）：

| 脚本 | 作用 | 何时跑 |
| --- | --- | --- |
| `VerifyResolver2.java <宿主 jar>` | 对**真实宿主 bytecode** 断言 10 项：元数据顺序、五个访问器全部解析且 normal ≠ random、类型正确、写死名与元数据一致、队列元素可定位、以及「源级 getter 名在混淆类上不存在」的负向检查 | **每次 SPW 升级后必跑**；任何 FAIL 说明解析退化到更低的兜底层 |
| `RenameSim.java` | 负向：模拟写死名和访问器名全被改名，断言解析器**拒绝猜**而不是静默错配 | 改动 `HostMemberResolver` 后跑 |

宿主 jar 是 polyglot ZIP（伪装的 `app/ffmpeg-x64.dll`，约 111 MB / 42k entries），**路径必须传参**
（Steam 版 / MSIX 版 / 自定义路径都不同），不要写死。

跑法（仓库根目录）：

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
能驱动一次真实 SPW 播放队列的端到端手段（插件无法在本仓库里安装进运行中的 SPW），所以
**队列 UI 的渲染层没有真机验证覆盖**——那部分依赖真机手动点一遍。
