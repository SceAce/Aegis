#!/usr/bin/env bash
# Run all E1 required scripts (68) plus the contract-closure review in parallel.
# Usage: Pi_Agent_base/tests/helpers/run-required.sh <out-dir> [jobs]
set -u
cd "$(git rev-parse --show-toplevel)"
OUT="${1:-Pi_Agent_base/runtime/dev/required-run}"
JOBS="${2:-6}"
mkdir -p "$OUT"
NAMES=$(python3 -c "
import json;d=json.load(open('docs/E1_CONTRACT_CLOSURE_REQUIRED_CHECKS.json'))
s=[];[s.extend(x for x in v if x not in s) for v in d['groups'].values()];print(' '.join(s))")
printf '%s\n' $NAMES | xargs -P "$JOBS" -I{} node Pi_Agent_base/tests/helpers/c6-suite-runner.mjs "$OUT/{}" {} >/dev/null 2>&1
fail=0; total=0
for n in $NAMES; do
	total=$((total+1))
	code=$(python3 -c "import json;print(json.load(open('$OUT/$n/results.json'))[0]['exit'])" 2>/dev/null || echo missing)
	if [ "$code" != "0" ]; then echo "FAIL($code) $n"; fail=$((fail+1)); fi
done
echo "required: $total scripts, $fail failed"
