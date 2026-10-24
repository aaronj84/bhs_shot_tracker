/* Brighton Bengals Shot Tracker — shell / router */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function parseHash() {
    const raw = (location.hash || "#shots").replace(/^#/, "");
    const path = raw.split("?")[0];
    // Public scoreboard: #live/{gameId}
    if (path.startsWith("live/")) return "live-scoreboard";
    if (path === "shots-map") return "shots-map";
    if (path === "shots-games") return "shots-games";
    if (path === "shots-history") return "shots-history";
    if (path === "shots-prep" || path === "shots-explore") return "shots-prep";
    if (path === "shots-scoreboard") return "shots-scoreboard";
    if (path === "shots-bracket") return "shots-bracket";
    // Parents book at blue26/schedule/; inside the tracker, Schedule is the coach view.
    if (path === "schedule" || path === "schedule-admin") return "schedule-admin";
    if (path === "club" || path === "club-agenda") return "club-agenda";
    if (path === "club-itinerary") return "club-itinerary";
    if (path === "club-data") return "club-data";
    if (path === "shots" || !path || path === "home") return "shots";
    // Unknown hashes (old Blueprint links) land on the tracker home.
    return "shots";
  }

  function isSchedule(view) {
    return view === "schedule-admin";
  }

  function isClub(view) {
    return view === "club-agenda" || view === "club-itinerary" || view === "club-data";
  }

  const DEV_REF = "fmiymqnfezkqagpbrmoi";

  function isDevEnv(cfg) {
    const c = cfg || window.SHOTS_CONFIG || {};
    const env = String(c.env || "").toLowerCase();
    if (env === "dev" || env === "development") return true;
    if (env === "prod" || env === "production") return false;
    return String(c.supabaseUrl || "").includes(DEV_REF);
  }

  /** Orange chrome + block DEV logo when pointing at the DEV Supabase project. */
  function applyEnvChrome() {
    const cfg = window.SHOTS_CONFIG || {};
    const isDev = isDevEnv(cfg);
    document.body.classList.toggle("dev-env", isDev);
    const logo = $("a.brand img");
    if (logo) {
      if (isDev) {
        logo.setAttribute("src", "assets/logo-dev.svg");
        logo.setAttribute("alt", "DEV");
      } else if ((logo.getAttribute("src") || "").includes("logo-dev")) {
        logo.setAttribute("src", "assets/logo.svg");
        logo.removeAttribute("alt");
      }
    }
    return isDev;
  }

  function updateChrome(view) {
    document.body.classList.add("shots-mode", "tracker-view");
    document.body.classList.toggle("shots-record-view", view === "shots");
    document.body.classList.toggle("shot-map-view", view === "shots-map");
    document.body.classList.toggle("scoreboard-view", view === "shots-scoreboard" || view === "live-scoreboard");
    document.body.classList.toggle("schedule-view", isSchedule(view));
    document.body.classList.toggle("club-view", isClub(view));
    document.body.classList.toggle(
      "shots-admin-view",
      view === "shots-games" || view === "shots-history" || view === "shots-prep" || view === "shots-bracket"
    );
    const isDev = applyEnvChrome();
    const theme = document.querySelector('meta[name="theme-color"]');
    if (theme) {
      const scoreboard = view === "shots-scoreboard" || view === "live-scoreboard";
      theme.setAttribute("content", scoreboard ? "#0b1f33" : isDev ? "#f59e0b" : "#f4f7fb");
    }

    const cfg = window.SHOTS_CONFIG || {};
    const active = window.__SHOTS_ACTIVE_BRAND || {};
    const brandName = $("#brand-name");
    const brandSub = $("#brand-sub");
    if (brandName) brandName.textContent = active.brandName || cfg.brandName || "Brighton Bengals";
    if (brandSub) {
      let sub =
        active.brandSub != null
          ? String(active.brandSub)
          : cfg.brandSub != null
            ? String(cfg.brandSub)
            : "Shot Tracker";
      if (isDev && sub && !/\bdev\b/i.test(sub)) sub = `DEV · ${sub}`;
      else if (isDev && !sub) sub = "DEV";
      brandSub.textContent = sub;
      brandSub.hidden = !sub;
    }
    if (active.primaryColor && !isDev) {
      document.documentElement.style.setProperty("--brand", active.primaryColor);
      document.documentElement.style.setProperty("--ours", active.primaryColor);
    }
    // Team logos never override the DEV badge.
    if (active.logoPath && !isDev) {
      const logo = $("a.brand img");
      if (logo) logo.setAttribute("src", active.logoPath);
    }

    $$("[data-nav]").forEach((el) => {
      const key = el.getAttribute("data-nav");
      const current =
        (view === "shots" && key === "shots") ||
        (view === "shots-games" && key === "shots-games") ||
        (view === "shots-history" && key === "shots-history") ||
        (view === "shots-prep" && key === "shots-prep") ||
        (view === "shots-map" && key === "shots-map") ||
        (view === "shots-bracket" && key === "shots-bracket") ||
        (isSchedule(view) && key === "schedule") ||
        (isClub(view) && key === "club");
      if (current) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  function closeDrawer() {
    const drawer = $("#nav-drawer");
    const btn = $("#menu-btn");
    if (!drawer) return;
    drawer.classList.remove("is-open");
    drawer.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  function render() {
    const view = parseHash();
    updateChrome(view);
    const root = $("#app-root");
    // Public live scoreboard bypasses PIN check
    if (view === "live-scoreboard") {
      if (window.ShotTracker) window.ShotTracker.renderLiveScoreboard();
      else if (root) root.innerHTML = '<p class="empty-state">Shot tracker failed to load.</p>';
      window.scrollTo(0, 0);
      return;
    }
    // Schedule has its own server-checked PIN; it never boots the tracker or its PIN gate.
    if (isSchedule(view)) {
      if (window.Schedule) window.Schedule.render(view);
      else if (root) root.innerHTML = '<p class="empty-state">Scheduler failed to load.</p>';
    } else if (isClub(view)) {
      if (window.ClubVisitation) window.ClubVisitation.render(view);
      else if (root) root.innerHTML = '<p class="empty-state">Club visitation planner failed to load.</p>';
    } else if (window.ShotTracker) window.ShotTracker.render(view);
    else if (root) root.innerHTML = '<p class="empty-state">Shot tracker failed to load.</p>';
    window.scrollTo(0, 0);
  }

  $("#menu-btn")?.addEventListener("click", () => {
    const drawer = $("#nav-drawer");
    const btn = $("#menu-btn");
    if (!drawer) return;
    const open = !drawer.classList.contains("is-open");
    drawer.hidden = false;
    requestAnimationFrame(() => drawer.classList.toggle("is-open", open));
    if (!open) drawer.hidden = true;
    btn?.setAttribute("aria-expanded", open ? "true" : "false");
  });
  $("#nav-drawer")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-drawer], [data-nav]")) closeDrawer();
  });

  window.addEventListener("hashchange", () => {
    if (window.ShotTracker) {
      const view = parseHash();
      // onLeave only when leaving recording — shell stays on shots*
      if (!String(view).startsWith("shots")) window.ShotTracker.onLeave();
    }
    if (window.ClubVisitation && !isClub(parseHash())) {
      window.ClubVisitation.onLeave();
    }
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (window.ShotTracker && window.ShotTracker.onEscape()) return;
    closeDrawer();
  });

  function lockViewportScale() {
    const meta = document.querySelector('meta[name="viewport"]');
    if (meta) {
      meta.setAttribute(
        "content",
        "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
      );
    }
    const blockGesture = (e) => e.preventDefault();
    document.addEventListener("gesturestart", blockGesture, { passive: false });
    document.addEventListener("gesturechange", blockGesture, { passive: false });
    document.addEventListener("gestureend", blockGesture, { passive: false });
    document.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches && e.touches.length > 1) e.preventDefault();
        if (typeof e.scale === "number" && e.scale !== 1) e.preventDefault();
      },
      { passive: false }
    );
  }

  if (!location.hash || location.hash === "#" || location.hash === "#home") {
    location.replace("#shots");
  }
  lockViewportScale();
  applyEnvChrome();
  render();
})();
