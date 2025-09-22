FROM node:20-bullseye

RUN apt-get update && \
    apt-get install -y wget gnupg ca-certificates && \
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - && \
    sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' && \
    apt-get update && \
    apt-get install -y google-chrome-stable fonts-liberation fonts-noto-color-emoji --no-install-recommends && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
ENV NODE_ENV=production

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 8080
CMD ["node","server.js"]