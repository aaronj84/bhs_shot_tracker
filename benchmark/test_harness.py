"""Offline unit tests for the benchmark harness (no API spend)."""

from __future__ import annotations

import unittest
from pathlib import Path

from benchmark.pricing import estimate_cost_usd, resolve_pricing
from benchmark.prompts import (
    EXCLUDED_EXPLORE_OPPONENTS,
    exclusions_in_sync,
    load_narrate_prompt,
    load_schema_prompt,
    prompts_in_sync,
)
from benchmark.questions import parse_questions_file, parse_questions_maybe_json
from benchmark.sql_safety import is_safe_select, parse_plan, validate_sql
from benchmark.spreadsheet import row_from_result, side_by_side_rows, summarize_by_model
from benchmark.pipeline import ExploreResult
from benchmark.providers import TokenUsage


ROOT = Path(__file__).resolve().parent


class SqlSafetyTests(unittest.TestCase):
    def test_allows_select(self):
        sql = validate_sql("SELECT count(*) FROM shots")
        self.assertIn("LIMIT", sql.upper())

    def test_rejects_delete(self):
        ok, _ = is_safe_select("DELETE FROM shots")
        self.assertFalse(ok)

    def test_rejects_multi_statement(self):
        ok, _ = is_safe_select("SELECT 1; DROP TABLE shots")
        self.assertFalse(ok)

    def test_rejects_insert(self):
        with self.assertRaises(ValueError):
            validate_sql("INSERT INTO shots (id) VALUES (1)")

    def test_strips_public_schema(self):
        sql = validate_sql(
            "SELECT count(*) FROM public.shots JOIN public.teams ON true LIMIT 10"
        )
        self.assertNotIn("public.", sql.lower())
        self.assertIn("shots", sql.lower())
        self.assertIn("teams", sql.lower())


class ParsePlanTests(unittest.TestCase):
    def test_parse_json(self):
        plan = parse_plan('{"sql":"SELECT 1","answer":"ok","viz":"table"}')
        self.assertEqual(plan["sql"], "SELECT 1")
        self.assertEqual(plan["viz"], "table")

    def test_strips_fences(self):
        plan = parse_plan('```json\n{"sql":"SELECT 2","answer":"a","viz":"pitch"}\n```')
        self.assertEqual(plan["viz"], "pitch")


