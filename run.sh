#!/usr/bin/env bash
set -euo pipefail

# turanga dev runner.
#
#   Backend  = docker compose: control-plane API on :8080 (JSON only, no UI),
#              plus postgres / redis / litellm / egress-guard.
#   Frontend = the SvelteKit UI on http://localhost:5173  ← open THIS in your browser.
#
# The UI is a Vite dev server (not in compose), so this script starts both.

cd "$(dirname "$0")"

# 1. Deps
pnpm install

# 2. Backend (detached). Ensure an env file exists so the initial user gets seeded.
#    (Portable "copy only if missing" — BSD `cp -n` returns non-zero when it skips,
#     which would trip `set -e`.)
[ -f deploy/.env ] || cp deploy/.env.example deploy/.env
( cd deploy && docker compose up -d --build )

# 2b. Build the per-run sandbox image the orchestrator launches (Epic 4). Not a long-lived
#     service — built here + tagged turanga/agent-harness:dev. On macOS the sandbox runtime is
#     SANDBOX_RUNTIME=dev-insecure (no gVisor); the guarantee is topological locally.
( cd deploy && docker compose --profile build build agent-harness-image )

cat <<'EOF'

──────────────────────────────────────────────────────────────
  Backend is up.
    • Control-plane API : http://localhost:8080   (JSON only — not a web page)
    • UI (open this)    : http://localhost:5173
    • Log in with the creds in deploy/.env
      (defaults: admin@turanga.local / changeme-dev)

  Starting the UI now (Ctrl-C to stop it; backend keeps running).
  To stop the backend later:  cd deploy && docker compose down
──────────────────────────────────────────────────────────────

EOF

# 3. Frontend UI (foreground) — this is what you point a browser at.
pnpm --filter @turanga/web dev
