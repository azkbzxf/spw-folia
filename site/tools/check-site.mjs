/* ============================================================================
   site/tools/check-site.mjs — self-check for the promo site.
   ----------------------------------------------------------------------------
   Serves site/ over a throw-away local HTTP server, then drives the real page
   in headless Edge (puppeteer-core from poc/settings-ui/node_modules) at three
   viewports and asserts the things that silently rot:

     · no console error / pageerror / 4xx / failed request
     · every referenced asset exists (and the 3 Lead-supplied stills, loudly)
     · 17 gallery tiles, all images decoded, all <img> have non-empty alt
     · every <a> has a usable href; every video is preload="none"
     · lightbox opens as role=dialog, ESC closes, focus returns to the tile
     · no horizontal overflow at 1920x1080 / 1440x900 / 390x844
     · prefers-reduced-motion: nothing autoplays

   Usage:  node site/tools/check-site.mjs [--verbose] [--keep-open]
   Exit:   0 all PASS, 1 at least one FAIL, 2 the harness itself blew up.
   ========================================================================== */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.resolve(HERE, "..");
const REPO = path.resolve(SITE, "..");

const EDGE =
  process.env.EDGE_PATH ||
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

/* stills that are produced outside this repo's static asset pipeline.
   Keep the list in one place so the failure message can name them. */
const SUPPLIED_STILLS = [
  "assets/stills/player-page.jpg",
  "assets/stills/player-menu.jpg",
  "assets/stills/settings-page.jpg",
];

const VIEWPORTS = [
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* ── tiny assertion harness ─────────────────────────────────────────────── */
const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  process.stdout.write(`\n\x1b[1m${name}\x1b[0m\n`);
}

function check(label, ok, detail) {
  const pass = Boolean(ok);
  results.push({ group: currentGroup, label, pass, detail });
  const mark = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const extra = !pass && detail !== undefined ? `  \x1b[2m${detail}\x1b[0m` : "";
  process.stdout.write(`  ${mark}  ${label}${extra}\n`);
  return pass;
}

function note(text) {
  process.stdout.write(`  \x1b[36mNOTE\x1b[0m  ${text}\n`);
}

/* ── static file helper ─────────────────────────────────────────────────── */
function fileMissing(rel) {
  const abs = path.join(SITE, rel);
  return !fs.existsSync(abs) || !fs.statSync(abs).isFile();
}

/* ── http server ────────────────────────────────────────────────────────── */
function createServer(requestLog) {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
    const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const abs = path.normalize(path.join(SITE, rel));
    if (!abs.startsWith(SITE)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      requestLog.push({ url: urlPath, status: 404 });
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
      return;
    }
    const type = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  });
}

/* ── WOFF2 cmap reader ──────────────────────────────────────────────────────
   The site's only webfont is a subset; if it stops covering a character the
   page still "works" but silently falls back to a system face for that glyph.
   Reading the cmap needs a Brotli decompress (Node has that in zlib) and a
   cmap format 4/12 walk — small enough to keep here rather than add a dep. */
const WOFF2_TAGS = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm",
  "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern",
  "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC",
  "JSTF", "MATH", "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar",
  "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar", "gvar", "hsty",
  "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat",
  "Gloc", "Feat", "Sill",
];

function base128(buf, offset) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[offset];
    offset += 1;
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, offset];
  }
  throw new Error("bad base128 in woff2 directory");
}

