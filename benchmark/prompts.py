"""Load shared Explore prompts from the text files next to the edge-function module."""

from __future__ import annotations

import re
from pathlib import Path

PROMPT_VERSION = "explore-schema-v5"

# Known friendlies used in golden / scope checks (not hard-hidden from Explore).
KNOWN_FRIENDLY_OPPONENTS = ("Raya Vallecano SC",)
# Back-compat alias for older check names.
EXCLUDED_EXPLORE_OPPONENTS = KNOWN_FRIENDLY_OPPONENTS

_SHARED = (
    Path(__file__).resolve().parents[1]
    / "supabase"
    / "functions"
    / "_shared"
    / "explore"
)

_MIGRATE_EXPLORE = (
    Path(__file__).resolve().parents[1] / "supabase" / "migrate_explore.sql"
)
_MIGRATE_SEMANTIC = (
    Path(__file__).resolve().parents[1] / "supabase" / "migrate_semantic_layer.sql"
)


def _read(name: str) -> str:
    path = _SHARED / name
    if not path.is_file():
        raise FileNotFoundError(f"Missing shared prompt file: {path}")
    return path.read_text(encoding="utf-8").strip()


def load_schema_prompt() -> str:
    return _read("schema_prompt.txt")


def load_narrate_prompt() -> str:
    return _read("narrate_prompt.txt")


def load_empty_result_repair() -> str:
    return _read("empty_result_repair.txt")


def shared_prompt_dir() -> Path:
    return _SHARED


def extract_ts_prompt_export(ts_source: str, export_name: str) -> str:
    """Extract `export const NAME = \`...\`;` from prompts.ts for sync checks."""
    marker = f"export const {export_name} ="
    idx = ts_source.find(marker)
    if idx < 0:
        raise ValueError(f"Could not find {export_name} in prompts.ts")
    rest = ts_source[idx + len(marker) :].lstrip()
    if rest.startswith("`"):
        end = 1
        while end < len(rest):
            if rest[end] == "`" and rest[end - 1] != "\\":
                return rest[1:end]
            end += 1
        raise ValueError(f"Unclosed template for {export_name}")
    raise ValueError(f"Unsupported prompt literal form for {export_name}")


def _parse_ts_string_array(ts_source: str, export_name: str) -> tuple[str, ...]:
    """Parse `export const NAME = ["a", "b"] as const;`."""
    marker = f"export const {export_name} ="
    idx = ts_source.find(marker)
    if idx < 0:
        raise ValueError(f"Could not find {export_name}")
    rest = ts_source[idx + len(marker) :]
    m = re.search(r"\[(.*?)\]", rest, re.S)
    if not m:
        raise ValueError(f"Could not parse array for {export_name}")
    return tuple(re.findall(r'"([^"]+)"', m.group(1)))


def prompts_in_sync() -> tuple[bool, str]:
    ts_path = _SHARED / "prompts.ts"
    if not ts_path.is_file():
        return False, f"Missing {ts_path}"
    ts = ts_path.read_text(encoding="utf-8")
    try:
        schema_ts = extract_ts_prompt_export(ts, "SCHEMA_PROMPT").strip()
        narrate_ts = extract_ts_prompt_export(ts, "NARRATE_PROMPT").strip()
        repair_ts = extract_ts_prompt_export(ts, "EMPTY_RESULT_REPAIR").strip()
        version_m = re.search(
            r'export const PROMPT_VERSION = "([^"]+)"',
            ts,
        )
    except ValueError as exc:
        return False, str(exc)
    schema_txt = load_schema_prompt()
    narrate_txt = load_narrate_prompt()
    repair_txt = load_empty_result_repair()
    if schema_ts != schema_txt:
        return False, "SCHEMA_PROMPT in prompts.ts does not match schema_prompt.txt"
    if narrate_ts != narrate_txt:
        return False, "NARRATE_PROMPT in prompts.ts does not match narrate_prompt.txt"
    if repair_ts != repair_txt:
        return False, "EMPTY_RESULT_REPAIR in prompts.ts does not match empty_result_repair.txt"
    if not version_m or version_m.group(1) != PROMPT_VERSION:
        return (
            False,
            f"PROMPT_VERSION mismatch: prompts.ts={version_m.group(1) if version_m else None!r} "
            f"benchmark={PROMPT_VERSION!r}",
        )
    return True, "prompts in sync"


def exclusions_in_sync() -> tuple[bool, str]:
    """Verify scope convention + known friendlies agree across TS, prompts, migrations."""
    excl_path = _SHARED / "exclusions.ts"
    if not excl_path.is_file():
        return False, f"Missing {excl_path}"
    try:
        ts_list = _parse_ts_string_array(
            excl_path.read_text(encoding="utf-8"), "KNOWN_FRIENDLY_OPPONENTS"
        )
    except ValueError as exc:
        return False, str(exc)

    if ts_list != KNOWN_FRIENDLY_OPPONENTS:
        return (
            False,
            f"exclusions.ts {ts_list!r} != benchmark KNOWN_FRIENDLY_OPPONENTS "
            f"{KNOWN_FRIENDLY_OPPONENTS!r}",
        )

    schema = load_schema_prompt()
    for needle in (
        "v_brighton_shots_official",
        "For season or aggregate stats, query v_brighton_shots_official",
        "is_tracked=false",
        "game_type = 'playoffs'",
        'Never use "playoff"',
    ):
        if needle not in schema:
            return False, f"schema_prompt.txt missing required scope text: {needle!r}"

    if not _MIGRATE_SEMANTIC.is_file():
        return False, f"Missing {_MIGRATE_SEMANTIC}"
    if not _MIGRATE_EXPLORE.is_file():
        return False, f"Missing {_MIGRATE_EXPLORE}"
    semantic = _MIGRATE_SEMANTIC.read_text(encoding="utf-8")
    migrate = _MIGRATE_EXPLORE.read_text(encoding="utf-8")

    for view in (
        "v_brighton_shots",
        "v_brighton_shots_official",
        "v_brighton_games",
    ):
        if view not in semantic:
            return False, f"migrate_semantic_layer.sql missing {view}"
        if view not in migrate:
            return False, f"migrate_explore.sql missing explore.{view}"

    for name in KNOWN_FRIENDLY_OPPONENTS:
        if name not in semantic and "'friendly'" not in semantic:
            return False, f"migrate_semantic_layer.sql missing friendly scope mapping"

    return True, f"scope convention in sync (friendlies: {', '.join(KNOWN_FRIENDLY_OPPONENTS)})"
