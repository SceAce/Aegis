"""Aegis Observer: worker events -> memory -> experience.

Two hard rules:

1. Memory is extracted **mechanically** from worker event logs, never written by
   an LLM. `extract` only reads fields and pairs records; it does not interpret.
   The previous round's false positives came from asking a model to re-extract
   structure from prose.
2. Memory **never drives behaviour**. Nothing produced here may enter a worker's
   context. Only distilled experience may (see `policy`). A test asserts this.

Layering: this package reads logs and does arithmetic. It does not decide what a
worker should do, and it does not write the blackboard — the native observer in
the pi fork is the single writer, so the observed cannot edit the board.
"""

from aegis.core.criterion import Criterion, find_criterion
from aegis.observer.extract import (
    SESSIONS_ROOT,
    SUPPORTED_SESSION_VERSION,
    Event,
    Experience,
    MemoryRecord,
    build_memory,
    discover_sessions,
    distill,
    observe,
    portable,
    read_pi_session,
)
from aegis.observer.native import SUPPORTED_EVENT_SCHEMA, event_files, read_native_events

__all__ = [
    "SESSIONS_ROOT",
    "SUPPORTED_EVENT_SCHEMA",
    "SUPPORTED_SESSION_VERSION",
    "Criterion",
    "Event",
    "Experience",
    "MemoryRecord",
    "build_memory",
    "discover_sessions",
    "distill",
    "event_files",
    "find_criterion",
    "observe",
    "portable",
    "read_pi_session",
    "read_native_events",
]
