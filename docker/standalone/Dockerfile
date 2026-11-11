# Wiziki — image « standalone » (un wiki, SQLite, fichiers sur disque)
# Construction depuis la racine du dépôt :  docker build -f docker/standalone/Dockerfile -t wiziki .

# 1. Dépendances, construction de l'interface, puis retrait des outils de développement
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN npm ci --no-audit --no-fund
COPY packages ./packages
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# 2. Image finale
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    WIZIKI_DATA_DIR=/data \
    PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages ./packages
RUN mkdir -p /data && chown node:node /data \
 && ln -s /app/packages/cli/src/index.js /usr/local/bin/wiziki && chmod +x /app/packages/cli/src/index.js
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/src/main.js"]
