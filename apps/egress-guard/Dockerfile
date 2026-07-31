# egress-guard — built from the monorepo root context.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/egress-guard ./apps/egress-guard
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @turanga/egress-guard build
EXPOSE 8081
CMD ["node", "apps/egress-guard/dist/server.js"]
