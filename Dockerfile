FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pil poppler-utils fonts-dejavu-core && apt-get clean

FROM base AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps/service/package.json apps/service/package.json
COPY apps/broker/package.json apps/broker/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY tests tests
COPY deploy deploy
COPY eslint.config.mjs vitest.config.ts ./
RUN pnpm check

FROM base AS runtime

WORKDIR /app
RUN corepack enable && chown node:node /app

COPY --chown=node:node LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/service/package.json apps/service/package.json
COPY --chown=node:node apps/broker/package.json apps/broker/package.json
COPY --chown=node:node packages/protocol/package.json packages/protocol/package.json

USER node
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node --from=build /app/apps/service/dist apps/service/dist
COPY --chown=node:node --from=build /app/apps/service/src/report-reader.py apps/service/dist/report-reader.py
COPY --chown=node:node --from=build /app/apps/broker/dist apps/broker/dist
COPY --chown=node:node --from=build /app/packages/protocol/dist packages/protocol/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/service/dist/index.js"]
