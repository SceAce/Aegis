from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

API_URL = "https://api.deepseek.com/chat/completions"
MODEL = os.environ.get("AEGIS_COMPILE_MODEL", "deepseek-flash")


def _api_key() -> str:
    env = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if env:
        return env
    auth = Path.home() / ".pi" / "agent" / "auth.json"
    if auth.is_file():
        data = json.loads(auth.read_text(encoding="utf-8"))
        block = data.get("deepseek") or {}
        key = str(block.get("key") or "").strip()
        if key:
            return key
    return ""


def _post(key: str, body_obj: dict, timeout: int) -> dict:
    payload = json.dumps(body_obj).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:400]
        if exc.code == 400:
            return {"_http": 400, "_error": f"compile LLM HTTP 400: {body}"}
        raise RuntimeError(f"compile LLM HTTP {exc.code}: {body}") from None
    except urllib.error.URLError:
        raise RuntimeError("compile LLM network error") from None


def chat_json(system: str, user: str, timeout: int = 90) -> dict:
    key = _api_key()
    if not key:
        raise RuntimeError("no DeepSeek API key (DEEPSEEK_API_KEY or ~/.pi/agent/auth.json)")
    body_obj = {
        "model": MODEL,
        "temperature": 0.2,
        "max_tokens": 8192,
        "thinking": {"type": "disabled"},
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    raw = _post(key, body_obj, timeout)
    if isinstance(raw, dict) and raw.get("_http") == 400:
        body_obj.pop("thinking", None)
        raw = _post(key, body_obj, timeout)
    if isinstance(raw, dict) and raw.get("_error"):
        raise RuntimeError(raw["_error"])
    dump = Path(__file__).resolve().parent.parent / ".aegis" / "last_compile_raw.json"
    dump.parent.mkdir(parents=True, exist_ok=True)
    dump.write_text(json.dumps(raw, ensure_ascii=False, indent=2)[:20000], encoding="utf-8")
    msg = (raw.get("choices") or [{}])[0].get("message") or {}
    text = str(msg.get("content") or "").strip() or str(msg.get("reasoning_content") or "")
    if not str(text).strip():
        raise RuntimeError(f"compile LLM empty content keys={list(msg)}")
    return _extract_json(str(text))


def _extract_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    start = text.find("{")
    if start < 0:
        raise RuntimeError("compile LLM did not return JSON")
    data, _idx = json.JSONDecoder().raw_decode(text, start)
    if not isinstance(data, dict):
        raise RuntimeError("compile LLM JSON is not an object")
    return data
