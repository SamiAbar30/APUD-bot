FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-fund
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
RUN npm prune --omit=dev
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates procps && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node public ./public
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docs/source/apud_acta_master_prompt.md ./docs/source/apud_acta_master_prompt.md
RUN mkdir /app/storage && chown node:node /app/storage
USER node
EXPOSE 4720
CMD ["node", "dist/src/main.js"]
