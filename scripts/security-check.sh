#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0
fail() { echo "[FAIL] $*" >&2; failures=$((failures + 1)); }
ok() { echo "[OK] $*"; }

if ! command -v gitleaks >/dev/null 2>&1; then
  fail "gitleaks is not installed (macOS: brew install gitleaks)"
else
  if gitleaks dir . --redact --no-banner --max-target-megabytes 10; then
    ok "Gitleaks working-tree scan"
  else
    fail "Gitleaks found a potential secret"
  fi
fi

if rg -l --hidden \
  -g '!web/node_modules/**' -g '!web/dist/**' -g '!server/.venv/**' -g '!**/.git/**' \
  -g '!scripts/security-check.sh' \
  -e '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)' \
  -e '/Users/[^/[:space:]]+' -e '/home/[^/[:space:]]+' \
  . >/tmp/financeapp-sensitive-paths.txt; then
  cat /tmp/financeapp-sensitive-paths.txt >&2
  fail "Private network addresses or personal home paths remain"
else
  ok "No private IP addresses or personal home paths"
fi
rm -f /tmp/financeapp-sensitive-paths.txt

if find . -type f \
  \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' \
     -o -name '*.pfx' -o -name '*.dump' -o -name '*.sqlite' -o -name '*.db' -o -name '*.aesgcm' \) \
  ! -name '.env.example' ! -path './web/node_modules/*' ! -path './server/.venv/*' \
  -print -quit | grep -q .; then
  fail "A sensitive file exists in the publication tree"
else
  ok "No sensitive file types in the publication tree"
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  forbidden='(^|/)(\.env($|\.)|.*\.(pem|key|p12|pfx|dump|sqlite|db|aesgcm)$)'
  tracked="$(git ls-files | grep -E "$forbidden" | grep -v '^\.env\.example$' || true)"
  [[ -z "$tracked" ]] || { echo "$tracked" >&2; fail "Sensitive file types are tracked by Git"; }
  if command -v gitleaks >/dev/null 2>&1; then
    if gitleaks git . --redact --no-banner; then
      ok "Gitleaks Git-history scan"
    else
      fail "Gitleaks found a secret in Git history"
    fi
  fi
else
  ok "No Git history exists yet; run this check again after the first commit"
fi

if (( failures > 0 )); then
  echo "Security publication check failed with ${failures} finding(s)." >&2
  exit 1
fi
echo "Security publication check passed."