function readWoff2Codepoints(buf) {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("not a WOFF2 file");
  const numTables = buf.readUInt16BE(12);
  const totalCompressed = buf.readUInt32BE(20);
  let offset = 48;
  const entries = [];
  for (let i = 0; i < numTables; i += 1) {
    const flags = buf[offset];
    offset += 1;
    const tagIndex = flags & 0x3f;
    let tag;
    if (tagIndex === 0x3f) {
      tag = buf.toString("latin1", offset, offset + 4);
      offset += 4;
    } else {
      tag = WOFF2_TAGS[tagIndex];
    }
    let origLength;
    [origLength, offset] = base128(buf, offset);
    const transformVersion = flags >> 6;
    const transformed =
      tag === "glyf" || tag === "loca"
        ? transformVersion === 0
        : transformVersion !== 0;
    let transformedLength = null;
    if (transformed) [transformedLength, offset] = base128(buf, offset);
    entries.push([tag, origLength, transformedLength]);
  }

  const stream = zlib.brotliDecompressSync(
    buf.subarray(offset, offset + totalCompressed)
  );
  const tables = new Map();
  let cursor = 0;
  for (const [tag, origLength, transformedLength] of entries) {
    const size = transformedLength === null ? origLength : transformedLength;
    tables.set(tag, { start: cursor, size });
    cursor += size;
  }

  const cmapTable = tables.get("cmap");
  if (!cmapTable) throw new Error("woff2 has no cmap");
  const cmap = stream.subarray(cmapTable.start, cmapTable.start + cmapTable.size);
  const codepoints = new Set();
  const numSubtables = cmap.readUInt16BE(2);
  for (let i = 0; i < numSubtables; i += 1) {
    const subOffset = cmap.readUInt32BE(4 + i * 8 + 4);
    const format = cmap.readUInt16BE(subOffset);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(subOffset + 6);
      const seg = segX2 / 2;
      const endBase = subOffset + 14;
      const startBase = endBase + segX2 + 2;
      const deltaBase = startBase + segX2;
      const rangeBase = deltaBase + segX2;
      for (let s = 0; s < seg; s += 1) {
        const end = cmap.readUInt16BE(endBase + s * 2);
        const start = cmap.readUInt16BE(startBase + s * 2);
        const delta = cmap.readInt16BE(deltaBase + s * 2);
        const rangeOffset = cmap.readUInt16BE(rangeBase + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let glyph;
          if (rangeOffset === 0) {
            glyph = (c + delta) & 0xffff;
          } else {
            const at = rangeBase + s * 2 + rangeOffset + (c - start) * 2;
            if (at + 1 >= cmap.length) continue;
            glyph = cmap.readUInt16BE(at);
            if (glyph) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph) codepoints.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(subOffset + 12);
      for (let g = 0; g < groups; g += 1) {
        const groupBase = subOffset + 16 + g * 12;
        const start = cmap.readUInt32BE(groupBase);
        const end = cmap.readUInt32BE(groupBase + 4);
        for (let c = start; c <= end; c += 1) codepoints.add(c);
      }
    }
  }
  codepoints.delete(0);
  return codepoints;
}

/* ── main ───────────────────────────────────────────────────────────────── */
async function main() {
  const verbose = process.argv.includes("--verbose");

  if (!fs.existsSync(EDGE)) {
    throw new Error(
      `Edge not found at ${EDGE} — set EDGE_PATH to msedge.exe`
    );
  }
  const requireFromSettingsUi = createRequire(
    path.join(REPO, "poc/settings-ui/package.json")
  );
  let puppeteer;
  try {
    puppeteer = requireFromSettingsUi("puppeteer-core");
  } catch (err) {
    throw new Error(
      "puppeteer-core not found in poc/settings-ui/node_modules — run `pnpm install` there first"
    );
  }

  /* ── 0. the stills that come from outside this directory ──────────────── */
  group("0. supplied stills (produced outside site/)");
  const missingStills = SUPPLIED_STILLS.filter(fileMissing);
  const stillsOk = check(
    `${SUPPLIED_STILLS.length} Lead-supplied screenshots present in site/assets/stills/`,
    missingStills.length === 0,
    missingStills.length === 0
      ? ""
      : `${missingStills.length} missing from the Lead's capture run: ${missingStills.join(", ")}`
  );
  if (!stillsOk) {
    note(
      "这些图不是仓库里的静态素材，需要 Lead 用真实宿主截图后放进 site/assets/stills/：" +
        missingStills.join("、")
    );
    note("页面本身没有问题 —— 缺的是截图。补齐后重跑本脚本即会转绿。");
  }

  /* ── 1. static reference scan (before launching a browser) ────────────── */
  group("1. static references");
  const html = fs.readFileSync(path.join(SITE, "index.html"), "utf8");
  const refs = new Set();
  const refRe = /(?:src|href|poster)="([^"#?]+)"/g;
  let match;
  while ((match = refRe.exec(html)) !== null) {
    const value = match[1];
    if (/^(https?:|data:|mailto:|#|\/\/)/.test(value)) continue;
    refs.add(value);
  }
  const isJsInjected = !/assets\/styles\/[a-z]+\.jpg/.test(html);
  if (isJsInjected) note("画廊图由 main.js 注入，另外检查资产目录本身");

  const missingRefs = [...refs].filter(fileMissing);
  check(
    `${refs.size} 个 index.html 相对引用全部存在于磁盘上`,
    missingRefs.length === 0,
    missingRefs.join(", ")
  );

  const styleIds = [
    "sonnet", "tempera", "lumiere", "hanabi", "machi", "nebbia", "classic",
    "cadenza", "partita", "fume", "tilt", "claddagh", "monet", "pendolo",
    "cappella", "diorama", "still",
  ];
  const missingStyles = styleIds.flatMap((id) => {
    const small = `assets/styles/${id}.jpg`;
    const large = `assets/styles/large/${id}.jpg`;
    return [small, large].filter(fileMissing);
  });
  check(
    `17 种样式 × 2 尺寸共 34 张真实截图存在`,
    missingStyles.length === 0,
    missingStyles.join(", ")
  );

  /* the release version must live in exactly one place, and no stale
     "latest version" wording may survive anywhere in the page */
  const releaseAttrs = [
    ...html.matchAll(/data-release="(\d+\.\d+\.\d+)"/g),
  ].map((m) => m[1]);
  const declaredVersion = releaseAttrs[0];
  check(
    "<html data-release> 正好声明一个发布版本号",
    releaseAttrs.length === 1 && /^\d+\.\d+\.\d+$/.test(declaredVersion),
    `data-release: ${releaseAttrs.join(", ") || "(none)"}`
  );

  const staleVersionWording = /(下载|当前版本|最新版本)[^<]{0,12}v\d+\.\d+\.\d+/g;
  const staleHits = [...html.matchAll(staleVersionWording)].map((m) => m[0]);
  check(
    '没有把版本号写死在「下载 / 当前版本」这类文案里',
    staleHits.length === 0,
    staleHits.join(" | ")
  );

  check(
    "不再出现「14 款样式」这类旧口径",
    !/14\s*(款|种)/.test(html),
    (html.match(/[^<>]{0,24}14\s*(款|种)[^<>]{0,24}/) || [""])[0]
  );

  const fakedPerf = /100\s*[–-]\s*114|\bFPS\b/.test(html);
  check("没有未经验证的帧率数字（FPS / 100–114）", !fakedPerf);

  const badHrefs = [];
  const anchorRe = /<a\b([^>]*)>/g;
  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1];
    const href = /\bhref="([^"]*)"/.exec(attrs);
    if (!href || !href[1].trim()) badHrefs.push(attrs.trim().slice(0, 80));
  }
  check("所有 <a> 都有非空 href", badHrefs.length === 0, badHrefs.join(" | "));

  const imgTags = html.match(/<img\b[^>]*>/g) || [];
  const altless = imgTags.filter((tag) => {
    const alt = /\balt="([^"]*)"/.exec(tag);
    return !alt || !alt[1].trim();
  });
  check(
    `index.html 里 ${imgTags.length} 个 <img> 都有非空 alt`,
    altless.length === 0,
    altless.map((t) => t.slice(0, 70)).join(" | ")
  );

  const stillsReferenced = [...refs].filter((ref) => SUPPLIED_STILLS.includes(ref));
  check(
    "页面引用了全部 3 张 Lead 提供的截图",
    stillsReferenced.length === SUPPLIED_STILLS.length,
    `引用了 ${stillsReferenced.length}/${SUPPLIED_STILLS.length}`
  );

  /* the shipped serif subset must cover every character the page can render,
     otherwise display type silently falls back to a system face for that glyph */
  const fontBytes = fs.readFileSync(path.join(SITE, "assets/fonts/serif.woff2"));
  const fontCodepoints = readWoff2Codepoints(fontBytes);
  const pageText =
    html +
    fs.readFileSync(path.join(SITE, "style.css"), "utf8") +
    fs.readFileSync(path.join(SITE, "main.js"), "utf8");
  const uncovered = [
    ...new Set(
      [...pageText]
        .filter((ch) => !/\s/.test(ch))
        .filter((ch) => !fontCodepoints.has(ch.codePointAt(0)))
    ),
  ];
  check(
    `serif.woff2 覆盖页面用到的全部 ${new Set([...pageText].filter((c) => !/\s/.test(c))).size} 个字符`,
    uncovered.length === 0,
    `缺 ${uncovered.length} 个：${uncovered.join("")}（重跑 python site/tools/make-font.py）`
  );

  check("页面有 skip link", /class="skip"[^>]*href="#main"/.test(html));

  /* ── 2. browser-driven checks ─────────────────────────────────────────── */
  const requestLog = [];
  const server = createServer(requestLog);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  note(`serving ${SITE} at ${origin}`);

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    args: [
      "--nosandbox",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1",
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  let exitCode = 0;
  try {
    for (const viewport of VIEWPORTS) {
      group(`2. ${viewport.name}`);
      requestLog.length = 0;
      const page = await browser.newPage();
      await page.setViewport({ width: viewport.width, height: viewport.height });

      const consoleErrors = [];
      const pageErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => pageErrors.push(String(err && err.message)));
      page.on("requestfailed", (req) => {
        requestLog.push({
          url: req.url().replace(origin, ""),
          status: `failed: ${req.failure() && req.failure().errorText}`,
        });
      });
      page.on("response", (res) => {
        const status = res.status();
        if (status >= 400) {
          requestLog.push({
            url: res.url().replace(origin, ""),
            status,
          });
        }
      });

      const response = await page.goto(`${origin}/index.html`, {
        waitUntil: "networkidle2",
        timeout: 45000,
      });
      check(`页面加载成功 (HTTP ${response && response.status()})`, response && response.ok());

      /* settle lazy images: scroll through the page once */
      await autoScroll(page);

      check(
        "无 console error",
        consoleErrors.length === 0,
        consoleErrors.slice(0, 4).join(" | ")
      );
      check(
        "无 pageerror",
        pageErrors.length === 0,
        pageErrors.slice(0, 4).join(" | ")
      );
      check(
        "无 4xx / 请求失败",
        requestLog.length === 0,
        requestLog.slice(0, 6).map((r) => `${r.url} → ${r.status}`).join(" | ")
      );

      const metrics = await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll(".tile"));
        const imgs = Array.from(document.images);
        return {
          tileCount: tiles.length,
          galleryImgs: tiles
            .map((tile) => tile.querySelector("img"))
            .filter(Boolean)
            .map((img) => ({ src: img.getAttribute("src"), w: img.naturalWidth })),
          tilesFocusable: tiles.every((tile) => tile.tagName === "BUTTON"),
          brokenImgs: imgs
            .filter((img) => img.getAttribute("src"))
            .filter((img) => !img.complete || img.naturalWidth === 0)
            .map((img) => img.getAttribute("src")),
          /* the lightbox <img> intentionally has no src until it opens */
          imagesWithoutSrc: imgs
            .filter((img) => !img.getAttribute("src"))
            .map((img) => img.className || img.outerHTML.slice(0, 40)),
          altless: imgs
            .filter((img) => !img.getAttribute("alt") || !img.getAttribute("alt").trim())
            .map((img) => img.getAttribute("src")),
          anchorsWithoutHref: Array.from(document.querySelectorAll("a"))
            .filter((a) => !a.getAttribute("href") || !a.getAttribute("href").trim())
            .map((a) => a.outerHTML.slice(0, 80)),
          videos: Array.from(document.querySelectorAll("video")).map((v) => ({
            preload: v.getAttribute("preload"),
            autoplay: v.hasAttribute("autoplay"),
            paused: v.paused,
            src: (v.currentSrc || (v.querySelector("source") || {}).src || "").split("/").pop(),
          })),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
          activeTag: document.activeElement && document.activeElement.tagName,
          h1: (document.querySelector("h1") || {}).textContent || "",
        };
      });

      check(`.tile 数量 = 17`, metrics.tileCount === 17, `实际 ${metrics.tileCount}`);
      check(
        "全部 17 张画廊图已解码（naturalWidth > 0）",
        metrics.galleryImgs.length === 17 &&
          metrics.galleryImgs.every((img) => img.w > 0),
        metrics.galleryImgs.filter((i) => i.w === 0).map((i) => i.src).join(", ")
      );
      check(
        "页面里没有加载失败的 <img>",
        metrics.brokenImgs.length === 0,
        metrics.brokenImgs.join(", ")
      );
      check(
        "无 src 的 <img> 只有尚未打开的灯箱大图",
        metrics.imagesWithoutSrc.every((cls) => cls.includes("lb__img")),
        metrics.imagesWithoutSrc.join(" | ")
      );
      check(
        "每个 <img> 都有非空 alt",
        metrics.altless.length === 0,
        metrics.altless.join(", ")
      );
      check(
        "每个 <a> 都有非空 href",
        metrics.anchorsWithoutHref.length === 0,
        metrics.anchorsWithoutHref.join(" | ")
      );
      check(
        "每格画廊都是 <button>（可键盘聚焦）",
        metrics.tilesFocusable
      );
      check(
        `无横向溢出（scrollWidth ${metrics.scrollWidth} ≤ innerWidth ${metrics.innerWidth}）`,
        metrics.scrollWidth <= metrics.innerWidth + 1,
        `scrollWidth=${metrics.scrollWidth} > innerWidth=${metrics.innerWidth}`
      );
      check(
        "所有 <video> 都是 preload=none 且不带 autoplay 属性",
        metrics.videos.every((v) => v.preload === "none" && !v.autoplay),
        JSON.stringify(metrics.videos.filter((v) => v.preload !== "none" || v.autoplay))
      );
      check(
        "h1 存在且非空",
        Boolean(metrics.h1.trim()),
        JSON.stringify(metrics.h1)
      );

      /* ── lightbox round trip ─────────────────────────────────────────── */
      const firstTile = await page.$(".tile");
      if (firstTile) {
        await firstTile.click();
        await page.waitForSelector('[role="dialog"]:not([hidden])', { timeout: 5000 }).catch(() => {});
        const opened = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          if (!dialog) return { present: false };
          const style = window.getComputedStyle(dialog);
          return {
            present: true,
            visible: !dialog.hidden && style.visibility !== "hidden",
            modal: dialog.getAttribute("aria-modal") === "true",
            labelled: Boolean(dialog.getAttribute("aria-labelledby")),
            focusInside: dialog.contains(document.activeElement),
            imgSrc: (dialog.querySelector("img") || {}).src || "",
          };
        });
        check('点击第一格出现 [role="dialog"] 且可见', opened.present && opened.visible);
        check("灯箱是 aria-modal 且带 aria-labelledby", opened.modal && opened.labelled);
        check("打开后焦点被移进灯箱", opened.focusInside);
        check(
          "灯箱加载的是 1600×900 大图",
          /assets\/styles\/large\//.test(opened.imgSrc),
          opened.imgSrc
        );
        const bigLoaded = await page.evaluate(async () => {
          const img = document.querySelector('[role="dialog"] img');
          if (!img) return { w: 0 };
          if (img.complete) return { w: img.naturalWidth };
          await new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 4000);
          });
          return { w: img.naturalWidth };
        });
        check("大图解码成功（naturalWidth > 0）", bigLoaded.w > 0, `naturalWidth=${bigLoaded.w}`);

        await page.keyboard.press("Escape");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const afterEsc = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const active = document.activeElement;
          return {
            hidden: !dialog || dialog.hidden,
            isOpenClass: dialog ? dialog.classList.contains("is-open") : false,
            focusOnTile: Boolean(active && active.classList.contains("tile")),
            focusTag: active ? active.tagName + "." + active.className : "none",
          };
        });
        check("按 ESC 关闭灯箱", afterEsc.hidden && !afterEsc.isOpenClass);
        check(
          "关闭后焦点归还到触发的那一格",
          afterEsc.focusOnTile,
          afterEsc.focusTag
        );
      } else {
        check("找到一个 .tile 来测灯箱", false, "页面里没有 .tile");
      }

      const overflowers = await page.evaluate(() => {
        const wide = [];
        const limit = window.innerWidth + 1;
        document.querySelectorAll("body *").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > limit || r.left < -1)) {
            wide.push(
              `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ` +
                `left=${Math.round(r.left)} right=${Math.round(r.right)}`
            );
          }
        });
        return wide.slice(0, 8);
      });
      if (overflowers.length) note(`溢出元素（供定位）：${overflowers.join(" | ")}`);

      if (verbose) {
        note(JSON.stringify(metrics.videos));
      }
      await page.close();
    }

    /* ── 3. prefers-reduced-motion ─────────────────────────────────────── */
    group("3. prefers-reduced-motion: reduce");
    const rmPage = await browser.newPage();
    await rmPage.setViewport({ width: 1440, height: 900 });
    await rmPage.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    await rmPage.goto(`${origin}/index.html`, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    await autoScroll(rmPage);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const rm = await rmPage.evaluate(() => {
      const videos = Array.from(document.querySelectorAll("video"));
      const hidden = Array.from(document.querySelectorAll(".reveal, .tile")).filter((el) => {
        const style = window.getComputedStyle(el);
        return parseFloat(style.opacity) < 0.9;
      });
      return {
        videoCount: videos.length,
        playing: videos.filter((v) => !v.paused).map((v) => (v.currentSrc || "").split("/").pop()),
        autoplayAttr: videos.filter((v) => v.hasAttribute("autoplay")).length,
        hiddenReveals: hidden.length,
        scrollBehavior: window.getComputedStyle(document.documentElement).scrollBehavior,
      };
    });

    check(
      `有 ${rm.videoCount} 个 <video> 可测`,
      rm.videoCount > 0
    );
    check(
      "没有任何视频在自动播放",
      rm.playing.length === 0,
      rm.playing.join(", ")
    );
    check("没有 <video> 带 autoplay 属性", rm.autoplayAttr === 0);
    check(
      "reveal / tile 全部立即可见（不做入场动画）",
      rm.hiddenReveals === 0,
      `${rm.hiddenReveals} 个元素 opacity < 0.9`
    );
    check(
      "scroll-behavior 降级为 auto",
      rm.scrollBehavior === "auto",
      rm.scrollBehavior
    );
    await rmPage.close();

    /* ── 4. file:// sanity (the page must open without a server) ───────── */
    group("4. file:// 直接打开");
    const filePage = await browser.newPage();
    await filePage.setViewport({ width: 1440, height: 900 });
    const fileErrors = [];
    filePage.on("pageerror", (err) => fileErrors.push(String(err && err.message)));
    await filePage.goto(`file:///${path.join(SITE, "index.html").replace(/\\/g, "/")}`, {
      waitUntil: "load",
      timeout: 45000,
    });
    await new Promise((resolve) => setTimeout(resolve, 900));
    const fileState = await filePage.evaluate(() => ({
      tiles: document.querySelectorAll(".tile").length,
      cssLoaded: getComputedStyle(document.body).backgroundColor,
      fontLoaded: document.fonts ? document.fonts.status : "n/a",
      stylesheet: document.styleSheets.length,
    }));
    check("file:// 下 CSS 与 JS 都加载（样式表数量 > 0）", fileState.stylesheet > 0, `${fileState.stylesheet}`);
    check("file:// 下画廊仍注入 17 格", fileState.tiles === 17, `${fileState.tiles}`);
    check("file:// 下没有 pageerror", fileErrors.length === 0, fileErrors.join(" | "));
    await filePage.close();
  } finally {
    if (!process.argv.includes("--keep-open")) {
      await browser.close();
    }
    server.close();
  }

  /* ── summary ──────────────────────────────────────────────────────────── */
  const failed = results.filter((r) => !r.pass);
  const passed = results.length - failed.length;
  process.stdout.write("\n" + "─".repeat(72) + "\n");
  process.stdout.write(`\x1b[1m${passed}/${results.length} PASS\x1b[0m\n`);
  if (failed.length) {
    process.stdout.write("\x1b[31mFailures:\x1b[0m\n");
    failed.forEach((f) => {
      process.stdout.write(`  · [${f.group}] ${f.label}`);
      if (f.detail) process.stdout.write(`  — ${f.detail}`);
      process.stdout.write("\n");
    });
    if (missingStills.length) {
      process.stdout.write(
        `\n\x1b[33m主要缺口：${missingStills.length} 张截图尚未由 Lead 放进 site/assets/stills/\x1b[0m\n`
      );
    }
    exitCode = 1;
  } else {
    process.stdout.write("\x1b[32m站点自检全绿。\x1b[0m\n");
  }
  return exitCode;
}

/* scroll the page once so lazy images and observers all fire.
   NOTE: html{scroll-behavior:smooth} turns every scrollTo into an animation,
   so a naive loop of scrollTo calls never actually lands anywhere. Force
   instant jumps while walking the page, then restore the page's own value. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = "auto";

    const step = Math.round(window.innerHeight * 0.6);
    const height = html.scrollHeight;
    for (let y = 0; y < height; y += step) {
      window.scrollTo({ top: y, left: 0, behavior: "instant" });
      await new Promise((resolve) => setTimeout(resolve, 110));
    }
    window.scrollTo({ top: height, left: 0, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 400));

    /* every image (lazy ones included) must have settled */
    await Promise.all(
      Array.from(document.images).map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
              setTimeout(resolve, 3000);
            })
      )
    );

    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    html.style.scrollBehavior = previous;
  });
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(
      `\n\x1b[31mcheck-site harness failed:\x1b[0m ${err && err.stack ? err.stack : err}\n`
    );
    process.exit(2);
  });
