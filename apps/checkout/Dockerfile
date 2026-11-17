# The checkout server. Build from the repository root:
#
#   docker build -f apps/checkout/Dockerfile -t arc-checkout .
#   docker run --env-file .env -p 127.0.0.1:8790:8790 -v arc-checkout:/data arc-checkout

FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY packages packages
COPY apps/checkout apps/checkout
# Installs the checkout with the workspace packages it uses, then builds those packages.
RUN pnpm install --frozen-lockfile --filter "@arctoolkit/checkout..." \
 && pnpm --filter "@arctoolkit/checkout^..." build
WORKDIR /repo/apps/checkout
# Invoices, the chain position and undelivered webhooks live in a volume, so they survive a new image.
ENV STORE_PATH=/data/checkout.json HOST=0.0.0.0 PORT=8790
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8790/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--import", "tsx", "src/main.ts"]
