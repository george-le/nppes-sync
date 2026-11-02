FROM node:24-slim

WORKDIR /app

# python3 runs the payer adapter (sources/fhir_pd.py) inside the same image.
# ca-certificates: the slim base ships no CA bundle, so python3 cannot verify HTTPS without it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first so this layer caches across source edits.
# --legacy-peer-deps: @vitejs/plugin-react and vite have a peer range conflict.
COPY package.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY . .
RUN npm run build

# Set after install and build: NODE_ENV=production makes npm skip devDependencies.
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/data/nppes_pipeline.duckdb

VOLUME ["/data"]
EXPOSE 3000

CMD ["npx", "tsx", "server.ts"]
