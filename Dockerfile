FROM oven/bun:1.4.0 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
RUN bun build --compile src/cli.ts --outfile /oauth-proxy

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data \
  && chown 65532:65532 /data

COPY --from=build --chmod=755 /oauth-proxy /usr/local/bin/oauth-proxy

USER 65532:65532
WORKDIR /data
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/oauth-proxy"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3000"]
