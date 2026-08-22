FROM node:22-slim AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/wompi ./apps/wompi
RUN pnpm install --frozen-lockfile
WORKDIR /app/apps/wompi
RUN pnpm run build

FROM node:22-slim AS runner
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/wompi/package.json ./apps/wompi/package.json
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/apps/wompi/dist ./apps/wompi/dist
COPY --from=builder /app/packages/webhook-utils/dist ./packages/webhook-utils/dist
WORKDIR /app/apps/wompi
EXPOSE 3002
CMD ["node", "dist/index.js"]
