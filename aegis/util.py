"""Small shared helpers."""

from __future__ import annotations

import re

HEXISH = re.compile(r"0x[0-9a-fA-F]{2,}")
ADDRISH = re.compile(r"(?:qword|dword|byte)_[0-9a-fA-F]{4,}")
CHUNK_SIZE = re.compile(r"\b0x[89a-fA-F][0-9a-fA-F]\b")  # typical chunk sizes


def nonportable(text: str) -> bool:
    """Does this text leak a raw address or a challenge-specific size?

    Such content is fine in an episode (it happened) but must never become a
    portable mechanism cell.
    """
    if HEXISH.search(text) or ADDRISH.search(text):
        return True
    if CHUNK_SIZE.search(text) and "glibc" not in text.lower():
        return True
    return False


# Terminal decoration that must never reach the model.
#
# Tools vary in how well they honour NO_COLOR: pwninit, for instance, hard-codes
# its colour variables with no tty check and no NO_COLOR branch, so it emits
# escapes even when piped. Stripping at the harness boundary fixes every such
# tool at once instead of needing each one patched.
_ANSI = re.compile(
    r"""
    \x1b\[[0-9;?]*[a-zA-Z]            # CSI ... letter
  | \x1b\][^\x07\x1b]*(?:\x07|\x1b\\)  # OSC ... BEL/ST
  | \x1b[()][AB0]                    # charset selection
  | \x1b[=>NOP]                       # single-char escapes
  | \r                                # CR from a tty; keep \n only
    """,
    re.VERBOSE,
)

_CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_ansi(text: str) -> str:
    """Remove terminal decoration, keeping \n and \t.

    Escape sequences carry no information for the model and can dominate the
    output (a colour-heavy tool once produced thousands of them per command).
    """
    return _CTRL.sub("", _ANSI.sub("", text))
