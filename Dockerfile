FROM node:20-bullseye

# Библиотеки для запуска headless Chrome
RUN apt-get update && \
    apt-get install -y \
      ca-certificates \
      fonts-liberation fonts-noto-color-emoji \
      libnss3 libxss1 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
      libx11-xcb1 libxcomposite1 libxrandr2 libxdamage1 libxfixes3 \
      libxext6 libxi6 libxtst6 libdrm2 libgbm1 libcups2 \
      libgtk-3-0 libdbus-1-3 libatspi2.0-0 libxshmfence1 \
      libx11-6 libxcb1 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 \
      wget gnupg --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# говорим Puppeteer не скипать загрузку
ENV PUPPETEER_SKIP_DOWNLOAD=false
# куда ставить кеш
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

WORKDIR /app
COPY package*.json ./

# Здесь Puppeteer скачает Chromium
RUN npm ci --omit=dev && npx puppeteer browsers install chrome

COPY . .
EXPOSE 8080
CMD ["node","server.js"]