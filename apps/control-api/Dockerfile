# control-api — built from the monorepo root context.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/control-api ./apps/control-api
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @turanga/control-api build
EXPOSE 8080
CMD ["node", "apps/control-api/dist/server.js"]
