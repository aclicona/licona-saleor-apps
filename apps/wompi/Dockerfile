FROM node:22-slim AS builder
WORKDIR /app
# corepack en vez de `npm install -g pnpm`: aquel instalaba LA ULTIMA version
# publicada, que el 2026-08-22 era pnpm 11 mientras el proyecto se prueba con la
# 10.33. Esa deriva de una major rompio el build en Railway con
# ERR_PNPM_IGNORED_BUILDS, un fallo que en local no se reproducia. corepack lee
# el campo `packageManager` del package.json y usa exactamente esa version, que
# es lo que ya hacia el Dockerfile del storefront.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
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
# El paquete compartido se construye ANTES que la App: su package.json apunta a
# ./dist, que no existe hasta compilarlo, asi que `tsc` de la App falla con
# TS2307 "Cannot find module '@licona/webhook-utils'". Es el mismo motivo por el
# que un clone nuevo no pasa el typecheck sin `pnpm --filter @licona/webhook-utils build`.
RUN pnpm --filter @licona/webhook-utils build

WORKDIR /app/apps/wompi
RUN pnpm run build

FROM node:22-slim AS runner
WORKDIR /app
# corepack en vez de `npm install -g pnpm`: aquel instalaba LA ULTIMA version
# publicada, que el 2026-08-22 era pnpm 11 mientras el proyecto se prueba con la
# 10.33. Esa deriva de una major rompio el build en Railway con
# ERR_PNPM_IGNORED_BUILDS, un fallo que en local no se reproducia. corepack lee
# el campo `packageManager` del package.json y usa exactamente esa version, que
# es lo que ya hacia el Dockerfile del storefront.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
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
