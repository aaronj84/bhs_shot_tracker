"""
Explore analysis pipeline — mirrors supabase/functions/_shared/explore/pipeline.ts

Flow (same as production Explore):
  question → LLM SQL plan → validateSql → explore_readonly RPC → LLM narrate → answer
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from .pricing import estimate_cost_usd
from .prompts import (
    PROMPT_VERSION,
    load_empty_result_repair,
    load_narrate_prompt,
    load_schema_prompt,
)
from .providers import ChatResult, TokenUsage, add_usage, create_provider
from .sql_safety import parse_plan, validate_sql


@dataclass
class LlmCallTrace:
    stage: str
    provider: str
    model: str
    usage: TokenUsage
    latency_ms: int
    retries: int
    success: bool
    error: Optional[str] = None


@dataclass
class ExploreResult:
    success: bool
    answer: str
    viz: str
    sql: Optional[str]
    columns: List[str]
    rows: List[Any]
    sql_execution_success: Optional[bool]
    sql_error: Optional[str]
    sql_execution_ms: Optional[int]
    error: Optional[str]
    error_kind: Optional[str]
    llm_calls: List[LlmCallTrace]
    total_usage: TokenUsage
    total_llm_latency_ms: int
    total_latency_ms: int
    prompt_version: str
    model: str
    provider: str
    plan_temperature: float
    narrate_temperature: float
    cost: Dict[str, Any] = field(default_factory=dict)
    retries_total: int = 0


def _classify(err: Exception) -> str:
    msg = str(err).lower()
    if "429" in msg or "rate" in msg:
        return "rate_limit"
    if "timeout" in msg or "timed out" in msg:
        return "timeout"
    if "forbidden keyword" in msg or "only select" in msg or "multiple sql" in msg:
        return "unsafe_sql"
    if "invalid model" in msg or "json" in msg or "invalid model response" in msg:
        return "invalid_response"
    if "http" in msg:
        return "api_error"
    return "other"


def execute_readonly_sql(
    *,
    supabase_url: str,
    service_role_key: str,
    sql: str,
    timeout: float = 60.0,
) -> tuple[List[Any], Optional[str], int]:
    """Call public.explore_readonly via PostgREST RPC (service role)."""
    url = supabase_url.rstrip("/") + "/rest/v1/rpc/explore_readonly"
    started = time.time()
    with httpx.Client(timeout=timeout) as client:
        res = client.post(
            url,
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
                "Content-Type": "application/json",
            },
            json={"query": sql},
        )
    ms = int((time.time() - started) * 1000)
    if res.status_code >= 400:
        try:
            detail = res.json()
            msg = detail.get("message") or detail.get("error") or res.text
        except Exception:  # noqa: BLE001
            msg = res.text
        return [], str(msg), ms
    data = res.json()
    rows = data if isinstance(data, list) else []
    return rows, None, ms


def run_explore_analysis(
    *,
    provider_id: str,
    model: str,
    api_key: str,
    question: str,
    supabase_url: str,
    service_role_key: str,
    history: Optional[List[Dict[str, str]]] = None,
    plan_temperature: float = 0.1,
    narrate_temperature: float = 0.2,
    max_retries: int = 2,
) -> ExploreResult:
    t0 = time.time()
    provider = create_provider(provider_id, api_key, max_retries=max_retries)
    schema_prompt = load_schema_prompt()
    narrate_prompt = load_narrate_prompt()
    empty_result_repair = load_empty_result_repair()
    llm_calls: List[LlmCallTrace] = []
    total_usage = TokenUsage()
    total_llm_latency = 0
    retries_total = 0

    base_kwargs = dict(
        viz="table",
        sql=None,
        columns=[],
        rows=[],
        sql_execution_success=None,
        sql_error=None,
        sql_execution_ms=None,
        prompt_version=PROMPT_VERSION,
        model=model,
        provider=provider_id,
        plan_temperature=plan_temperature,
        narrate_temperature=narrate_temperature,
    )

    q = (question or "").strip()
    if not q:
        return ExploreResult(
            success=False,
            answer="",
            error="Ask a question about the shot data",
            error_kind="other",
            llm_calls=[],
            total_usage=TokenUsage(),
            total_llm_latency_ms=0,
            total_latency_ms=int((time.time() - t0) * 1000),
            cost={},
            **base_kwargs,
        )

    history = history or []
    messages: List[Dict[str, str]] = [{"role": "system", "content": schema_prompt}]
    for m in history[-6:]:
        if m and m.get("role") in ("user", "assistant") and m.get("content"):
            messages.append({"role": m["role"], "content": str(m["content"])[:1500]})
    messages.append({"role": "user", "content": q})

    try:
        plan_result: ChatResult = provider.complete(
            model=model,
            messages=messages,
            temperature=plan_temperature,
            json_object=True,
        )
        total_usage = add_usage(total_usage, plan_result.usage)
        total_llm_latency += plan_result.latency_ms
        retries_total += plan_result.retries
        llm_calls.append(
            LlmCallTrace(
                stage="sql_generation",
                provider=plan_result.provider,
                model=plan_result.model,
                usage=plan_result.usage,
                latency_ms=plan_result.latency_ms,
                retries=plan_result.retries,
                success=True,
            )
        )
        model_used = plan_result.model or model
        plan = parse_plan(plan_result.content)
        sql = validate_sql(plan["sql"])
    except Exception as exc:  # noqa: BLE001
        kind = _classify(exc)
        if kind == "unsafe_sql":
            err_kind = "unsafe_sql"
        elif kind == "invalid_response":
            err_kind = "invalid_response"
        else:
            err_kind = "sql_generation_failure"
        result = ExploreResult(
            success=False,
            answer="",
            error=str(exc),
            error_kind=err_kind,
            llm_calls=llm_calls,
            total_usage=total_usage,
            total_llm_latency_ms=total_llm_latency,
            total_latency_ms=int((time.time() - t0) * 1000),
            retries_total=retries_total,
            cost={},
            **base_kwargs,
        )
        result.cost = estimate_cost_usd(
            result.model,
            input_tokens=total_usage.input_tokens,
            output_tokens=total_usage.output_tokens,
            cached_input_tokens=total_usage.cached_input_tokens,
            cache_write_tokens=total_usage.cache_write_tokens,
            provider=provider_id,
        )
        return result

    rows, sql_err, sql_ms = execute_readonly_sql(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        sql=sql,
    )
    if sql_err:
        result = ExploreResult(
            success=False,
            answer=plan["answer"],
            viz=plan["viz"],
            sql=sql,
            columns=[],
            rows=[],
            sql_execution_success=False,
            sql_error=sql_err,
            sql_execution_ms=sql_ms,
            error=f"Query failed: {sql_err}",
            error_kind="sql_execution_failure",
            llm_calls=llm_calls,
            total_usage=total_usage,
            total_llm_latency_ms=total_llm_latency,
            total_latency_ms=int((time.time() - t0) * 1000),
            prompt_version=PROMPT_VERSION,
            model=model_used,
            provider=provider_id,
            plan_temperature=plan_temperature,
            narrate_temperature=narrate_temperature,
            retries_total=retries_total,
            cost={},
        )
        result.cost = estimate_cost_usd(
            result.model,
            input_tokens=total_usage.input_tokens,
            output_tokens=total_usage.output_tokens,
            cached_input_tokens=total_usage.cached_input_tokens,
            cache_write_tokens=total_usage.cache_write_tokens,
            provider=provider_id,
        )
        return result

    # One repair pass when the first plan returns zero rows — catches enum typos
    # like game_type='playoff' vs 'playoffs' and full-name vs short player_name.
    if not rows:
        try:
            repair_messages = list(messages)
            repair_messages.append(
                {
                    "role": "assistant",
                    "content": json.dumps(
                        {"sql": plan["sql"], "answer": plan["answer"], "viz": plan["viz"]}
                    ),
                }
            )
            repair_messages.append({"role": "user", "content": empty_result_repair})
            repair_result = provider.complete(
                model=model,
                messages=repair_messages,
                temperature=max(plan_temperature, 0.2),
                json_object=True,
            )
            total_usage = add_usage(total_usage, repair_result.usage)
            total_llm_latency += repair_result.latency_ms
            retries_total += repair_result.retries
            llm_calls.append(
                LlmCallTrace(
                    stage="sql_repair",
                    provider=repair_result.provider,
                    model=repair_result.model,
                    usage=repair_result.usage,
                    latency_ms=repair_result.latency_ms,
                    retries=repair_result.retries,
                    success=True,
                )
            )
            model_used = repair_result.model or model_used
            repaired = parse_plan(repair_result.content)
            repaired_sql = validate_sql(repaired["sql"])
            if repaired_sql != sql:
                second_rows, second_err, second_ms = execute_readonly_sql(
                    supabase_url=supabase_url,
                    service_role_key=service_role_key,
                    sql=repaired_sql,
                )
                sql_ms += second_ms
                if not second_err:
                    plan = repaired
                    sql = repaired_sql
                    rows = second_rows
        except Exception as exc:  # noqa: BLE001
            llm_calls.append(
                LlmCallTrace(
                    stage="sql_repair",
                    provider=provider_id,
                    model=model,
                    usage=TokenUsage(),
                    latency_ms=0,
                    retries=0,
                    success=False,
                    error=str(exc),
                )
            )

    columns = list(rows[0].keys()) if rows and isinstance(rows[0], dict) else []
    answer = plan["answer"]

    try:
        sample = rows[:40]
        narrate_result = provider.complete(
            model=model,
            messages=[
                {"role": "system", "content": narrate_prompt},
                {
                    "role": "user",
                    "content": (
                        f"Question: {q}\nRow count: {len(rows)}\n"
                        f"Sample rows JSON:\n{json.dumps(sample, default=str)}"
                    ),
                },
            ],
            temperature=narrate_temperature,
            json_object=False,
        )
        total_usage = add_usage(total_usage, narrate_result.usage)
        total_llm_latency += narrate_result.latency_ms
        retries_total += narrate_result.retries
        llm_calls.append(
            LlmCallTrace(
                stage="result_narration",
                provider=narrate_result.provider,
                model=narrate_result.model,
                usage=narrate_result.usage,
                latency_ms=narrate_result.latency_ms,
                retries=narrate_result.retries,
                success=True,
            )
        )
        model_used = narrate_result.model or model_used
        narrated = (narrate_result.content or "").strip()
        if narrated:
            answer = narrated
    except Exception as exc:  # noqa: BLE001
        llm_calls.append(
            LlmCallTrace(
                stage="result_narration",
                provider=provider_id,
                model=model,
                usage=TokenUsage(),
                latency_ms=0,
                retries=0,
                success=False,
                error=str(exc),
            )
        )

    result = ExploreResult(
        success=True,
        answer=answer,
        viz=plan["viz"],
        sql=sql,
        columns=columns,
        rows=rows[:200],
        sql_execution_success=True,
        sql_error=None,
        sql_execution_ms=sql_ms,
        error=None,
        error_kind=None,
        llm_calls=llm_calls,
        total_usage=total_usage,
        total_llm_latency_ms=total_llm_latency,
        total_latency_ms=int((time.time() - t0) * 1000),
        prompt_version=PROMPT_VERSION,
        model=model_used,
        provider=provider_id,
        plan_temperature=plan_temperature,
        narrate_temperature=narrate_temperature,
        retries_total=retries_total,
        cost={},
    )
    result.cost = estimate_cost_usd(
        result.model,
        input_tokens=total_usage.input_tokens,
        output_tokens=total_usage.output_tokens,
        cached_input_tokens=total_usage.cached_input_tokens,
        cache_write_tokens=total_usage.cache_write_tokens,
        provider=provider_id,
    )
    return result
