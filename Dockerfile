FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
