#!/usr/bin/env bash
# Proves the allow-list in .gitleaks.toml is narrow: credentials that look real
# must be reported even inside test files, while the made-up ones the tests
# use must not. The real-looking values are generated afresh on every run and
# never written anywhere but a temporary file that is removed on exit.
#
# Usage: scripts/gitleaks-canary.sh [path-to-gitleaks]
set -euo pipefail

GITLEAKS="${1:-gitleaks}"
cd "$(dirname "$0")/.."

dir="$(mktemp -d apps/server/test/.gitleaks-canary-XXXXXX)"
report="$(mktemp)"
trap 'rm -rf "$dir" "$report"' EXIT

# random <alphabet> <length>
random() {
  node -e 'const [a, n] = process.argv.slice(1); const { randomInt } = require("crypto");
    process.stdout.write(Array.from({ length: +n }, () => a[randomInt(a.length)]).join(""));' "$1" "$2"
}

alnum=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789
github="ghp_$(random "$alnum" 36)"
aws="AKIA$(random ABCDEFGHIJKLMNOPQRSTUVWXYZ234567 16)"
generic="$(random "$alnum" 40)"

cat >"$dir/real.test.ts" <<EOF
const token = '${github}';
const accessKeyId = '${aws}';
const apiKey = '${generic}';
EOF
cat >"$dir/fake.test.ts" <<'EOF'
const token = 'ghp_0123456789abcdefghijABCDEFGHIJ456789';
const apiKey = 'sk-test-key-0123456789abcdef';
EOF

set +e
"$GITLEAKS" dir --config .gitleaks.toml --no-banner --log-level error \
  --report-format json --report-path "$report" "$dir"
status=$?
set -e

if [ "$status" -ne 1 ]; then
  echo "gitleaks-canary: expected gitleaks to report leaks (exit 1), got exit $status" >&2
  exit 1
fi

# shellcheck disable=SC2016 # JavaScript, not shell
node -e '
  const findings = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const files = findings.map((f) => f.File);
  const real = files.filter((f) => f.endsWith("real.test.ts")).length;
  const fake = files.filter((f) => f.endsWith("fake.test.ts")).length;
  if (real < 3 || fake !== 0) {
    console.error(`gitleaks-canary: real-looking secrets reported ${real} of 3, made-up ones ${fake} (want 0)`);
    process.exit(1);
  }
  console.log(`gitleaks-canary: all ${real} real-looking secrets reported, made-up ones allowed`);
' "$report"
