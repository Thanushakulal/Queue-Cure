FROM node:24-alpine

# Install SQLite dependencies if needed (alpine may need build tools, but node-sqlite3 prebuilds work for most)
RUN apk add --no-repeat --no-cache python3 make g++

WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Expose port
ENV PORT=3000
EXPOSE 3000

# Run server
CMD ["node", "server.js"]