class QuestionsTests(unittest.TestCase):
    def test_example_file(self):
        qs = parse_questions_file(ROOT / "questions.example.txt")
        self.assertGreaterEqual(len(qs), 5)
        self.assertEqual(qs[0].question_id, "Q001")
        self.assertFalse(any(q.question.startswith("#") for q in qs))

    def test_json_future_assertions(self):
        import tempfile, json

        payload = [
            {"id": "A1", "question": "How many goals?", "expected_number": 3},
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(payload, f)
            path = Path(f.name)
        qs = parse_questions_maybe_json(path)
        self.assertEqual(qs[0].question_id, "A1")
        self.assertEqual(qs[0].expected.get("expected_number"), 3)
        path.unlink()


class PromptSyncTests(unittest.TestCase):
    def test_prompts_load(self):
        from benchmark.prompts import load_empty_result_repair

        self.assertIn("Brighton", load_schema_prompt())
        self.assertIn("coaches", load_narrate_prompt())
        self.assertIn("playoffs", load_schema_prompt())
        self.assertIn("playoff", load_empty_result_repair())

    def test_ts_txt_sync(self):
        ok, msg = prompts_in_sync()
        self.assertTrue(ok, msg)

    def test_exclusions_sync(self):
        self.assertIn("Raya Vallecano SC", EXCLUDED_EXPLORE_OPPONENTS)
        ok, msg = exclusions_in_sync()
        self.assertTrue(ok, msg)
        schema = load_schema_prompt()
        self.assertIn("v_brighton_shots_official", schema)
        self.assertIn("For season or aggregate stats, query v_brighton_shots_official", schema)

    def test_raw_stat_guardrail(self):
        from benchmark.sql_safety import uses_raw_stat_tables

        self.assertTrue(uses_raw_stat_tables("SELECT count(*) FROM shots"))
        self.assertTrue(uses_raw_stat_tables("SELECT * FROM games JOIN shots ON true"))
        self.assertFalse(
            uses_raw_stat_tables(
                "SELECT count(*) FROM v_brighton_shots_official WHERE is_brighton_shot"
            )
        )


class PricingTests(unittest.TestCase):
    def test_openai_cache_not_double_counted(self):
        # 1000 input of which 400 cached → bill 600 @ input + 400 @ cached
        cost = estimate_cost_usd(
            "gpt-4o-mini",
            input_tokens=1000,
            output_tokens=100,
            cached_input_tokens=400,
            provider="openai",
        )
        self.assertTrue(cost["pricing_found"])
        expected_input = 600 * 0.15 / 1_000_000
        expected_cache = 400 * 0.075 / 1_000_000
        expected_output = 100 * 0.60 / 1_000_000
        self.assertAlmostEqual(cost["estimated_input_cost_usd"], expected_input)
        self.assertAlmostEqual(cost["estimated_cache_cost_usd"], expected_cache)
        self.assertAlmostEqual(cost["estimated_output_cost_usd"], expected_output)
        self.assertAlmostEqual(
            cost["estimated_total_cost_usd"],
            expected_input + expected_cache + expected_output,
        )

    def test_anthropic_cache_additive(self):
        cost = estimate_cost_usd(
            "claude-sonnet-4-6",
            input_tokens=1000,
            output_tokens=100,
            cached_input_tokens=400,
            cache_write_tokens=50,
            provider="anthropic",
        )
        self.assertTrue(cost["pricing_found"])
        expected_input = 1000 * 3.0 / 1_000_000
        expected_cache = 400 * 0.30 / 1_000_000 + 50 * 3.75 / 1_000_000
        expected_output = 100 * 15.0 / 1_000_000
        self.assertAlmostEqual(cost["estimated_input_cost_usd"], expected_input)
        self.assertAlmostEqual(cost["estimated_cache_cost_usd"], expected_cache)
        self.assertAlmostEqual(
            cost["estimated_total_cost_usd"],
            expected_input + expected_cache + expected_output,
        )

    def test_gemini_cache_like_openai(self):
        cost = estimate_cost_usd(
            "gemini-3.6-flash",
            input_tokens=1000,
            output_tokens=100,
            cached_input_tokens=400,
            provider="gemini",
        )
        self.assertTrue(cost["pricing_found"])
        expected_input = 600 * 0.30 / 1_000_000
        expected_cache = 400 * 0.03 / 1_000_000
        expected_output = 100 * 2.50 / 1_000_000
        self.assertAlmostEqual(cost["estimated_input_cost_usd"], expected_input)
        self.assertAlmostEqual(cost["estimated_cache_cost_usd"], expected_cache)
        self.assertAlmostEqual(
            cost["estimated_total_cost_usd"],
            expected_input + expected_cache + expected_output,
        )

    def test_unknown_model(self):
        cost = estimate_cost_usd("totally-unknown-model-xyz", input_tokens=10, output_tokens=10)
        self.assertFalse(cost["pricing_found"])
        self.assertIsNone(cost["estimated_total_cost_usd"])


class SpreadsheetAggTests(unittest.TestCase):
    def test_summary_and_side_by_side(self):
        def fake(provider, model, cost, success=True):
            r = ExploreResult(
                success=success,
                answer="ans",
                viz="table",
                sql="SELECT 1",
                columns=["ok"],
                rows=[{"ok": 1}],
                sql_execution_success=True,
                sql_error=None,
                sql_execution_ms=5,
                error=None,
                error_kind=None,
                llm_calls=[],
                total_usage=TokenUsage(input_tokens=10, output_tokens=5, total_tokens=15),
                total_llm_latency_ms=100,
                total_latency_ms=120,
                prompt_version="explore-schema-v1",
                model=model,
                provider=provider,
                plan_temperature=0.1,
                narrate_temperature=0.2,
                cost={
                    "pricing_found": True,
                    "pricing_version": "test",
                    "estimated_input_cost_usd": cost / 2,
                    "estimated_output_cost_usd": cost / 2,
                    "estimated_cache_cost_usd": 0.0,
                    "estimated_total_cost_usd": cost,
                },
            )
            return row_from_result(
                question_id="Q001",
                question="How many?",
                run_number=1,
                result=r,
                timestamp="t",
            )

        rows = [
            fake("openai", "gpt-4o-mini", 0.001),
            fake("anthropic", "claude-sonnet-4-6", 0.002),
            fake("gemini", "gemini-3.6-flash", 0.0015),
        ]
        summary = summarize_by_model(rows)
        self.assertEqual(len(summary), 3)
        # Projection uses avg per execution, not inflated
        oai = next(s for s in summary if s["Provider"] == "openai")
        self.assertAlmostEqual(oai["Projected Cost — 100 Questions"], 0.1)

        sbs = side_by_side_rows(rows)
        self.assertEqual(len(sbs), 1)
        self.assertEqual(sbs[0]["Preferred Answer"], "")
        self.assertIn("OpenAI Final Answer", sbs[0])
        self.assertIn("Gemini Final Answer", sbs[0])
        self.assertEqual(sbs[0]["Gemini Score"], "")


if __name__ == "__main__":
    unittest.main()
