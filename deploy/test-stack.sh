#!/usr/bin/env bash
# Run the backend stack under an ISOLATED docker-compose project ("turanga-e2e") with its own
# throwaway volumes, so `down -v` for tests can NEVER wipe the dev stack's data (the "turanga"
# project's turanga_pgdata — your connected providers, agents, runs).
#
# It uses the SAME host port (:8080) as the dev stack, so `up` first STOPS the dev stack to free the
# port (no -v — the dev data is kept). After testing, `down` removes only the turanga-e2e volumes;
# bring the dev stack back with `./run.sh` or `docker compose up -d`.
#
#   ./test-stack.sh up      # stop dev (keep data) → start a fresh isolated e2e stack
#   ./test-stack.sh reset   # wipe + recreate the e2e DB (fast pristine slate between runs)
#   ./test-stack.sh down    # remove the e2e stack + its volumes (dev data untouched)
#   ./test-stack.sh health  # poll until the e2e control-api answers /health
set -euo pipefail
cd "$(dirname "$0")"

export COMPOSE_PROJECT_NAME=turanga-e2e   # scopes ALL volumes (incl. the guard volume) to this project

health() {
  for _ in $(seq 1 60); do
    curl -sf http://localhost:8080/health >/dev/null 2>&1 && { echo "e2e control-api healthy"; return 0; }
    sleep 1
  done
  echo "e2e control-api did not become healthy" >&2; return 1
}

case "${1:-up}" in
  up)
    # Free :8080 by stopping the dev stack — WITHOUT -v, so the dev data (turanga_pgdata) is kept.
    COMPOSE_PROJECT_NAME=turanga docker compose stop >/dev/null 2>&1 || true
    docker compose up -d --build
    docker compose --profile build build agent-harness-image
    health
    echo "e2e stack up (project: turanga-e2e). Dev stack stopped, its data intact."
    ;;
  reset)
    docker compose down -v >/dev/null 2>&1 || true
    docker compose up -d
    health
    ;;
  down)
    docker compose down -v   # removes ONLY turanga-e2e_* volumes
    echo "e2e stack + its volumes removed. Restore dev with:  ./run.sh   (or: docker compose up -d)"
    ;;
  health) health ;;
  *) echo "usage: $0 {up|reset|down|health}"; exit 1 ;;
esac
