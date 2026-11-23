FROM node:24-slim

# ffmpeg converts the AI voice into Discord audio
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_BIN=/usr/bin/ffmpeg

COPY package*.json ./
# --ignore-scripts: skip downloading ffmpeg-static (the system ffmpeg above is used)
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY . .
USER node
CMD ["node", "index.js"]
