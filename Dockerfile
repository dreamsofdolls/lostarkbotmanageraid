FROM node:20-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev
# /raid-log uses the smaller headless shell for public team/player captures.
RUN npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY . .

CMD ["node", "bot.js"]
