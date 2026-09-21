from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AEGIS_DIR = ROOT / ".aegis"
RUNS_DIR = ROOT / "runs"
TEST_DIR = ROOT / "test"
ROM_PATH = ROOT / "rom" / "ROM.md"
RAM_TOOLS_PATH = ROOT / "ram" / "TOOLS.md"
CURRENT_PATH = AEGIS_DIR / "current.json"
EPISODES_PATH = AEGIS_DIR / "episodes.jsonl"
ATLAS_PATH = AEGIS_DIR / "atlas.json"
SEARCH_PATH = AEGIS_DIR / "search.json"
ISSUES_PATH = AEGIS_DIR / "issues.jsonl"
TMP_SYNC = Path.home() / "Tmp" / "aegis"
PI_SCRIPT = Path.home() / "My_github" / "pi" / "pi-test.sh"
PWN_START = Path.home() / "Tools" / "pwn" / "start.sh"
CONTAINER = "pwn"

FORBIDDEN_READ_NAMES = {
    "架构.md",
    "框架.md",
    "README.md",
    "Deepseek_AGENTS.md",
}
FORBIDDEN_PREFIXES = (
    ".aegis",
    "runs",
)


def ensure_dirs() -> None:
    AEGIS_DIR.mkdir(parents=True, exist_ok=True)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    TMP_SYNC.mkdir(parents=True, exist_ok=True)


def challenge_dir(name: str) -> Path:
    return TEST_DIR / name


def list_challenges() -> list[str]:
    if not TEST_DIR.is_dir():
        return []
    return sorted(p.name for p in TEST_DIR.iterdir() if p.is_dir() and not p.name.startswith("."))


def infer_kind(name: str) -> str:
    lower = name.lower()
    if lower.startswith("pwn"):
        return "pwn"
    if lower.startswith("re"):
        return "re"
    if lower.startswith("cp") or lower.startswith("crypto"):
        return "crypto"
    return "misc"
