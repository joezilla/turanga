# agent-harness — the image the run-orchestrator launches per-run (gVisor, --network=none).
# NOT a compose service. Built from the monorepo root context.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/agent-harness ./apps/agent-harness
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @turanga/agent-harness build
CMD ["node", "apps/agent-harness/dist/main.js"]
