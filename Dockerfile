FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig*.json ./
COPY apps/service/package.json apps/service/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY patches patches
RUN pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
RUN corepack enable && chown node:node /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node apps/service/package.json apps/service/package.json
COPY --chown=node:node packages/protocol/package.json packages/protocol/package.json
COPY --chown=node:node patches patches

USER node
RUN pnpm install --prod --frozen-lockfile

COPY --chown=node:node --from=build /app/apps/service/dist apps/service/dist
COPY --chown=node:node --from=build /app/packages/protocol/dist packages/protocol/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "apps/service/dist/index.js"]
