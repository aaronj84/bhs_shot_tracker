/* Brighton Bengals Shot Tracker — shell / router */
(function () {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function parseHash() {
    const raw = (location.hash || "#shots").replace(/^#/, "");
    const path = raw.split("?")[0];
    if (path === "shots-map") return "shots-map";
    if (path === "shots-games") return "shots-games";
    if (path === "shots-history") return "shots-history";
    if (path === "shots-prep" || path === "shots-explore") return "shots-prep";
    if (path === "shots-scoreboard") return "shots-scoreboard";
    if (path === "shots" || !path || path === "home") return "shots";
    // Unknown hashes (old Blueprint links) land on the tracker home.
    return "shots";
  }

  function updateChrome(view) {
    document.body.classList.add("shots-mode", "tracker-view");
    document.body.classList.toggle("shot-map-view", view === "shots-map");
    document.body.classList.toggle("scoreboard-view", view === "shots-scoreboard");
    document.body.classList.toggle(
      "shots-admin-view",
      view === "shots-games" || view === "shots-history" || view === "shots-prep"
    );
    const theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.setAttribute("content", view === "shots-scoreboard" ? "#0b1f33" : "#f4f7fb");

    const cfg = window.SHOTS_CONFIG || {};
    const brandName = $("#brand-name");
    const brandSub = $("#brand-sub");
    if (brandName) brandName.textContent = cfg.brandName || "Brighton Bengals";
    if (brandSub) {
      const sub = cfg.brandSub != null ? String(cfg.brandSub) : "Shot Tracker";
      brandSub.textContent = sub;
      brandSub.hidden = !sub;
    }

    $$("[data-nav]").forEach((el) => {
      const key = el.getAttribute("data-nav");
      const current =
        (view === "shots" && key === "shots") ||
        (view === "shots-games" && key === "shots-games") ||
        (view === "shots-history" && key === "shots-history") ||
        (view === "shots-prep" && key === "shots-prep") ||
        (view === "shots-map" && key === "shots-map");
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
    if (window.ShotTracker) window.ShotTracker.render(view);
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
    render();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (window.ShotTracker && window.ShotTracker.onEscape()) return;
    closeDrawer();
  });

  if (!location.hash || location.hash === "#" || location.hash === "#home") {
    location.replace("#shots");
  }
  render();
})();
