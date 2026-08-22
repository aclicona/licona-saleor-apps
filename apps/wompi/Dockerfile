FROM node:22-slim AS builder
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# `pnpm-workspace.yaml` incluye `apps/*`, así que pnpm espera encontrar el
# manifiesto de TODAS las Apps del workspace. Con `--frozen-lockfile`, si falta
# una, el install falla porque el lockfile no cuadra con lo que ve.
# Por eso se copian los package.json de las demás Apps aunque esta imagen no las
# construya. AL AÑADIR UNA APP NUEVA HAY QUE AÑADIRLA AQUÍ, o el build de todas
# las demás se rompe — le pasó a `app-envios` el 2026-08-22, cuando `apps/wompi`
# llegó a `main`.
COPY packages ./packages
COPY apps/envios/package.json ./apps/envios/package.json
COPY apps/wompi ./apps/wompi
RUN pnpm install --frozen-lockfile
WORKDIR /app/apps/wompi
RUN pnpm run build

FROM node:22-slim AS runner
WORKDIR /app
RUN npm install -g pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/envios/package.json ./apps/envios/package.json
COPY apps/wompi/package.json ./apps/wompi/package.json
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/apps/wompi/dist ./apps/wompi/dist
COPY --from=builder /app/packages/webhook-utils/dist ./packages/webhook-utils/dist
WORKDIR /app/apps/wompi
EXPOSE 3002
CMD ["node", "dist/index.js"]
