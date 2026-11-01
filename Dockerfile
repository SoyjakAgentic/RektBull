FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
