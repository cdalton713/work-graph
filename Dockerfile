# The hosted work-graph page (README "Host the page"). Node runs the TypeScript server directly.
FROM node:24.22.1-alpine AS build
WORKDIR /ui
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts vercel.json ./
COPY api ./api
COPY public ./public
COPY src ./src
COPY skills/work-graph/contract.json ./skills/work-graph/contract.json
COPY server ./server
RUN pnpm build && pnpm prune --prod && rm -r server/testing server/*.test.ts src/lib/*.test.ts

FROM node:24.22.1-alpine
WORKDIR /ui
# The deploy passes the commit (`--build-arg WG_VERSION=<commit>`); /api/config and /api/status give it.
ARG WG_VERSION=dev
ENV NODE_ENV=production WG_VERSION=$WG_VERSION
COPY --from=build /ui/package.json ./
COPY --from=build /ui/node_modules ./node_modules
COPY --from=build /ui/dist ./dist
COPY --from=build /ui/server ./server
# The server makes the overview with the graph rules of the page (src/lib/overview.ts).
COPY --from=build /ui/src/lib ./src/lib
# /api/config gives the hash of the page contract.
COPY --from=build /ui/skills/work-graph/contract.json ./skills/work-graph/contract.json
USER node
EXPOSE 4747
# Set WG_HOSTED to the name that the page answers under, and WG_CONFIG_JSON to the config (README "Host the page").
CMD ["node", "server/main.ts"]
