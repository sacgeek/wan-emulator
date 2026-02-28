FROM node:20-alpine

RUN apk add --no-cache openssh-client

WORKDIR /app

# Cache bust argument - invalidates all layers below this line on each build
ARG CACHEBUST=1

# Copy backend
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

COPY backend/ ./backend/
COPY frontend/ ./frontend/

EXPOSE 3000

CMD ["node", "backend/server.js"]
