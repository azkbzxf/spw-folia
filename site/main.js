/* ============================================================================
   spw-folia — promo site interaction layer
   ----------------------------------------------------------------------------
   Everything here is progressive: without JS the page is a readable document
   (nav, copy, screens). JS adds the 17-tile gallery, the lightbox, the scroll
   spy and lazy scene video playback.

   The only place a release version appears is <html data-release="0.4.18">;
   see site/README.md. Don't hard-code a version string in this file.
   ========================================================================== */
(function () {
  "use strict";

  /* ── the 17 real Folia styles, in Folia's own shelf order ──────────────── */
  const STYLES = [
    { id: "sonnet",   zh: "商籁", en: "Sonnet"   },
    { id: "tempera",  zh: "凝彩", en: "Tempera"  },
    { id: "lumiere",  zh: "绘光", en: "Lumiere"  },
    { id: "hanabi",   zh: "花火", en: "Hanabi"   },
    { id: "machi",    zh: "町景", en: "Machi"    },
    { id: "nebbia",   zh: "雾笺", en: "Nebbia"   },
    { id: "classic",  zh: "流光", en: "Classic"  },
    { id: "cadenza",  zh: "心象", en: "Cadenza"  },
    { id: "partita",  zh: "云阶", en: "Partita"  },
    { id: "fume",     zh: "浮名", en: "Fume"     },
    { id: "tilt",     zh: "倾诉", en: "Tilt"     },
    { id: "claddagh", zh: "回环", en: "Claddagh" },
    { id: "monet",    zh: "莫奈", en: "Monet"    },
    { id: "pendolo",  zh: "时计", en: "Pendolo"  },
    { id: "cappella", zh: "群唱", en: "Cappella" },
    { id: "diorama",  zh: "镜台", en: "Diorama"  },
    { id: "still",    zh: "静止", en: "Still"    },
  ];

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;

  /* ── release version, single source of truth ───────────────────────────── */
  const version = (root.getAttribute("data-release") || "").trim();
  if (version) {
    root.querySelectorAll('[data-release="v"]').forEach((el) => {
      el.textContent = "v" + version;
    });
    const year = String(new Date().getFullYear());
    root.querySelectorAll('[data-release="year"]').forEach((el) => {
      el.textContent = year;
    });
  }

  /* ── scroll spy: rail + top nav ────────────────────────────────────────── */
  const spyTargets = Array.from(
    document.querySelectorAll("[data-chapter]")
  ).map((link) => {
    const id = link.getAttribute("data-chapter");
    return { link, section: document.getElementById(id) };
  }).filter((entry) => entry.section);

  const topNavLinks = Array.from(document.querySelectorAll(".topbar__nav a"));

  if (spyTargets.length && "IntersectionObserver" in window) {
    const visible = new Map();
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const hit = spyTargets.find((t) => t.section === entry.target);
          if (!hit) return;
          if (entry.isIntersecting) visible.set(entry.target.id, entry.intersectionRatio);
          else visible.delete(entry.target.id);
        });
        let bestId = null;
        let bestRatio = -1;
        visible.forEach((ratio, id) => {
          if (ratio > bestRatio) { bestRatio = ratio; bestId = id; }
        });
        spyTargets.forEach(({ link, section }) => {
          const active = section.id === bestId;
          if (active) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        });
        topNavLinks.forEach((a) => {
          const active = bestId && a.getAttribute("href") === "#" + bestId;
          if (active) a.setAttribute("aria-current", "true");
          else a.removeAttribute("aria-current");
        });
      },
      { rootMargin: "-34% 0px -46% 0px", threshold: [0, 0.08, 0.24, 0.5, 0.76, 1] }
    );
    spyTargets.forEach(({ section }) => spy.observe(section));
  }

  /* ── top bar background on scroll ──────────────────────────────────────── */
  const topbar = document.getElementById("topbar");
  if (topbar) {
    const syncTopbar = () => topbar.classList.toggle("is-solid", window.scrollY > 32);
    syncTopbar();
    window.addEventListener("scroll", syncTopbar, { passive: true });
  }

  /* ── reveal on scroll ──────────────────────────────────────────────────── */
  const reveals = Array.from(document.querySelectorAll(".reveal"));
  if ("IntersectionObserver" in window && !reduceMotion.matches) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.06 }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  /* ── scene videos: never fetch on first paint ──────────────────────────── */
  /* Every <video preload="none"> gets its bytes only when it is about to be
     seen. The hero is on screen at load time, so it waits for the window
     `load` event — first paint shows the poster, not 1.7 MB of H.264. */
  const sceneVideos = Array.from(document.querySelectorAll("video[data-scene-video]"));
  const loadVideo = (video) => {
    if (video.dataset.loaded === "1") return;
    video.dataset.loaded = "1";
    video.load();
  };
  const playVideo = (video) => {
    if (reduceMotion.matches) return;
    const promise = video.play();
    if (promise && typeof promise.catch === "function") promise.catch(() => {});
  };

  const watchVideo = (video, rootMargin) => {
    if (!("IntersectionObserver" in window)) return;
    const vo = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            if (!entry.target.paused) entry.target.pause();
            return;
          }
          const active = entry.target;
          loadVideo(active);
          const onReady = () => {
            active.classList.add("is-ready");
            playVideo(active);
            active.removeEventListener("canplay", onReady);
          };
          if (active.readyState >= 2) onReady();
          else active.addEventListener("canplay", onReady);
        });
      },
      { threshold: 0.12, rootMargin: rootMargin }
    );
    vo.observe(video);
    return vo;
  };

  const deferVideos = [];
  if (sceneVideos.length) {
    sceneVideos.forEach((video) => {
      if (video.hasAttribute("data-defer")) deferVideos.push(video);
      else watchVideo(video, "200px 0px");
    });
  }

  if (deferVideos.length) {
    const startDeferred = () => {
      deferVideos.forEach((video) => {
        video.removeAttribute("data-defer");
        watchVideo(video, "120px 0px");
      });
    };
    if (document.readyState === "complete") startDeferred();
    else window.addEventListener("load", startDeferred, { once: true });
  }

  /* reduced motion can be toggled at runtime by the OS setting */
  const stopAllVideos = () => sceneVideos.forEach((v) => { if (!v.paused) v.pause(); });
  if (typeof reduceMotion.addEventListener === "function") {
    reduceMotion.addEventListener("change", (event) => {
      if (event.matches) stopAllVideos();
    });
  }

  /* ── gallery: 17 real style stills ─────────────────────────────────────── */
  const gallery = document.getElementById("gallery");
  const tiles = [];

  if (gallery) {
    const frag = document.createDocumentFragment();
    STYLES.forEach((style, index) => {
      const tile = document.createElement("button");
      tile.className = "tile";
      tile.type = "button";
      tile.setAttribute("role", "listitem");
      tile.dataset.styleId = style.id;
      tile.dataset.index = String(index);
      tile.style.transitionDelay = Math.min(index, 8) * 30 + "ms";
      tile.innerHTML =
        '<img src="assets/styles/' + style.id + '.jpg"' +
        ' alt="Folia「' + style.zh + '」样式：' + style.zh + '（' + style.en + '）渲染的逐字歌词画面"' +
        ' width="960" height="540" loading="lazy" decoding="async" />' +
        '<span class="tile__label"><b class="tile__zh">' + style.zh + "</b>" +
        '<i class="tile__en">' + style.en + "</i></span>";
      frag.appendChild(tile);
      tiles.push(tile);
    });
    gallery.appendChild(frag);

    /* staggered entrance */
    if ("IntersectionObserver" in window && !reduceMotion.matches) {
      const tio = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("is-in");
            tio.unobserve(entry.target);
          });
        },
        { rootMargin: "0px 0px -6% 0px", threshold: 0.04 }
      );
      tiles.forEach((tile) => tio.observe(tile));
    } else {
      tiles.forEach((tile) => tile.classList.add("is-in"));
    }
  }

  /* ── lightbox ──────────────────────────────────────────────────────────── */
  const lightbox = document.getElementById("lightbox");
  let lastFocused = null;
  let currentIndex = -1;

  const lightboxName = lightbox && lightbox.querySelector(".lb__name");
  const lightboxImg = lightbox && lightbox.querySelector(".lb__img");
  const lightboxCount = lightbox && lightbox.querySelector(".lb__count");
  const lightboxStage = lightbox && lightbox.querySelector(".lb__stage");

  const paintLightbox = (index) => {
    if (!lightboxName || !lightboxImg) return;
    const style = STYLES[index];
    if (!style) return;
    currentIndex = index;
    lightboxName.innerHTML =
      style.zh + "<small>" + style.en + "</small>";
    lightboxImg.src = "assets/styles/large/" + style.id + ".jpg";
    lightboxImg.alt =
      "Folia「" + style.zh + "」样式大图：" + style.zh + "（" + style.en + "）渲染的逐字歌词画面";
    if (lightboxCount) {
      lightboxCount.textContent = (index + 1) + " / " + STYLES.length;
    }
    lightboxImg.classList.remove("is-swap");
    /* force reflow so the fade restarts on every step */
    void lightboxImg.offsetWidth;
    lightboxImg.classList.add("is-swap");
  };

  const openLightbox = (index, trigger) => {
    if (!lightbox) return;
    lastFocused = trigger || null;
    paintLightbox(index);
    lightbox.hidden = false;
    lightbox.classList.add("is-open");
    document.body.style.overflow = "hidden";
    const closeBtn = lightbox.querySelector(".lb__close");
    if (closeBtn) closeBtn.focus();
  };

  const closeLightbox = () => {
    if (!lightbox || !lightbox.classList.contains("is-open")) return;
    lightbox.classList.remove("is-open");
    lightbox.hidden = true;
    document.body.style.overflow = "";
    if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus();
    lastFocused = null;
  };

  const stepLightbox = (delta) => {
    if (!lightbox || !lightbox.classList.contains("is-open")) return;
    const next = (currentIndex + delta + STYLES.length) % STYLES.length;
    paintLightbox(next);
  };

  if (gallery && lightbox) {
    gallery.addEventListener("click", (event) => {
      const tile = event.target.closest(".tile");
      if (!tile || !gallery.contains(tile)) return;
      openLightbox(Number(tile.dataset.index), tile);
    });

    lightbox.addEventListener("click", (event) => {
      const actionEl = event.target.closest("[data-lb-action]");
      if (actionEl) {
        const action = actionEl.getAttribute("data-lb-action");
        if (action === "close") closeLightbox();
        else if (action === "prev") stepLightbox(-1);
        else if (action === "next") stepLightbox(1);
        return;
      }
      /* click on the backdrop (not the image / bar / nav) closes */
      if (event.target === lightbox || event.target === lightboxStage) closeLightbox();
    });

    document.addEventListener("keydown", (event) => {
      if (!lightbox.classList.contains("is-open")) return;
      if (event.key === "Escape") { event.preventDefault(); closeLightbox(); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); stepLightbox(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); stepLightbox(1); }
      else if (event.key === "Tab") {
        /* keep focus inside the dialog */
        const focusables = lightbox.querySelectorAll("button, [href], img[tabindex]");
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    });
  }
})();
