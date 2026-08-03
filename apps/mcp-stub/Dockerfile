# mcp-stub — a dev/e2e MCP server, built from the monorepo root context.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/mcp-stub ./apps/mcp-stub
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @turanga/mcp-stub build
EXPOSE 9000
CMD ["node", "apps/mcp-stub/dist/server.js"]
