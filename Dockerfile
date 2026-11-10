# Node 24 LTS on Debian bookworm; the Debian release is pinned because the
# Playwright step below installs Chromium's system packages for it.
FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
# /raid-log uses the smaller headless shell for public team/player captures.
RUN npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

CMD ["node", "bot.js"]
