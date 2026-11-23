# The hosted work-graph page (README "Host the page"). Node runs the TypeScript server directly.
FROM node:24.22.1-alpine AS build
WORKDIR /ui
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
COPY skills/work-graph/contract.json ./skills/work-graph/contract.json
COPY server ./server
RUN pnpm build && pnpm prune --prod && rm server/*.test.ts src/lib/*.test.ts

FROM node:24.22.1-alpine
WORKDIR /ui
ENV NODE_ENV=production
COPY --from=build /ui/package.json ./
COPY --from=build /ui/node_modules ./node_modules
COPY --from=build /ui/dist ./dist
COPY --from=build /ui/server ./server
# The server makes the overview with the graph rules of the page (src/lib/overview.ts).
COPY --from=build /ui/src/lib ./src/lib
USER node
EXPOSE 4747
# Set WG_HOSTED to the name that the page answers under, and WG_CONFIG_JSON to the config (README "Host the page").
CMD ["node", "server/main.ts"]
