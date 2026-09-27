# music-api image: node + what add_musics.sh needs (bash, ffmpeg, yt-dlp).
# yt-dlp is baked in at build time, and YouTube breaks old versions every few
# weeks, so to update it:  docker compose build --no-cache music-api && docker compose up -d
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85

RUN apk add --no-cache bash ffmpeg python3 curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && apk del curl \
 && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf \
 && yt-dlp --version
