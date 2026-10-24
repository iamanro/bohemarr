# vltava-cli-build when the image should contain the Vltava tracker's `vltava` CLI (compose.vltava.yaml sets it).
ARG VLTAVA_CLI_STAGE=vltava-cli-none

FROM debian:trixie-slim AS bento4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /bento4
ARG BENTO4_REV=b8c50a078356a1c3444ce0a8744634ed488424a4
RUN git init && git remote add origin https://github.com/axiomatic-systems/Bento4.git && git fetch --depth 1 origin "$BENTO4_REV" && git checkout --detach FETCH_HEAD
RUN git archive --format=tar HEAD | gzip > /bento4-source.tar.gz
RUN cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build --target mp4decrypt --parallel 2

# Static FFmpeg release build (BtbN). Debian's packaged FFmpeg lags several major versions and
# its MP4 demuxer rejects per-fragment CENC boxes; tests and production run this same binary.
FROM debian:trixie-slim AS ffmpeg
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
ARG FFMPEG_BUILD=autobuild-2026-10-24-13-02
ARG FFMPEG_VERSION=n9.0.2-35-g9a9b70bb8c
ARG FFMPEG_SHA256_AMD64=ddffcf6e3d537dd9e0039f0635261be40dd9bfdafb2ea85970173e928e024e50
ARG FFMPEG_SHA256_ARM64=710ac178fffa266d6b197a9e3cca4d2c62f35bed70d5cf99762d40aa8a5791f9
# The tarballs come from this repository's release ffmpeg-${FFMPEG_VERSION}, a copy of the BtbN build
# FFMPEG_BUILD: BtbN removes its autobuilds after a few weeks. Pass the BtbN URL to build from the original.
ARG FFMPEG_BASE_URL=https://github.com/iamanro/bohemarr/releases/download/ffmpeg-${FFMPEG_VERSION}
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) platform=linux64; sha="$FFMPEG_SHA256_AMD64" ;; \
    arm64) platform=linuxarm64; sha="$FFMPEG_SHA256_ARM64" ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac; \
  asset="ffmpeg-${FFMPEG_VERSION}-${platform}-gpl-9.0"; \
  curl -fsSL "${FFMPEG_BASE_URL}/${asset}.tar.xz" -o /tmp/ffmpeg.tar.xz; \
  echo "$sha  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
  tar -xJf /tmp/ffmpeg.tar.xz -C /tmp; \
  mkdir -p /out/bin /out/doc; \
  install -m 755 "/tmp/${asset}/bin/ffmpeg" "/tmp/${asset}/bin/ffprobe" /out/bin/; \
  cp "/tmp/${asset}/LICENSE.txt" /out/doc/LICENSE.txt; \
  echo "https://github.com/BtbN/FFmpeg-Builds/releases/tag/${FFMPEG_BUILD} ${asset}" > /out/doc/SOURCE.txt

# The `vltava` CLI, built from the Vltava source passed as the `vltava` build context. Only the paths
# named here are transferred, never the source's build output.
FROM rust:1.99-slim-trixie AS vltava-cli-build
RUN apt-get update && apt-get install -y --no-install-recommends cmake g++ make zlib1g-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY --from=vltava Cargo.toml Cargo.lock ./
COPY --from=vltava crates/ ./crates/
RUN cargo build --release --locked -p cli && install -D target/release/vltava /out/vltava

FROM debian:trixie-slim AS vltava-cli-none
RUN mkdir /out

FROM ${VLTAVA_CLI_STAGE} AS vltava-cli

FROM oven/bun:1.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile --cwd web
COPY web/ ./web/
RUN bun run build

FROM oven/bun:1.4-slim AS test
WORKDIR /app
COPY --from=ffmpeg /out/bin/ /usr/local/bin/
COPY --from=bento4 /bento4/build/mp4decrypt /usr/local/bin/mp4decrypt
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
COPY test/ ./test/
RUN bun run check && bun run test

FROM oven/bun:1.4-slim
LABEL org.opencontainers.image.title="Bohemarr" \
      org.opencontainers.image.description="Czech and Slovak TV archives for Sonarr and Radarr" \
      org.opencontainers.image.source="https://github.com/iamanro/bohemarr" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
# Layers from the least to the most often changed, so a code change exports and pulls only the last ones.
COPY --from=ffmpeg /out/bin/ /usr/local/bin/
COPY --from=ffmpeg /out/doc/ /usr/share/doc/ffmpeg/
COPY --from=bento4 /bento4/build/mp4decrypt /usr/local/bin/mp4decrypt
COPY --from=bento4 /bento4-source.tar.gz /usr/share/bento4-source.tar.gz
COPY --from=vltava-cli /out/ /usr/local/bin/
RUN mkdir /config /downloads && chown bun:bun /config /downloads
WORKDIR /app
COPY LICENSE ./
COPY LICENSES/ ./LICENSES/
COPY --from=build /app/node_modules ./node_modules/
COPY package.json ./
COPY --from=build /app/web/dist ./web/dist/
COPY src/ ./src/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/config DOWNLOADS_DIR=/downloads
USER bun
EXPOSE 8787
VOLUME ["/config", "/downloads"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD bun -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/main.ts"]
