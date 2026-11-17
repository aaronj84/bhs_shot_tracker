import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  EMPTY_RESULT_REPAIR,
  NARRATE_PROMPT,
  PROMPT_VERSION,
  SCHEMA_PROMPT,
} from "./prompts.ts";
import type { ChatCompletionResult, LlmProvider, TokenUsage } from "./providers/types.ts";
import { parsePlan, validateSql, type LlmPlan } from "./sql.ts";

export { PROMPT_VERSION, SCHEMA_PROMPT, NARRATE_PROMPT, EMPTY_RESULT_REPAIR };
export { validateSql, parsePlan };

export type ExploreHistoryMessage = { role: string; content: string };

export type ExplorePipelineParams = {
  provider: LlmProvider;
  model: string;
  question: string;
  history?: ExploreHistoryMessage[];
  /** Service-role client used for explore_readonly */
  admin: SupabaseClient;
  planTemperature?: number;
  narrateTemperature?: number;
};

export type LlmCallTrace = {
  stage: "sql_generation" | "sql_repair" | "result_narration";
  provider: string;
  model: string;
  usage: TokenUsage;
  latency_ms: number;
  retries: number;
  success: boolean;
  error?: string;
  content?: string;
};

export type ExplorePipelineResult = {
  success: boolean;
  answer: string;
  viz: LlmPlan["viz"];
  sql: string | null;
  columns: string[];
  rows: unknown[];
  sql_execution_success: boolean | null;
  sql_error: string | null;
  sql_execution_ms: number | null;
  error: string | null;
  error_kind:
    | null
    | "api_error"
    | "invalid_response"
    | "sql_generation_failure"
    | "unsafe_sql"
    | "sql_execution_failure"
    | "result_analysis_failure"
    | "timeout"
    | "rate_limit"
    | "other";
  llm_calls: LlmCallTrace[];
  total_usage: TokenUsage;
  total_llm_latency_ms: number;
  total_latency_ms: number;
  prompt_version: string;
  model: string;
  provider: string;
  plan_temperature: number;
  narrate_temperature: number;
};

function emptyUsage(): TokenUsage {
  return {};
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const keys = [
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "total_tokens",
  ] as const;
  const out: TokenUsage = {};
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (av == null && bv == null) continue;
    out[k] = (av ?? 0) + (bv ?? 0);
  }
  return out;
}

function classifyError(err: unknown): ExplorePipelineResult["error_kind"] {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("429") || lower.includes("rate")) return "rate_limit";
  if (lower.includes("timeout") || lower.includes("abort")) return "timeout";
  if (lower.includes("forbidden keyword") || lower.includes("only select") || lower.includes("multiple sql")) {
    return "unsafe_sql";
  }
  if (lower.includes("invalid model") || lower.includes("json")) return "invalid_response";
  if (lower.includes("http")) return "api_error";
  return "other";
}

function buildPlanMessages(
  question: string,
  history: ExploreHistoryMessage[],
): { role: "system" | "user" | "assistant"; content: string }[] {
  const trimmed = Array.isArray(history) ? history.slice(-6) : [];
  return [
    { role: "system", content: SCHEMA_PROMPT },
    ...trimmed
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: String(m.content).slice(0, 1500),
      })),
    { role: "user", content: question },
  ];
}

function traceFromResult(
  stage: LlmCallTrace["stage"],
  result: ChatCompletionResult,
  success = true,
  error?: string,
): LlmCallTrace {
  return {
    stage,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
    latency_ms: result.latency_ms,
    retries: result.retries,
    success,
    error,
    content: result.content,
  };
}

/**
 * Production Explore pipeline: plan SQL → validate → explore_readonly
 * → (optional zero-row repair) → narrate.
 * Used by the edge function and mirrored by the Python benchmark harness.
 */
