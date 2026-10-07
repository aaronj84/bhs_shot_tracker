#!/usr/bin/env node
/**
 * Local mock of the Supabase REST + functions endpoints the scheduler uses.
 *
 *   node tests/fixtures/schedule-dev-server.mjs   # http://127.0.0.1:8787
 *
 * Point a local shots-config.js at it (supabaseUrl: "http://127.0.0.1:8787",
 * any non-placeholder anon key) and open http://127.0.0.1:8080/#schedule.
 * Seeds two days of meeting times. State is in memory only.
 */
import http from "node:http";
import { createScheduleDb } from "./schedule-pglite.mjs";

const PORT = Number(process.env.PORT || 8787);
const { rpc } = await createScheduleDb();

const login = await rpc("schedule_admin_login", { p_pin: "KEPPA" });
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
await rpc("schedule_admin_create_slots", {
  p_token: login.body.token,
  p_dates: [day(3), day(4)],
  p_start: "15:00",
  p_end: "17:00",
  p_duration: 20,
  p_gap: 0,
});

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m) {
      const out = await rpc(m[1], raw ? JSON.parse(raw) : {});
      res.writeHead(out.status, { ...cors, "Content-Type": "application/json" });
      return res.end(JSON.stringify(out.body));
    }
    if (url.pathname.startsWith("/functions/v1/")) {
      res.writeHead(200, { ...cors, "Content-Type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(404, cors);
    res.end();
  })
  .listen(PORT, "127.0.0.1", () => console.log(`schedule mock on http://127.0.0.1:${PORT}`));
