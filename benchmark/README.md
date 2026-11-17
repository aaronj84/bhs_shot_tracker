# Explore LLM benchmark

Compare OpenAI and Anthropic models on the **same** Explore analysis pipeline the app uses in production:

```text
question
  → LLM generates SQL plan (shared schema prompt)
  → validate read-only SQL
  → Supabase explore_readonly RPC
  → LLM narrates result rows
  → coach-facing answer
```

This is an LLM regression harness, not a one-off script. Rerun whenever models, prompts, schema, or app logic change.

## Setup

Python 3.9+ required (already used under `scripts/`).

```bash
cd /path/to/bhs_shot_tracker
python3 -m venv benchmark/.venv
benchmark/.venv/bin/pip install -r benchmark/requirements.txt
cp benchmark/.env.example benchmark/.env
# edit benchmark/.env with your keys
```

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | for OpenAI runs | OpenAI API |
| `ANTHROPIC_API_KEY` | for Anthropic runs | Anthropic API |
| `GEMINI_API_KEY` | for Gemini runs | Google AI Studio key |
| `SUPABASE_URL` | yes | Project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key (same privilege the Edge Function uses for `explore_readonly`) |
| `BENCHMARK_OPENAI_MODEL` | no | Default: `gpt-4.1` |
| `BENCHMARK_ANTHROPIC_MODEL` | no | Default: `claude-sonnet-4-6` |
| `BENCHMARK_GEMINI_MODEL` | no | Default: `gemini-3.6-flash` |

Put secrets in `benchmark/.env` or the repo-root `.env`. Never commit them.

The service role key must **not** go in `shots-config.js`. The benchmark needs it only because it calls `explore_readonly` the same way the Edge Function does after JWT checks.

Also ensure `migrate_explore.sql` has been applied in the project.

## Question file

Put one question per line in a `.txt` file:

```text
# Comments and blank lines are ignored
How many shots did we take against Alta?
Which players are creating our highest-quality chances?
```

Example file: [`questions.example.txt`](./questions.example.txt)

Suggested location for your real list:

```text
benchmark/questions.txt
```

(`questions.txt` is gitignored so local lists stay private if you want.)

Stable IDs are assigned as `Q001`, `Q002`, … in file order.

Optional richer format (for future assertions): `.json` / `.jsonl` with objects like
`{"id":"Q1","question":"...","expected_number":3}`. Assertions are not enforced in v1, but the parser is ready.

## Pricing

Central rates: [`pricing.py`](./pricing.py)

- Identified by exact model id when possible
- `PRICING_VERSION` is written into every spreadsheet
- Unknown models still run; cost columns are left blank

Update `MODEL_PRICING` when vendors change prices. Re-check [OpenAI](https://openai.com/api/pricing/), [Anthropic](https://www.anthropic.com/pricing), and [Gemini](https://ai.google.dev/gemini-api/docs/pricing).

Cost is computed from **API-returned token usage**, never by asking the model. Cached tokens follow provider semantics (OpenAI/Gemini: cached is a subset of input; Anthropic: cache read/write are additive).

## Configuration check (no paid LLM calls)

```bash
benchmark/.venv/bin/python -m benchmark --check
```

Offline-only (skip Supabase probes):

```bash
benchmark/.venv/bin/python -m benchmark --check-offline
```

Checks: questions file, prompt sync (TS ↔ `.txt`), scope convention sync, API keys, model pricing entries, output dir, SQL safety, Supabase reachability, `SELECT 1` via `explore_readonly`, and official-view friendly exclusion.

### Golden scope tests (numeric truth)

After `migrate_semantic_layer.sql` + `migrate_explore.sql`:

```bash
# Structural + hardcoded expected_number checks (no LLM spend)
benchmark/.venv/bin/python -m benchmark.golden --verify

# Print view-computed player totals to refresh golden.json
benchmark/.venv/bin/python -m benchmark.golden --compute

# Optional: run LLM cases and auto-grade key figures
benchmark/.venv/bin/python -m benchmark.golden --run --providers openai,anthropic,gemini
```

Cases live in [`golden.json`](./golden.json). The regression pair asserts the same player total for "this season" vs "overall" when both use `v_brighton_shots_official`.

## Run a benchmark

Single pass (default `runs=1`):

```bash
benchmark/.venv/bin/python -m benchmark \
  --questions ./benchmark/questions.txt \
  --providers openai,anthropic,gemini
```

Consistency test (e.g. 5 repetitions — each stored separately):

```bash
benchmark/.venv/bin/python -m benchmark \
  --questions ./benchmark/questions.txt \
  --runs 5 \
  --providers openai,anthropic,gemini \
  --concurrency 2
```

Useful flags: `--questions`, `--runs`, `--providers`, `--output`, `--concurrency`.

## Output

Files land in `benchmark-results/` (gitignored), timestamped:

```text
benchmark-results/llm-benchmark-2026-08-26-1030.xlsx
benchmark-results/llm-benchmark-2026-08-26-1030.csv
```

### Spreadsheet sheets

1. **Results** — one row per question × model × run (answers, SQL, tokens, costs, latencies, errors)
2. **Model Summary** — success rates, token totals, cost stats, projected monthly cost at 100 / 500 / 1k / 5k / 10k questions  
   - *Average cost / execution* is per complete user question for that model  
   - Projected monthly cost uses that average (a `--runs 5` consistency test does **not** imply production costs 5× more per question)  
   - *Total estimated cost (this run)* is what this benchmark session actually spent
3. **Side-by-Side** — OpenAI vs Claude answers for human review, plus empty Preferred Answer / Score / Notes columns
4. **Metadata** — timestamp, git commit, models, prompt version, pricing version, Supabase URL, temperatures

There is **no** automated LLM judge. Ryan and you score the Side-by-Side sheet.

## Fairness

Both providers receive the same:

- schema / system prompt (`schema_prompt.txt` / edge `SCHEMA_PROMPT`)
- narrate prompt
- empty-result repair prompt (one retry when the first SQL returns 0 rows)
- user question
- SQL validation rules
- `explore_readonly` execution
- temperatures (plan `0.1`, narrate `0.2` — production defaults)

Anthropic gets an extra “JSON only” reminder when structured output is required (OpenAI uses `response_format`); semantic content matches.

## Shared with production

| Piece | Location |
| --- | --- |
| Schema prompt | `supabase/functions/_shared/explore/schema_prompt.txt` (+ `prompts.ts`) |
| Narrate prompt | `…/narrate_prompt.txt` |
| Empty-result repair | `…/empty_result_repair.txt` (+ `EMPTY_RESULT_REPAIR`) |
| SQL validation | `…/sql.ts` and `benchmark/sql_safety.py` (kept in sync; `--check` verifies prompts) |
| Edge Function | `supabase/functions/explore-shots/index.ts` (uses shared pipeline + OpenAI provider) |
| Provider adapters (Deno) | `supabase/functions/_shared/explore/providers/` |

After changing prompts, update **both** the `.txt` files and the string exports in `prompts.ts`, then run `--check`.

## Unit tests (free)

```bash
benchmark/.venv/bin/python -m unittest benchmark.test_harness -v
```

## Safety

Generated SQL must be read-only. The harness reuses the same keyword / SELECT-only guards as production; unsafe SQL is recorded as a failure and never executed. The RPC also enforces SELECT-only server-side.

A single failed model call does not stop the suite.

## What this does *not* do (yet)

- LLM-as-judge for free-form answer quality (golden harness grades key numbers only)
- Calling the deployed Edge Function over HTTP (runs the shared pipeline locally with the service role, which is the same core path)
