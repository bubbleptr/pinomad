# Server image for container platforms (Zeabur etc.): the published npm package,
# pinned, so the server hosts the same web client build as that release.
# Bump PINOMAD_VERSION together with the hosts (docs/remote-access.md "升级").
FROM node:26-slim
ARG PINOMAD_VERSION=0.6.0
RUN npm install -g pinomad@${PINOMAD_VERSION} && npm cache clean --force
# Account data (ADR-0022) lives under /data; mount a persistent volume there or
# every redeploy forgets users, sessions, and host bindings. The data dir is a
# subdirectory because its lock is the sibling `<dir>.lock` — `/data.lock`
# would land in the read-only-to-node root.
RUN mkdir -p /data/server && chown -R node:node /data
USER node
ENV PORT=8080
ENV PINOMAD_SERVER_DATA_DIR=/data/server
EXPOSE 8080
# PINOMAD_PUBLIC_ORIGIN: the https origin clients open (e.g. https://nomad.example.com).
# PINOMAD_SERVER_USER / PINOMAD_SERVER_PASSWORD: create the one account on first start.
# --trust-proxy: the platform terminates TLS; account traffic is refused unless
#   the proxy's X-Forwarded-Proto says https.
# The server keeps splice state in memory and locks its data dir: run exactly one instance.
CMD ["sh", "-c", "exec pinomad server --listen 0.0.0.0 --port \"$PORT\" --public-origin \"$PINOMAD_PUBLIC_ORIGIN\" --trust-proxy"]
