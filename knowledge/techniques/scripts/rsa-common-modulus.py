#!/usr/bin/env python3
"""RSA common-modulus recovery, as a REGISTERED Aegis script action.

Why a dedicated script instead of a shell one-liner: the script registry can only
pin what it can see. A fixed file with a fixed digest is reviewable; `python -c`
is not. The Oracle re-reads the JSON this writes, so nothing here is trusted via
stdout or the exit code.

Contract (see execution/script-registry.mjs):
  argv     <out.json> <n> <e1> <c1> <e2> <c2>   (hex or decimal integers)
  writes   {"plaintext": "<utf-8 text>", "m": "<hex>"} to out.json
  exit     0 on success, 3 when the inputs do not satisfy the preconditions

Preconditions checked here, not assumed:
  * gcd(e1, e2) == 1
  * the recovered message, re-encrypted under e1 and e2, reproduces c1 and c2
"""
import json
import math
import sys


def egcd(a: int, b: int):
    if b == 0:
        return a, 1, 0
    g, x, y = egcd(b, a % b)
    return g, y, x - (a // b) * y


def mod_inv(a: int, n: int) -> int:
    g, x, _ = egcd(a % n, n)
    if g != 1:
        raise ValueError("not invertible")
    return x % n


def parse_int(text: str) -> int:
    return int(text, 16) if text.lower().startswith("0x") else int(text)


def main(argv) -> int:
    if len(argv) != 6:
        print("usage: common-modulus.py <out.json> <n> <e1> <c1> <e2> <c2>", file=sys.stderr)
        return 2
    out_path, n, e1, c1, e2, c2 = argv
    n, e1, c1, e2, c2 = map(parse_int, (n, e1, c1, e2, c2))

    g, a, b = egcd(e1, e2)
    if g != 1:
        # The method does not apply. Say so; do not write a success-shaped file.
        print(f"precondition unmet: gcd(e1,e2)={g} != 1", file=sys.stderr)
        return 3

    # Negative exponents become modular inverses.
    m = pow(c1 % n, a, n) if a >= 0 else pow(mod_inv(c1, n), -a, n)
    m = (m * (pow(c2 % n, b, n) if b >= 0 else pow(mod_inv(c2, n), -b, n))) % n

    # Postcondition: re-encrypt and compare. A wrong m never gets written as success.
    if pow(m, e1, n) != c1 % n or pow(m, e2, n) != c2 % n:
        print("postcondition failed: recovered m does not re-encrypt to c1/c2", file=sys.stderr)
        return 3

    length = (m.bit_length() + 7) // 8
    raw = m.to_bytes(length, "big")
    text = raw.decode("utf-8", "replace")
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"plaintext": text, "m": f"{m:x}", "verified": True}, handle, ensure_ascii=False)
    print(f"recovered {length} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
