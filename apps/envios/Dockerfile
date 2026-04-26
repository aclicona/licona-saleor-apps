FROM node:22-slim AS builder
WORKDIR /app

# Install pnpm in builder stage
RUN npm install -g pnpm

# Copy monorepo root files, shared packages, and app files
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
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
