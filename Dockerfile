FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates ffmpeg curl && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --break-system-packages -U "yt-dlp[default]==2026.08.19"
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm","start"]