export async function runExploreAnalysis(
  params: ExplorePipelineParams,
): Promise<ExplorePipelineResult> {
  const planTemperature = params.planTemperature ?? 0.1;
  const narrateTemperature = params.narrateTemperature ?? 0.2;
  const t0 = Date.now();
  const llmCalls: LlmCallTrace[] = [];
  let totalUsage = emptyUsage();
  let totalLlmLatency = 0;

  const base = {
    viz: "table" as const,
    sql: null as string | null,
    columns: [] as string[],
    rows: [] as unknown[],
    sql_execution_success: null as boolean | null,
    sql_error: null as string | null,
    sql_execution_ms: null as number | null,
    prompt_version: PROMPT_VERSION,
    model: params.model,
    provider: params.provider.id,
    plan_temperature: planTemperature,
    narrate_temperature: narrateTemperature,
  };

  const question = String(params.question || "").trim();
  if (!question) {
    return {
      ...base,
      success: false,
      answer: "",
      error: "Ask a question about the shot data",
      error_kind: "other",
      llm_calls: [],
      total_usage: emptyUsage(),
      total_llm_latency_ms: 0,
      total_latency_ms: Date.now() - t0,
    };
  }

  let plan: LlmPlan;
  let sql: string;
  try {
    const planResult = await params.provider.complete({
      model: params.model,
      temperature: planTemperature,
      json_object: true,
      messages: buildPlanMessages(question, params.history || []),
    });
    totalUsage = addUsage(totalUsage, planResult.usage);
    totalLlmLatency += planResult.latency_ms;
    llmCalls.push(traceFromResult("sql_generation", planResult));
    base.model = planResult.model || params.model;

    plan = parsePlan(planResult.content);
    sql = validateSql(plan.sql);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = classifyError(err);
    return {
      ...base,
      success: false,
      answer: "",
      error: msg,
      error_kind: kind === "unsafe_sql" ? "unsafe_sql" : kind === "invalid_response" ? "invalid_response" : "sql_generation_failure",
      llm_calls: llmCalls,
      total_usage: totalUsage,
      total_llm_latency_ms: totalLlmLatency,
      total_latency_ms: Date.now() - t0,
    };
  }

  let sqlStarted = Date.now();
  let { data: rows, error: rpcErr } = await params.admin.rpc("explore_readonly", { query: sql });
  let sqlMs = Date.now() - sqlStarted;

  if (rpcErr) {
    return {
      ...base,
      success: false,
      answer: plan.answer,
      viz: plan.viz,
      sql,
      sql_execution_success: false,
      sql_error: rpcErr.message,
      sql_execution_ms: sqlMs,
      error: `Query failed: ${rpcErr.message}`,
      error_kind: "sql_execution_failure",
      llm_calls: llmCalls,
      total_usage: totalUsage,
      total_llm_latency_ms: totalLlmLatency,
      total_latency_ms: Date.now() - t0,
    };
  }

  let list = Array.isArray(rows) ? rows : [];

  // One repair pass when the first plan returns zero rows — catches enum typos
  // like game_type='playoff' vs 'playoffs' and full-name vs short player_name.
  if (list.length === 0) {
    try {
      const repairMessages = [
        ...buildPlanMessages(question, params.history || []),
        {
          role: "assistant" as const,
          content: JSON.stringify({ sql: plan.sql, answer: plan.answer, viz: plan.viz }),
        },
        { role: "user" as const, content: EMPTY_RESULT_REPAIR },
      ];
      const repairResult = await params.provider.complete({
        model: params.model,
        temperature: Math.max(planTemperature, 0.2),
        json_object: true,
        messages: repairMessages,
      });
      totalUsage = addUsage(totalUsage, repairResult.usage);
      totalLlmLatency += repairResult.latency_ms;
      llmCalls.push(traceFromResult("sql_repair", repairResult));
      base.model = repairResult.model || base.model;

      const repaired = parsePlan(repairResult.content);
      const repairedSql = validateSql(repaired.sql);
      if (repairedSql !== sql) {
        sqlStarted = Date.now();
        const second = await params.admin.rpc("explore_readonly", { query: repairedSql });
        sqlMs += Date.now() - sqlStarted;
        if (!second.error) {
          plan = repaired;
          sql = repairedSql;
          rows = second.data;
          list = Array.isArray(rows) ? rows : [];
        }
      }
    } catch (repairErr) {
      const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
      llmCalls.push({
        stage: "sql_repair",
        provider: params.provider.id,
        model: params.model,
        usage: emptyUsage(),
        latency_ms: 0,
        retries: 0,
        success: false,
        error: msg,
      });
    }
  }

  const columns =
    list.length > 0 && list[0] && typeof list[0] === "object"
      ? Object.keys(list[0] as Record<string, unknown>)
      : [];

  let answer = plan.answer;
  try {
    const sample = list.slice(0, 40);
    const narrateResult = await params.provider.complete({
      model: params.model,
      temperature: narrateTemperature,
      messages: [
        { role: "system", content: NARRATE_PROMPT },
        {
          role: "user",
          content: `Question: ${question}\nRow count: ${list.length}\nSample rows JSON:\n${JSON.stringify(sample)}`,
        },
      ],
    });
    totalUsage = addUsage(totalUsage, narrateResult.usage);
    totalLlmLatency += narrateResult.latency_ms;
    llmCalls.push(traceFromResult("result_narration", narrateResult));
    base.model = narrateResult.model || base.model;
    const narrated = String(narrateResult.content || "").trim();
    if (narrated) answer = narrated;
  } catch (narrateErr) {
    const msg = narrateErr instanceof Error ? narrateErr.message : String(narrateErr);
    llmCalls.push({
      stage: "result_narration",
      provider: params.provider.id,
      model: params.model,
      usage: emptyUsage(),
      latency_ms: 0,
      retries: 0,
      success: false,
      error: msg,
    });
    // Production keeps provisional plan.answer when narration fails.
  }

  return {
    ...base,
    success: true,
    answer,
    viz: plan.viz,
    sql,
    columns,
    rows: list.slice(0, 200),
    sql_execution_success: true,
    sql_error: null,
    sql_execution_ms: sqlMs,
    error: null,
    error_kind: null,
    llm_calls: llmCalls,
    total_usage: totalUsage,
    total_llm_latency_ms: totalLlmLatency,
    total_latency_ms: Date.now() - t0,
  };
}

export function createServiceClient(supabaseUrl: string, serviceKey: string) {
  return createClient(supabaseUrl, serviceKey);
}
