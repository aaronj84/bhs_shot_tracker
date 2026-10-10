/**
 * Brighton Soccer — postseason player/parent meeting scheduler.
 *
 *   #schedule        public booking page (no staff PIN, no Supabase session)
 *   #schedule-admin  coach view; PIN is verified by the database, which returns
 *                    a session token kept in localStorage
 *
 * All data goes through schedule_* RPCs (see the postseason_schedule migration).
 * Families only ever receive slot times + Available/Booked.
 */
(function (global) {
  "use strict";

  const TZ = "America/Denver";
  const MEETING_LOCATION = "Shed @ Game Field";
  const LS_ADMIN_TOKEN = "bhs-schedule-admin-token";
  // Isolated parent page, relative to the tracker's index.html.
  const PARENT_PAGE = "blue26/schedule/";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const root = () => document.getElementById("app-root");

  const st = {
    view: "schedule-admin",
    pub: {
      loading: false,
      loaded: false,
      error: "",
      data: null,
      playerId: "",
      slotId: "",
      phone1: "",
      phone2: "",
      consent: false,
      submitting: false,
      formError: "",
      done: null,
    },
    admin: {
      token: readToken(),
      loading: false,
      error: "",
      pinError: "",
      data: null,
      tab: "bookings",
      editing: null,
      moving: null,
      booking: null,
      showPast: false,
      dates: [],
      busy: false,
    },
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showToast(text) {
    const el = $("#role-toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("is-visible");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.remove("is-visible"), 2600);
  }

  function readToken() {
    try {
      return localStorage.getItem(LS_ADMIN_TOKEN) || "";
    } catch (_) {
      return "";
    }
  }

  /** Parents never see a link out; a browser signed in to the scheduler gets the header as a way back. */
  function coachBackLink() {
    const header = $(".schedule-standalone-header");
    if (!header || !readToken() || $("a", header)) return;
    const link = document.createElement("a");
    link.href = "../../#schedule";
    link.className = "schedule-coach-back";
    link.setAttribute("aria-label", "Back to the coach schedule");
    link.append(...header.childNodes);
    header.append(link);
  }

  function writeToken(token) {
    try {
      if (token) localStorage.setItem(LS_ADMIN_TOKEN, token);
      else localStorage.removeItem(LS_ADMIN_TOKEN);
    } catch (_) {
      /* private mode */
    }
  }

  const fmtCache = {};
  function fmt(key, opts) {
    if (!fmtCache[key]) fmtCache[key] = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });
    return fmtCache[key];
  }

  const dayLabel = (iso) => fmt("day", { weekday: "long", month: "long", day: "numeric" }).format(new Date(iso));
  const shortDay = (iso) => fmt("sday", { weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
  const timeLabel = (iso) => fmt("time", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const stampLabel = (iso) =>
    fmt("stamp", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const dayKey = (iso) => {
    const parts = fmt("key", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value || "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  const endIso = (slot) => new Date(new Date(slot.starts_at).getTime() + slot.duration_minutes * 60000).toISOString();
  const rangeLabel = (slot) => `${timeLabel(slot.starts_at)}–${timeLabel(endIso(slot))}`;

  function todayDenver() {
    return dayKey(new Date().toISOString());
  }

  function groupByDay(slots) {
    const groups = [];
    const byKey = new Map();
    for (const s of slots) {
      const key = dayKey(s.starts_at);
      if (!byKey.has(key)) {
        const g = { key, label: dayLabel(s.starts_at), slots: [] };
        byKey.set(key, g);
        groups.push(g);
      }
      byKey.get(key).slots.push(s);
    }
    return groups;
  }

  function digits(v) {
    return String(v || "").replace(/\D/g, "");
  }

  /** Mirrors _schedule_norm_phone so families see mistakes before submitting. */
  function phoneProblem(v) {
    let d = digits(v);
    if (!d) return "";
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length !== 10 || "01".includes(d[0]) || "01".includes(d[3])) {
      return "Enter mobile numbers as 10-digit US numbers, like 801-555-0123.";
    }
    return "";
  }

  function prettyPhone(v) {
    let d = digits(v);
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v || "");
  }

  function client() {
    const api = global.ShotAPI;
    if (!api || !api.isConfigured() || api.isPlaceholderConfig()) return null;
    return api.getClient();
  }

  async function rpc(fn, args) {
    const sb = client();
    if (!sb) throw new Error("Scheduling is not configured on this site yet.");
    const { data, error } = await sb.rpc(fn, args || {});
    if (error) {
      const err = new Error(error.message || "Something went wrong. Try again.");
      err.auth = error.hint === "schedule_auth";
      throw err;
    }
    return data;
  }

  function icsForFamily(done) {
    const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const esc = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Brighton Soccer//Postseason Meetings//EN",
      "BEGIN:VEVENT",
      `UID:${done.booking_id}-family@bhs-shot-tracker`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(done.starts_at)}`,
      `DTEND:${stamp(endIso(done))}`,
      `SUMMARY:${esc(`Brighton Blue ’26 postseason meeting – ${done.player_name}`)}`,
      `LOCATION:${esc(MEETING_LOCATION)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT30M",
      `DESCRIPTION:${esc(`Postseason meeting – ${done.player_name}`)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  }

  // ---------------------------------------------------------------------------
  // Public booking page
  // ---------------------------------------------------------------------------

  async function loadPublic() {
    const p = st.pub;
    p.loading = true;
    p.error = "";
    draw();
    try {
      p.data = await rpc("schedule_public_state");
      p.loaded = true;
      const players = p.data.players || [];
      const open = (p.data.slots || []).filter((s) => !s.booked);
      if (p.playerId && !players.some((x) => x.id === p.playerId)) p.playerId = "";
      if (p.slotId && !open.some((x) => x.id === p.slotId)) p.slotId = "";
    } catch (err) {
      p.error = err.message;
    }
    p.loading = false;
    draw();
  }

  function renderPublic() {
    const p = st.pub;
    if (p.done) return renderConfirmation();
    if (!p.loaded) {
      root().innerHTML = `<div class="schedule-page"><p class="empty-state">${
        p.error ? escapeHtml(p.error) : "Loading meeting times…"
      }</p></div>`;
      return;
    }
    const players = p.data.players || [];
    const slots = p.data.slots || [];
    const openCount = slots.filter((s) => !s.booked).length;
    const duration = slots[0]?.duration_minutes || 20;
    const selected = slots.find((s) => s.id === p.slotId) || null;

    let body;
    if (!slots.length) {
      body = `<div class="schedule-card schedule-empty"><p><strong>Meeting times aren’t posted yet.</strong></p><p class="muted">Check back soon, or reach out to the coaching staff.</p></div>`;
    } else if (!openCount) {
      body = `<div class="schedule-card schedule-empty"><p><strong>Every meeting time is booked.</strong></p><p class="muted">Please contact the coaching staff to find a time.</p></div>${renderSlotGrid(slots, "")}`;
    } else {
      body = `
        <form class="schedule-form" id="schedule-form" novalidate>
          <section class="schedule-step">
            <h2><span class="schedule-step-num">1</span> Player</h2>
            ${
              players.length
                ? `<label class="sr-only" for="sched-player">Player</label>
                   <select id="sched-player" class="schedule-select" required>
                     <option value="">Choose your player</option>
                     ${players
                       .map(
                         (pl) =>
                           `<option value="${escapeHtml(pl.id)}"${pl.id === p.playerId ? " selected" : ""}>${escapeHtml(pl.name)}</option>`
                       )
                       .join("")}
                   </select>`
                : `<p class="muted">Every player already has a meeting. Contact the coaches with questions.</p>`
            }
          </section>

          <section class="schedule-step">
            <h2><span class="schedule-step-num">2</span> Meeting time</h2>
            <p class="schedule-hint">${duration}-minute meetings · Mountain Time · ${openCount} open</p>
            ${renderSlotGrid(slots, p.slotId)}
          </section>

          <section class="schedule-step">
            <h2><span class="schedule-step-num">3</span> Contact</h2>
            <label class="schedule-field">Mobile phone <span class="schedule-optional">optional · for a reminder text</span>
              <input type="tel" id="sched-phone1" class="text-gate-input" autocomplete="tel" inputmode="tel"
                value="${escapeHtml(p.phone1)}" placeholder="801-555-0123" />
            </label>
            <label class="schedule-field">Second mobile phone <span class="schedule-optional">optional</span>
              <input type="tel" id="sched-phone2" class="text-gate-input" inputmode="tel"
                value="${escapeHtml(p.phone2)}" placeholder="801-555-0123" />
            </label>
            <label class="schedule-consent">
              <input type="checkbox" id="sched-consent"${p.consent ? " checked" : ""} />
              <span>I understand I’m reserving this meeting time. If I entered a phone number, the coaches may text me a reminder.</span>
            </label>
          </section>

          <div class="schedule-submit">
            ${
              selected
                ? `<p class="schedule-selected">${escapeHtml(dayLabel(selected.starts_at))}<br><strong>${escapeHtml(rangeLabel(selected))}</strong> MT</p>`
                : ""
            }
            ${p.formError ? `<p class="shots-error" role="alert" id="sched-error">${escapeHtml(p.formError)}</p>` : ""}
            <button type="submit" class="btn btn-primary schedule-submit-btn"${p.submitting ? " disabled" : ""}>
              ${p.submitting ? "Reserving…" : "Reserve meeting"}
            </button>
          </div>
        </form>`;
    }

    root().innerHTML = `
      <div class="schedule-page">
        <header class="schedule-hero">
          <h1>Postseason Meetings</h1>
          <p class="muted">Pick a time for your player and a parent/guardian to meet with the coaching staff.</p>
        </header>
        ${p.error ? `<p class="shots-error">${escapeHtml(p.error)}</p>` : ""}
        ${body}
      </div>`;
    bindPublic();
  }

  function renderSlotGrid(slots, selectedId) {
    return groupByDay(slots)
      .map(
        (g) => `
        <div class="schedule-day">
          <h3>${escapeHtml(g.label)}</h3>
          <div class="schedule-times" role="radiogroup" aria-label="${escapeHtml(g.label)}">
            ${g.slots
              .map((s) => {
                const on = s.id === selectedId;
                return `<button type="button" class="schedule-time${on ? " is-on" : ""}${s.booked ? " is-booked" : ""}"
                  data-slot="${escapeHtml(s.id)}" role="radio" aria-checked="${on}"${s.booked ? " disabled" : ""}>
                  <span class="schedule-time-clock">${escapeHtml(timeLabel(s.starts_at))}</span>
                  <span class="schedule-time-state">${s.booked ? "Booked" : on ? "Selected" : "Available"}</span>
                </button>`;
              })
              .join("")}
          </div>
        </div>`
      )
      .join("");
  }

  function bindPublic() {
    const form = $("#schedule-form");
    if (!form) return;
    const p = st.pub;
    $("#sched-player")?.addEventListener("change", (e) => {
      p.playerId = e.target.value;
    });
    $("#sched-phone1")?.addEventListener("input", (e) => {
      p.phone1 = e.target.value;
    });
    $("#sched-phone2")?.addEventListener("input", (e) => {
      p.phone2 = e.target.value;
    });
    $("#sched-consent")?.addEventListener("change", (e) => {
      p.consent = e.target.checked;
    });
    $$("[data-slot]", form).forEach((btn) =>
      btn.addEventListener("click", () => {
        p.slotId = btn.getAttribute("data-slot");
        p.formError = "";
        const y = window.scrollY;
        draw();
        window.scrollTo(0, y);
      })
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitBooking();
    });
  }

  async function submitBooking() {
    const p = st.pub;
    const problem = !p.playerId
      ? "Choose your player."
      : !p.slotId
        ? "Pick a meeting time."
        : phoneProblem(p.phone1) || phoneProblem(p.phone2) || (!p.consent ? "Check the box to confirm your reservation." : "");
    if (problem) {
      p.formError = problem;
      draw();
      $("#sched-error")?.scrollIntoView({ block: "center" });
      return;
    }
    p.submitting = true;
    p.formError = "";
    draw();
    try {
      const res = await rpc("schedule_book", {
        p_player_id: p.playerId,
        p_slot_id: p.slotId,
        p_phone_1: p.phone1.trim() || null,
        p_phone_2: p.phone2.trim() || null,
        p_confirm: true,
      });
      p.done = { ...res, phones: [...new Set([p.phone1, p.phone2].filter((x) => digits(x)).map(prettyPhone))] };
      p.submitting = false;
      draw();
      window.scrollTo(0, 0);
    } catch (err) {
      p.submitting = false;
      p.formError = err.message;
      // Someone else may have taken the slot or player; refresh what's open.
      try {
        p.data = await rpc("schedule_public_state");
        if (!(p.data.slots || []).some((s) => s.id === p.slotId && !s.booked)) p.slotId = "";
        if (!(p.data.players || []).some((x) => x.id === p.playerId)) p.playerId = "";
      } catch (_) {
        /* keep the original error */
      }
      draw();
      $("#sched-error")?.scrollIntoView({ block: "center" });
    }
  }

  function renderConfirmation() {
    const d = st.pub.done;
    root().innerHTML = `
      <div class="schedule-page">
        <div class="schedule-card schedule-done" role="status">
          <div class="schedule-done-check" aria-hidden="true">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>
          </div>
          <h1>You’re booked</h1>
          <p class="schedule-done-player">${escapeHtml(d.player_name)}</p>
          <p class="schedule-done-when">${escapeHtml(dayLabel(d.starts_at))}<br><strong>${escapeHtml(rangeLabel(d))}</strong> Mountain Time<br>${escapeHtml(MEETING_LOCATION)}</p>
          <ul class="schedule-done-notes">
            <li>Add it to your calendar — it includes a reminder 30 minutes before.</li>
            ${
              d.phones?.length
                ? `<li>The coaches may text a reminder to ${d.phones.map((ph) => `<strong>${escapeHtml(ph)}</strong>`).join(" and ")}.</li>`
                : ""
            }
            <li>Need to change it? Contact Aaron.</li>
          </ul>
          <div class="schedule-done-actions">
            <a class="btn btn-primary" id="sched-add-cal" download="brighton-postseason-meeting.ics">Add to my calendar</a>
            <button type="button" class="btn btn-ghost" id="sched-another">Book another player</button>
          </div>
        </div>
      </div>`;
    const link = $("#sched-add-cal");
    if (link) link.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(icsForFamily(d))}`;
    $("#sched-another")?.addEventListener("click", () => {
      Object.assign(st.pub, { done: null, playerId: "", slotId: "", consent: false, formError: "" });
      loadPublic();
    });
  }

  // ---------------------------------------------------------------------------
  // Coach admin
  // ---------------------------------------------------------------------------

  function adminFail(err) {
    if (err.auth) {
      writeToken("");
      st.admin.token = "";
      st.admin.data = null;
      st.admin.pinError = err.message;
    } else {
      st.admin.error = err.message;
      showToast(err.message);
    }
    draw();
  }

  async function loadAdmin() {
    const a = st.admin;
    if (!a.token) return draw();
    a.loading = !a.data;
    a.error = "";
    draw();
    try {
      a.data = await rpc("schedule_admin_state", { p_token: a.token });
      a.loading = false;
      draw({ keepScroll: true });
    } catch (err) {
      a.loading = false;
      adminFail(err);
    }
  }

  async function adminAction(fn, args, okText) {
    const a = st.admin;
    if (a.busy) return null;
    a.busy = true;
    try {
      const res = await rpc(fn, { p_token: a.token, ...args });
      a.busy = false;
      if (okText) showToast(typeof okText === "function" ? okText(res) : okText);
      await loadAdmin();
      return res ?? true;
    } catch (err) {
      a.busy = false;
      adminFail(err);
      return null;
    }
  }

  function renderAdminLogin() {
    const a = st.admin;
    root().innerHTML = `
      <div class="schedule-page">
        <div class="shots-gate">
          <h1>Meeting scheduler</h1>
          <p>Coaches: enter the staff PIN to manage meeting times and bookings.</p>
          <form id="sched-pin-form" class="shots-pin-form">
            <label class="sr-only" for="sched-pin">PIN</label>
            <input id="sched-pin" class="text-gate-input" type="password" autocomplete="current-password" maxlength="64" />
            <button type="submit" class="btn btn-primary">Open scheduler</button>
          </form>
          ${a.pinError ? `<p class="shots-error" role="alert">${escapeHtml(a.pinError)}</p>` : ""}
          <p class="schedule-footer"><a href="${escapeHtml(PARENT_PAGE)}">Open the parent page</a></p>
        </div>
      </div>`;
    $("#sched-pin-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button");
      btn.disabled = true;
      try {
        const res = await rpc("schedule_admin_login", { p_pin: $("#sched-pin").value });
        if (!res || !res.ok) {
          a.pinError = res?.error || "Wrong PIN";
          renderAdminLogin();
          return;
        }
        a.pinError = "";
        a.token = res.token;
        writeToken(res.token);
        loadAdmin();
      } catch (err) {
        a.pinError = err.message;
        renderAdminLogin();
      }
    });
    requestAnimationFrame(() => $("#sched-pin")?.focus());
  }

  const TABS = [
    ["bookings", "Bookings"],
    ["add", "Add times"],
    ["players", "Players"],
    ["calendar", "Calendar"],
  ];

  function renderAdmin() {
    const a = st.admin;
    if (!a.token) return renderAdminLogin();
    if (!a.data) {
      root().innerHTML = `<div class="schedule-page"><p class="empty-state">${
        a.error ? escapeHtml(a.error) : "Loading…"
      }</p></div>`;
      return;
    }
    const d = a.data;
    const booked = d.slots.filter((s) => s.booking).length;
    const unbookedPlayers = d.players.filter((p) => p.active && !p.booked);
    let panel = "";
    if (a.tab === "add") panel = renderAddTimes();
    else if (a.tab === "players") panel = renderPlayers();
    else if (a.tab === "calendar") panel = renderCalendarTab();
    else panel = renderBookings();

    root().innerHTML = `
      <div class="schedule-page schedule-admin shots-admin">
        <div class="schedule-admin-head">
          <h1>Postseason Meetings</h1>
          <a class="btn btn-ghost schedule-public-link" href="${escapeHtml(PARENT_PAGE)}">Parent page</a>
        </div>
        <p class="muted schedule-summary">${booked} booked · ${d.slots.filter((s) => !s.booking && s.status === "open" && new Date(s.starts_at) > new Date()).length} open · ${unbookedPlayers.length} player${unbookedPlayers.length === 1 ? "" : "s"} not booked</p>
        <nav class="prep-tabs schedule-tabs" aria-label="Scheduler">
          ${TABS.map(
            ([id, label]) =>
              `<button type="button" class="prep-tab${a.tab === id ? " is-on" : ""}" data-tab="${id}"${
                a.tab === id ? ' aria-current="page"' : ""
              }>${label}</button>`
          ).join("")}
        </nav>
        ${panel}
      </div>`;
    bindAdmin();
  }

  function playerOptions(selectedId, includeId) {
    return st.admin.data.players
      .filter((p) => (p.active && !p.booked) || p.id === includeId)
      .map(
        (p) => `<option value="${escapeHtml(p.id)}"${p.id === selectedId ? " selected" : ""}>${escapeHtml(p.name)}</option>`
      )
      .join("");
  }

  function contactFields(b) {
    return `
      <label class="schedule-field">Mobile 1
        <input type="tel" class="text-gate-input" name="phone1" value="${escapeHtml(b?.phone_1 ? prettyPhone(b.phone_1) : "")}" />
      </label>
      <label class="schedule-field">Mobile 2
        <input type="tel" class="text-gate-input" name="phone2" value="${escapeHtml(b?.phone_2 ? prettyPhone(b.phone_2) : "")}" />
      </label>`;
  }

  function formContact(form) {
    return {
      p_phone_1: form.phone1.value.trim() || null,
      p_phone_2: form.phone2.value.trim() || null,
    };
  }

  function renderSlotCard(s) {
    const a = st.admin;
    const b = s.booking;
    const past = new Date(s.starts_at) <= new Date();
    const chip = b
      ? `<span class="schedule-chip is-booked">Booked</span>`
      : s.status === "closed"
        ? `<span class="schedule-chip is-closed">Closed</span>`
        : past
          ? `<span class="schedule-chip is-closed">Past</span>`
          : `<span class="schedule-chip is-open">Open</span>`;
    let inner = "";
    if (b && a.editing === b.id) {
      inner = `
        <form class="schedule-inline" data-edit-form="${escapeHtml(b.id)}">
          <label class="schedule-field">Player
            <select name="player" class="schedule-select">${playerOptions(b.player_id, b.player_id)}</select>
          </label>
          ${contactFields(b)}
          <div class="schedule-row-actions">
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="button" class="btn btn-ghost" data-act="close-inline">Cancel</button>
          </div>
        </form>`;
    } else if (b && a.moving === b.id) {
      const free = a.data.slots.filter(
        (x) => !x.booking && x.status === "open" && new Date(x.starts_at) > new Date()
      );
      inner = free.length
        ? `<form class="schedule-inline" data-move-form="${escapeHtml(b.id)}">
            <label class="schedule-field">Move ${escapeHtml(b.player_name)} to
              <select name="slot" class="schedule-select">
                ${free
                  .map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(`${shortDay(x.starts_at)} · ${timeLabel(x.starts_at)}`)}</option>`)
                  .join("")}
              </select>
            </label>
            <p class="muted schedule-small">Let the family know the new time — their calendar won’t update on its own.</p>
            <div class="schedule-row-actions">
              <button type="submit" class="btn btn-primary">Move</button>
              <button type="button" class="btn btn-ghost" data-act="close-inline">Cancel</button>
            </div>
          </form>`
        : `<p class="muted">No open times to move to. Add times first.</p>
           <div class="schedule-row-actions"><button type="button" class="btn btn-ghost" data-act="close-inline">Back</button></div>`;
    } else if (b) {
      inner = `
        <p class="schedule-booked-name">${escapeHtml(b.player_name)}</p>
        ${[b.phone_1, b.phone_2]
          .filter(Boolean)
          .map((ph) => `<p class="schedule-contact"><a href="tel:${escapeHtml(ph)}">${escapeHtml(prettyPhone(ph))}</a></p>`)
          .join("")}
        <p class="muted schedule-small">Booked ${escapeHtml(stampLabel(b.booked_at))}</p>
        <div class="schedule-row-actions">
          <button type="button" class="btn btn-secondary" data-act="edit" data-id="${escapeHtml(b.id)}">Edit</button>
          <button type="button" class="btn btn-secondary" data-act="move" data-id="${escapeHtml(b.id)}">Move</button>
          <button type="button" class="btn btn-ghost schedule-danger" data-act="cancel" data-id="${escapeHtml(b.id)}" data-name="${escapeHtml(b.player_name)}">Cancel</button>
        </div>`;
    } else if (a.booking === s.id) {
      inner = `
        <form class="schedule-inline" data-book-form="${escapeHtml(s.id)}">
          <label class="schedule-field">Player
            <select name="player" class="schedule-select" required>
              <option value="">Choose player</option>
              ${playerOptions("", null)}
            </select>
          </label>
          ${contactFields(null)}
          <div class="schedule-row-actions">
            <button type="submit" class="btn btn-primary">Book</button>
            <button type="button" class="btn btn-ghost" data-act="close-inline">Cancel</button>
          </div>
        </form>`;
    } else {
      inner = `
        <div class="schedule-row-actions">
          ${
            s.status === "open" && !past
              ? `<button type="button" class="btn btn-secondary" data-act="book" data-slot-id="${escapeHtml(s.id)}">Book for a family</button>
                 <button type="button" class="btn btn-ghost" data-act="close-slot" data-slot-id="${escapeHtml(s.id)}">Close</button>`
              : s.status === "closed"
                ? `<button type="button" class="btn btn-secondary" data-act="open-slot" data-slot-id="${escapeHtml(s.id)}">Reopen</button>`
                : ""
          }
          ${
            !s.has_history
              ? `<button type="button" class="btn btn-ghost schedule-danger" data-act="delete-slot" data-slot-id="${escapeHtml(s.id)}">Delete</button>`
              : ""
          }
        </div>`;
    }
    return `
      <article class="schedule-slot${b ? " is-booked" : ""}${s.status === "closed" ? " is-closed" : ""}">
        <div class="schedule-slot-head">
          <span class="schedule-slot-time">${escapeHtml(rangeLabel(s))}</span>
          ${chip}
        </div>
        ${inner}
      </article>`;
  }

  function renderBookings() {
    const a = st.admin;
    const d = a.data;
    const cutoff = Date.now() - 2 * 3600 * 1000;
    const visible = d.slots.filter((s) => a.showPast || new Date(s.starts_at).getTime() >= cutoff);
    const hiddenPast = d.slots.length - visible.length;
    const unbooked = d.players.filter((p) => p.active && !p.booked);
    const groups = groupByDay(visible);
    return `
      ${
        unbooked.length
          ? `<details class="schedule-card schedule-unbooked"><summary>${unbooked.length} player${
              unbooked.length === 1 ? "" : "s"
            } not booked yet</summary><p>${unbooked.map((p) => escapeHtml(p.name)).join(", ")}</p></details>`
          : d.players.length
            ? `<p class="schedule-allset">Every active player is booked.</p>`
            : ""
      }
      ${
        groups.length
          ? groups
              .map(
                (g) => `<section class="schedule-admin-day"><h2>${escapeHtml(g.label)}</h2>${g.slots.map(renderSlotCard).join("")}</section>`
              )
              .join("")
          : `<div class="schedule-card schedule-empty"><p><strong>No meeting times yet.</strong></p><button type="button" class="btn btn-primary" data-tab="add">Add times</button></div>`
      }
      ${
        hiddenPast
          ? `<button type="button" class="btn btn-ghost schedule-wide" data-act="show-past">Show ${hiddenPast} past time${hiddenPast === 1 ? "" : "s"}</button>`
          : a.showPast
            ? `<button type="button" class="btn btn-ghost schedule-wide" data-act="hide-past">Hide past times</button>`
            : ""
      }
      ${
        d.cancelled.length
          ? `<details class="schedule-card schedule-cancelled"><summary>Cancelled (${d.cancelled.length})</summary>
              <ul>${d.cancelled
                .map(
                  (c) =>
                    `<li><strong>${escapeHtml(c.player_name)}</strong> · ${escapeHtml(shortDay(c.starts_at))} ${escapeHtml(
                      timeLabel(c.starts_at)
                    )}<span class="muted"> · cancelled ${escapeHtml(stampLabel(c.cancelled_at))}</span></li>`
                )
                .join("")}</ul></details>`
          : ""
      }`;
  }

  function addTimesForm() {
    const f = $("#sched-add-form");
    if (!f) return null;
    return {
      date: f.date.value,
      start: f.start.value,
      end: f.end.value,
      duration: Number(f.duration.value),
      gap: Number(f.gap.value),
    };
  }

  function previewTimes(v) {
    if (!v || !v.start || !v.duration) return [];
    const toMin = (t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };
    const start = toMin(v.start);
    const stop = v.end ? toMin(v.end) : start + v.duration;
    const out = [];
    for (let t = start; t + v.duration <= stop && out.length < 300; t += v.duration + v.gap) out.push(t);
    return out.map((t) => {
      const h = Math.floor(t / 60);
      const m = t % 60;
      return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    });
  }

  function renderPreview() {
    const el = $("#sched-add-preview");
    if (!el) return;
    const v = addTimesForm();
    const times = previewTimes(v);
    const dates = st.admin.dates.length ? st.admin.dates : v.date ? [v.date] : [];
    if (!dates.length || !times.length) {
      el.textContent = v.end && times.length === 0 ? "End time must be at least one meeting after the start." : "";
      return;
    }
    const total = times.length * dates.length;
    el.innerHTML = `<strong>${total} time${total === 1 ? "" : "s"}</strong>${
      dates.length > 1 ? ` (${times.length} × ${dates.length} days)` : ""
    }: ${escapeHtml(times.slice(0, 12).join(", "))}${times.length > 12 ? "…" : ""}`;
  }

  function dateChipLabel(key) {
    return shortDay(`${key}T18:00:00Z`);
  }

  function renderAddTimes() {
    const a = st.admin;
    const dur = a.data.settings?.default_duration || 20;
    return `
      <form id="sched-add-form" class="schedule-card schedule-add">
        <p class="muted schedule-small">Times are Mountain Time. Leave “Last meeting ends” blank to add a single time.</p>
        <div class="schedule-grid2">
          <label class="schedule-field">Date
            <input type="date" name="date" class="text-gate-input" min="${todayDenver()}" />
          </label>
          <div class="schedule-field schedule-add-date">
            <span aria-hidden="true">&nbsp;</span>
            <button type="button" class="btn btn-ghost" data-act="add-date">+ Another day</button>
          </div>
        </div>
        ${
          a.dates.length
            ? `<div class="schedule-date-chips">${a.dates
                .map(
                  (k) =>
                    `<button type="button" class="plays-filter-btn is-on" data-act="drop-date" data-date="${k}" aria-label="Remove ${escapeHtml(
                      dateChipLabel(k)
                    )}">${escapeHtml(dateChipLabel(k))} ✕</button>`
                )
                .join("")}</div>`
            : ""
        }
        <div class="schedule-grid2">
          <label class="schedule-field">First meeting starts
            <input type="time" name="start" class="text-gate-input" value="15:00" step="300" required />
          </label>
          <label class="schedule-field">Last meeting ends
            <input type="time" name="end" class="text-gate-input" value="17:00" step="300" />
          </label>
          <label class="schedule-field">Meeting length
            <select name="duration" class="schedule-select">
              ${[10, 15, 20, 25, 30, 45, 60]
                .map((m) => `<option value="${m}"${m === dur ? " selected" : ""}>${m} min</option>`)
                .join("")}
            </select>
          </label>
          <label class="schedule-field">Break between
            <select name="gap" class="schedule-select">
              ${[0, 5, 10, 15].map((m) => `<option value="${m}">${m ? `${m} min` : "None"}</option>`).join("")}
            </select>
          </label>
        </div>
        <p class="schedule-preview" id="sched-add-preview" aria-live="polite"></p>
        <button type="submit" class="btn btn-primary schedule-wide"${a.busy ? " disabled" : ""}>Add meeting times</button>
      </form>`;
  }

  function renderPlayers() {
    const players = st.admin.data.players;
    return `
      <form id="sched-player-add" class="schedule-card schedule-player-add">
        <label class="schedule-field">Add a player
          <input type="text" name="pname" class="text-gate-input" maxlength="80" autocomplete="off" placeholder="Name as families know it" />
        </label>
        <button type="submit" class="btn btn-primary">Add</button>
      </form>
      <p class="muted schedule-small">Only active players appear on the parent page. A booked player drops off the list until their booking is cancelled.</p>
      <ul class="schedule-players">
        ${players
          .map(
            (p) => `
          <li class="schedule-player${p.active ? "" : " is-inactive"}">
            <form data-player-form="${escapeHtml(p.id)}" class="schedule-player-form">
              <label class="sr-only" for="pl-${escapeHtml(p.id)}">Name</label>
              <input id="pl-${escapeHtml(p.id)}" type="text" name="pname" class="text-gate-input" value="${escapeHtml(p.name)}" maxlength="80" />
              <label class="schedule-active"><input type="checkbox" name="active"${p.active ? " checked" : ""} /> Active</label>
              <button type="submit" class="btn btn-secondary">Save</button>
            </form>
            ${p.booked ? `<span class="schedule-chip is-booked">Booked</span>` : ""}
          </li>`
          )
          .join("")}
      </ul>`;
  }

  /** One group text per upcoming meeting day: numbers to paste into Messages, plus a draft. */
  function renderTextGroups() {
    const today = todayDenver();
    const booked = st.admin.data.slots.filter((x) => x.booking && dayKey(x.starts_at) >= today);
    const days = groupByDay(booked);
    const body = days.length
      ? days
          .map((g) => {
            const numbers = [];
            const missing = [];
            for (const s of g.slots) {
              const phones = [s.booking.phone_1, s.booking.phone_2].filter(Boolean);
              if (!phones.length) missing.push(s.booking.player_name);
              for (const ph of phones) if (!numbers.includes(ph)) numbers.push(ph);
            }
            const list = numbers.join(", ");
            const times = g.slots.map((s) => `${s.booking.player_name} ${timeLabel(s.starts_at)}`).join(", ");
            const message = `Reminder: Brighton Blue ’26 postseason meetings are ${g.label}. ${times}. See you there!`;
            return `
              <div class="schedule-text-day">
                <h3>${escapeHtml(g.label)} <span class="muted">· ${g.slots.length} meeting${g.slots.length === 1 ? "" : "s"}</span></h3>
                ${
                  numbers.length
                    ? `<textarea class="text-gate-input schedule-copy" readonly rows="2" aria-label="Phone numbers for ${escapeHtml(g.label)}">${escapeHtml(list)}</textarea>
                       <div class="schedule-row-actions">
                         <button type="button" class="btn btn-secondary" data-act="copy" data-copy="${escapeHtml(list)}" data-done="Numbers copied">Copy ${numbers.length} number${numbers.length === 1 ? "" : "s"}</button>
                         <button type="button" class="btn btn-ghost" data-act="copy" data-copy="${escapeHtml(message)}" data-done="Message copied">Copy message</button>
                       </div>`
                    : `<p class="muted schedule-small">No numbers for this day.</p>`
                }
                ${missing.length ? `<p class="muted schedule-small">No number: ${escapeHtml(missing.join(", "))}</p>` : ""}
              </div>`;
          })
          .join("")
      : `<p class="muted">No upcoming meetings.</p>`;
    return `
      <section class="schedule-card">
        <h2>Text messages</h2>
        <p class="muted schedule-small">One group text per day. Copy the numbers and paste them into the To field of a new message.</p>
        ${body}
      </section>`;
  }

  function renderCalendarTab() {
    const d = st.admin.data;
    const s = d.settings || {};
    const base = String(global.SHOTS_CONFIG?.supabaseUrl || "").replace(/\/+$/, "");
    const feed = s.feed_token ? `${base}/functions/v1/schedule-ics/${s.feed_token}.ics` : "";
    const webcal = feed.replace(/^https?:/, "webcal:");
    return `
      ${renderTextGroups()}
      <section class="schedule-card">
        <h2>Private calendar feed</h2>
        <p class="muted schedule-small">Subscribe in Apple Calendar or Outlook. Alerts: 60 and 15 minutes before each day’s first meeting (30 and 5 after an hour-plus break), 5 minutes before the rest. On a Mac, uncheck “Remove alerts” when subscribing. Anyone with this link can see parent phone numbers. Share it only with staff.</p>
        <label class="sr-only" for="sched-feed">Feed URL</label>
        <input id="sched-feed" class="text-gate-input schedule-feed" readonly value="${escapeHtml(feed)}" />
        <div class="schedule-row-actions">
          <button type="button" class="btn btn-secondary" data-act="copy-feed">Copy link</button>
          <a class="btn btn-ghost" href="${escapeHtml(webcal)}">Subscribe on this device</a>
          <button type="button" class="btn btn-ghost schedule-danger" data-act="rotate-feed">New link</button>
        </div>
      </section>
      <section class="schedule-card">
        <h2>Scheduler PIN</h2>
        <p class="muted schedule-small">Starts as the staff PIN. Changing it signs out other devices.</p>
        <form id="sched-pin-change" class="schedule-player-add">
          <label class="sr-only" for="sched-new-pin">New PIN</label>
          <input id="sched-new-pin" name="pin" type="password" class="text-gate-input" minlength="4" maxlength="64" autocomplete="new-password" placeholder="New PIN" />
          <button type="submit" class="btn btn-secondary">Change</button>
        </form>
      </section>
      <button type="button" class="btn btn-ghost schedule-wide" data-act="logout">Sign out of scheduler</button>`;
  }

  function bindAdmin() {
    const a = st.admin;
    const page = $(".schedule-admin");
    if (!page) return;

    page.addEventListener("click", async (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) {
        a.tab = tab.getAttribute("data-tab");
        a.editing = a.moving = a.booking = null;
        draw();
        return;
      }
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id");
      const slotId = btn.getAttribute("data-slot-id");
      const keep = () => draw({ keepScroll: true });
      if (act === "edit") {
        a.editing = id;
        a.moving = a.booking = null;
        keep();
      } else if (act === "move") {
        a.moving = id;
        a.editing = a.booking = null;
        keep();
      } else if (act === "book") {
        a.booking = slotId;
        a.editing = a.moving = null;
        keep();
      } else if (act === "close-inline") {
        a.editing = a.moving = a.booking = null;
        keep();
      } else if (act === "cancel") {
        if (!confirm(`Cancel ${btn.getAttribute("data-name")}'s meeting? The time opens back up for other families.`)) return;
        adminAction("schedule_admin_cancel_booking", { p_booking_id: id }, "Booking cancelled");
      } else if (act === "close-slot" || act === "open-slot") {
        adminAction(
          "schedule_admin_set_slot_status",
          { p_slot_id: slotId, p_status: act === "close-slot" ? "closed" : "open" },
          act === "close-slot" ? "Time closed" : "Time reopened"
        );
      } else if (act === "delete-slot") {
        if (!confirm("Delete this meeting time?")) return;
        adminAction("schedule_admin_delete_slot", { p_slot_id: slotId }, "Time deleted");
      } else if (act === "show-past" || act === "hide-past") {
        a.showPast = act === "show-past";
        keep();
      } else if (act === "add-date") {
        const v = addTimesForm();
        if (v?.date && !a.dates.includes(v.date)) a.dates = [...a.dates, v.date].sort();
        keep();
      } else if (act === "drop-date") {
        a.dates = a.dates.filter((k) => k !== btn.getAttribute("data-date"));
        keep();
      } else if (act === "copy") {
        try {
          await navigator.clipboard.writeText(btn.getAttribute("data-copy") || "");
          showToast(btn.getAttribute("data-done") || "Copied");
        } catch (_) {
          btn.closest(".schedule-text-day")?.querySelector("textarea")?.select();
        }
      } else if (act === "copy-feed") {
        const v = $("#sched-feed")?.value || "";
        try {
          await navigator.clipboard.writeText(v);
          showToast("Feed link copied");
        } catch (_) {
          $("#sched-feed")?.select();
        }
      } else if (act === "rotate-feed") {
        if (!confirm("Make a new feed link? Anyone subscribed to the old link (including Sarah and Ryan) must re-subscribe.")) return;
        adminAction("schedule_admin_rotate_feed", {}, "New feed link created");
      } else if (act === "logout") {
        rpc("schedule_admin_logout", { p_token: a.token }).catch(() => {});
        writeToken("");
        Object.assign(a, { token: "", data: null, pinError: "" });
        draw();
      }
    });

    page.addEventListener("submit", async (e) => {
      const form = e.target;
      e.preventDefault();
      if (form.id === "sched-add-form") {
        const v = addTimesForm();
        const dates = a.dates.length ? a.dates : v.date ? [v.date] : [];
        if (!dates.length) return showToast("Pick a date");
        const res = await adminAction(
          "schedule_admin_create_slots",
          { p_dates: dates, p_start: v.start, p_end: v.end || null, p_duration: v.duration, p_gap: v.gap },
          (r) => `Added ${r.created} time${r.created === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already existed)` : ""}`
        );
        if (res) {
          a.dates = [];
          a.tab = "bookings";
          draw();
        }
      } else if (form.matches("[data-edit-form]")) {
        const ok = await adminAction(
          "schedule_admin_update_booking",
          { p_booking_id: form.getAttribute("data-edit-form"), p_player_id: form.player.value, ...formContact(form) },
          "Booking updated"
        );
        if (ok) {
          a.editing = null;
          draw({ keepScroll: true });
        }
      } else if (form.matches("[data-move-form]")) {
        const ok = await adminAction(
          "schedule_admin_move_booking",
          { p_booking_id: form.getAttribute("data-move-form"), p_slot_id: form.slot.value },
          "Booking moved"
        );
        if (ok) {
          a.moving = null;
          draw({ keepScroll: true });
        }
      } else if (form.matches("[data-book-form]")) {
        if (!form.player.value) return showToast("Choose a player");
        const ok = await adminAction(
          "schedule_admin_book",
          { p_slot_id: form.getAttribute("data-book-form"), p_player_id: form.player.value, ...formContact(form) },
          "Booked"
        );
        if (ok) {
          a.booking = null;
          draw({ keepScroll: true });
        }
      } else if (form.id === "sched-player-add") {
        const name = form.pname.value.trim();
        if (!name) return;
        adminAction("schedule_admin_save_player", { p_player_id: null, p_name: name, p_active: true }, `Added ${name}`);
      } else if (form.matches("[data-player-form]")) {
        adminAction(
          "schedule_admin_save_player",
          { p_player_id: form.getAttribute("data-player-form"), p_name: form.pname.value, p_active: form.active.checked },
          "Player saved"
        );
      } else if (form.id === "sched-pin-change") {
        const pin = form.pin.value.trim();
        if (pin.length < 4) return showToast("PIN must be at least 4 characters");
        adminAction("schedule_admin_change_pin", { p_new_pin: pin }, "Scheduler PIN changed");
      }
    });

    const add = $("#sched-add-form");
    if (add) {
      add.addEventListener("input", renderPreview);
      add.addEventListener("change", renderPreview);
      renderPreview();
    }
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  function draw(opts = {}) {
    if (!root() || !String(st.view).startsWith("schedule")) return;
    const y = window.scrollY;
    if (st.view === "schedule-admin") renderAdmin();
    else renderPublic();
    if (opts.keepScroll) window.scrollTo(0, y);
  }

  global.Schedule = {
    /** "schedule-public" only from blue26/schedule/; everything else is the coach view. */
    render(view) {
      st.view = view === "schedule-public" ? "schedule-public" : "schedule-admin";
      if (!client()) {
        root().innerHTML = `<div class="schedule-page"><p class="empty-state">Scheduling isn’t configured on this site yet.</p></div>`;
        return;
      }
      if (st.view === "schedule-admin") {
        draw();
        if (st.admin.token) loadAdmin();
      } else {
        coachBackLink();
        draw();
        loadPublic();
      }
    },
  };
})(window);
