export type LlmPlan = {
  sql: string;
  answer: string;
  viz: "table" | "pitch" | "none";
};

const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|execute|do|set\s+|reset|notify|listen|unlisten|vacuum|analyze|reindex|cluster|comment|security|owner|policy|function|procedure|trigger|extension|schema|database|role|user|password)\b/i;

const PUBLIC_RELATIONS =
  /\bpublic\.(teams|seasons|players|games|rosters|shots|v_our_shots|v_our_shots_official|v_our_games|v_brighton_shots|v_brighton_shots_official|v_brighton_games)\b/gi;

/** Raw stat tables models should avoid when curated views exist. */
const RAW_STAT_TABLES = /\b(from|join)\s+(public\.)?(shots|games)\b/i;

/**
 * Validate and normalize model-generated SQL for explore_readonly.
 * Must stay aligned with benchmark/sql_safety.py and migrate_explore.sql.
 *
 * Strips public. qualifiers so explore_readonly's search_path (explore, public)
 * resolves relations via explore.* views first.
 */
export function validateSql(sql: string): string {
  let cleaned = String(sql || "").trim();
  cleaned = cleaned.replace(/;\s*$/, "");
  if (!cleaned) throw new Error("Model returned empty SQL");
  if (/;\s*\S/.test(cleaned)) throw new Error("Multiple SQL statements are not allowed");
  if (!/^\s*(with|select)\b/i.test(cleaned)) {
    throw new Error("Only SELECT queries are allowed");
  }
  if (FORBIDDEN.test(cleaned)) throw new Error("Forbidden keyword in SQL");
  cleaned = cleaned.replace(PUBLIC_RELATIONS, "$1");
  if (!/\blimit\b/i.test(cleaned)) {
    cleaned = `SELECT * FROM (${cleaned}) AS explore_q LIMIT 100`;
  }
  return cleaned;
}

/** Optional guardrail: true when SQL bypasses v_our_* / v_brighton_* for raw shots/games. */
export function usesRawStatTables(sql: string): boolean {
  const s = String(sql || "");
  if (/\bv_(our|brighton)_(shots|shots_official|games)\b/i.test(s)) return false;
  return RAW_STAT_TABLES.test(s);
}

export function parsePlan(raw: string): LlmPlan {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text) as LlmPlan;
  if (!parsed || typeof parsed.sql !== "string") throw new Error("Invalid model response");
  const viz = parsed.viz === "pitch" || parsed.viz === "none" ? parsed.viz : "table";
  return {
    sql: parsed.sql,
    answer: String(parsed.answer || "").trim() || "Here is what I found.",
    viz,
  };
}
