#!/usr/bin/env bash
#
# Brings up the whole system: the patched CatGPT-Gateway, then the Next.js app.
# Idempotent — safe to run repeatedly. First run clones and sets up the gateway.
#
#   npm run start:all
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_DIR="${GATEWAY_DIR:-$(dirname "$REPO_ROOT")/CatGPT-Gateway}"
GATEWAY_REPO="https://github.com/GautamVhavle/CatGPT-Gateway.git"
GATEWAY_PORT="${GATEWAY_PORT:-8000}"
ENV_FILE="$REPO_ROOT/.env.local"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
warn() { printf "\033[33m%s\033[0m\n" "$1"; }
die()  { printf "\033[31m%s\033[0m\n" "$1" >&2; exit 1; }

# ---------------------------------------------------------------- config ----
[ -f "$ENV_FILE" ] || die "Missing $ENV_FILE — copy .env.local.example to .env.local and fill it in."

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

[ -n "${CUSTOM_GPT_URL:-}" ] || die "CUSTOM_GPT_URL is not set in .env.local"
[ -n "${GATEWAY_TOKEN:-}" ]  || die "GATEWAY_TOKEN is not set in .env.local"

# --------------------------------------------------------------- gateway ----
if [ ! -d "$GATEWAY_DIR" ]; then
  bold "Cloning CatGPT-Gateway into $GATEWAY_DIR"
  git clone --depth 1 "$GATEWAY_REPO" "$GATEWAY_DIR"
fi

cd "$GATEWAY_DIR"

if [ ! -d .venv ]; then
  bold "Creating the gateway virtualenv (one time, a few minutes)"
  python3 -m venv .venv
  ./.venv/bin/pip install --quiet --upgrade pip
  ./.venv/bin/pip install --quiet -r requirements.txt
  ./.venv/bin/patchright install chromium
fi

# Re-applied every run so a fresh clone or an upstream pull stays patched.
bold "Applying JobManager patches"
./.venv/bin/python "$REPO_ROOT/gateway-patch/apply_patch.py" "$GATEWAY_DIR"

# Gateway .env is derived from JobManager's .env.local — single source of truth.
[ -f .env ] || cp .env.example .env
python3 - "$GATEWAY_DIR/.env" <<PY
import os, sys, re
path = sys.argv[1]
# HEADLESS stays false on purpose: headless Chrome is far easier to fingerprint.
values = {
    "PROVIDER": "chatgpt",
    "HEADLESS": "false",
    "API_PORT": os.environ.get("GATEWAY_PORT", "8000"),
    "API_TOKEN": os.environ["GATEWAY_TOKEN"],
    "CUSTOM_GPT_URL": os.environ["CUSTOM_GPT_URL"],
    # Drops Chrome's --host-resolver-rules (a Docker-only DNS workaround).
    "SKIP_HOST_RESOLVER_RULES": os.environ.get("SKIP_HOST_RESOLVER_RULES", "false"),
    # How long to wait for a manual click when automatic capture fails.
    "MANUAL_DOWNLOAD_WAIT_MS": os.environ.get("MANUAL_DOWNLOAD_WAIT_MS", "60000"),
}
lines = open(path).read().splitlines() if os.path.exists(path) else []
seen = set()
out = []
for line in lines:
    key = line.split("=", 1)[0].strip()
    if key in values:
        out.append(f"{key}={values[key]}")
        seen.add(key)
    else:
        out.append(line)
for key, value in values.items():
    if key not in seen:
        out.append(f"{key}={value}")
open(path, "w").write("\n".join(out) + "\n")
PY

# One-time interactive ChatGPT login; the session then persists for weeks.
BROWSER_DATA="${BROWSER_DATA_DIR:-$GATEWAY_DIR/browser_data}"
if [ ! -d "$BROWSER_DATA" ]; then
  warn ""
  warn "No saved ChatGPT session found. Run this once, log in, then re-run:"
  warn "  cd $GATEWAY_DIR && ./.venv/bin/python scripts/first_login.py"
  warn ""
  die "Gateway needs a login before it can start."
fi

GATEWAY_PID=""
if curl -sf "http://localhost:$GATEWAY_PORT/healthz" >/dev/null 2>&1; then
  bold "Gateway already running on :$GATEWAY_PORT"
else
  bold "Starting the gateway on :$GATEWAY_PORT"
  mkdir -p logs
  ./.venv/bin/python -m src.api.server >>logs/gateway.log 2>&1 &
  GATEWAY_PID=$!

  # Shut the gateway down with the app, but leave an already-running one alone.
  cleanup() {
    if [ -n "$GATEWAY_PID" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
      bold "Stopping the gateway"
      kill "$GATEWAY_PID" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM

  printf "Waiting for the gateway"
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$GATEWAY_PORT/healthz" >/dev/null 2>&1; then
      printf " ready\n"
      break
    fi
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      printf "\n"
      tail -20 logs/gateway.log || true
      die "Gateway exited on startup — see $GATEWAY_DIR/logs/gateway.log"
    fi
    printf "."
    sleep 1
  done
  curl -sf "http://localhost:$GATEWAY_PORT/healthz" >/dev/null 2>&1 \
    || die "Gateway did not come up in 60s — see $GATEWAY_DIR/logs/gateway.log"
fi

# ------------------------------------------------------------------- app ----
# --prefix pins the project dir, so this works no matter where npm was invoked.
bold "Starting JobManager"
npm --prefix "$REPO_ROOT" run dev
