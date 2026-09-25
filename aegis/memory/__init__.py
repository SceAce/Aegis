"""Memory layer: persist what the Observer extracted, and forget it on evidence.

Memory is a **record**, not a policy. It never reaches a worker's context — only
`policy` does, and only after distillation. That boundary is enforced by tests
(`tests/test_observer.py::test_memory_cannot_drive_action`), not by convention.

Storage layout under the state dir:

    memory/records.jsonl      raw records, still retained
    memory/aggregates.jsonl   compaction results (counts, no raw rows)
    memory/forgotten.jsonl    audit: what was dropped, and why

The audit file is not optional. Silent loss — of a record, a condition or a
refusal — is more expensive than an error, because nothing downstream can tell
"never observed" from "observed and dropped".
"""

from aegis.memory.forget import ForgetPlan, apply as apply_forget, plan as plan_forget
from aegis.memory.store import (
    aggregate_path,
    append as append_memory,
    load as load_memory,
    load_aggregates,
    records_path,
    stats,
)

__all__ = [
    "ForgetPlan",
    "aggregate_path",
    "append_memory",
    "apply_forget",
    "load_aggregates",
    "load_memory",
    "plan_forget",
    "records_path",
    "stats",
]
