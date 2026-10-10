FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS frontend
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27.1-bookworm@sha256:8d48e12ec56735e9358640898b9d9b9fcca110612ed8a5567438c0a1baa24e66 AS backend
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -o /out/sillage ./cmd/server

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS tools
ARG TARGETARCH
ARG YTDLP_REPOSITORY=yt-dlp/yt-dlp
ARG YTDLP_VERSION=2026.08.19
ARG YTDLP_SHA256=58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a
ARG DENO_VERSION=2.9.7
ARG DENO_SHA256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
RUN test "$TARGETARCH" = amd64
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /downloads
# Les empreintes attendues sont versionnées avec le build, pas téléchargées pour le valider.
RUN curl -fSL --retry 3 "https://github.com/${YTDLP_REPOSITORY}/releases/download/${YTDLP_VERSION}/yt-dlp_linux" -o yt-dlp \
    && echo "${YTDLP_SHA256}  yt-dlp" | sha256sum -c - \
    && curl -fSL --retry 3 "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip" -o deno.zip \
    && echo "${DENO_SHA256}  deno.zip" | sha256sum -c - \
    && unzip deno.zip deno && chmod 0755 yt-dlp deno

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg libstdc++6 libgcc-s1 libatomic1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 sillage \
    && useradd --uid 1000 --gid 1000 --no-create-home sillage \
    && mkdir -p /app/data && chown 1000:1000 /app/data
WORKDIR /app
COPY --from=backend /out/sillage /usr/local/bin/sillage
COPY --from=frontend /build/web/dist/ /app/web/
COPY --from=tools /downloads/yt-dlp /downloads/deno /usr/local/bin/
# Les caches sont temporaires ; seul /app/data doit être conservé.
ENV SILLAGE_HTTP_ADDR=0.0.0.0:8080 SILLAGE_WEB_DIR=/app/web \
    HOME=/tmp XDG_CACHE_HOME=/tmp/.cache DENO_DIR=/tmp/deno
USER 1000:1000
EXPOSE 8080
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/sillage"]
