FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

RUN mkdir -p .cache && chown -R node:node .cache

ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "src/server.js"]
