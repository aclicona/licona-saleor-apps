FROM node:22-slim AS builder
WORKDIR /app

# Install pnpm in builder stage
RUN npm install -g pnpm

# Copy monorepo root files, shared packages, and app files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# `pnpm-workspace.yaml` incluye `apps/*`, así que pnpm espera encontrar el
# manifiesto de TODAS las Apps del workspace. Con `--frozen-lockfile`, si falta
# una, el install falla porque el lockfile no cuadra con lo que ve.
# Por eso se copian los package.json de las demás Apps aunque esta imagen no las
# construya. AL AÑADIR UNA APP NUEVA HAY QUE AÑADIRLA AQUÍ, o el build de todas
# las demás se rompe — le pasó a `app-envios` el 2026-08-22, cuando `apps/wompi`
# llegó a `main`.
COPY packages ./packages
COPY apps/wompi/package.json ./apps/wompi/package.json
COPY apps/envios ./apps/envios

# Install dependencies with frozen lockfile
RUN pnpm install --frozen-lockfile

# Build the app
WORKDIR /app/apps/envios
RUN pnpm run build

# Runner stage
FROM node:22-slim AS runner
WORKDIR /app

# Install pnpm in runner stage
RUN npm install -g pnpm

# Copy lockfiles and package files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/wompi/package.json ./apps/wompi/package.json
COPY apps/envios/package.json ./apps/envios/package.json

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts from builder (app + shared package)
COPY --from=builder /app/apps/envios/dist ./apps/envios/dist
COPY --from=builder /app/packages/webhook-utils/dist ./packages/webhook-utils/dist

# Set working directory to app
WORKDIR /app/apps/envios

EXPOSE 3001
CMD ["node", "dist/index.js"]
