FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
# /raid-log captures public Damage pages in an isolated, on-demand browser.
RUN npx playwright install --with-deps --no-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

CMD ["node", "bot.js"]
