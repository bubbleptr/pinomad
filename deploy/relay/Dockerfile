# Relay image for container platforms (Zeabur etc.): the published npm package,
# pinned, so the relay serves the same web client build as that release.
# Bump PINOMAD_VERSION together with the hosts (docs/remote-access.md "升级").
FROM node:26-slim
ARG PINOMAD_VERSION=0.4.0
RUN npm install -g pinomad@${PINOMAD_VERSION} && npm cache clean --force
# Account data (ADR-0022) lives here; mount a persistent volume at /data or
# every redeploy forgets users, sessions, and host bindings.
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080
ENV PINOMAD_SERVER_DATA_DIR=/data
EXPOSE 8080
# PINOMAD_PUBLIC_ORIGIN: the https origin clients open (e.g. https://nomad.example.com).
# PINOMAD_SERVER_USER / PINOMAD_SERVER_PASSWORD: create the one account on first start.
# PINOMAD_ALLOW_HOST: optional, space-separated hostIds admitted without an account
#   (the pre-accounts allowlist; drop it once every host ran `pinomad join`).
# --trust-proxy: the platform terminates TLS; account traffic is refused unless
#   the proxy's X-Forwarded-Proto says https.
# The relay keeps splice state in memory and locks its data dir: run exactly one instance.
CMD ["sh", "-c", "set --; for h in $PINOMAD_ALLOW_HOST; do set -- \"$@\" --allow-host \"$h\"; done; exec pinomad relay --listen 0.0.0.0 --port \"$PORT\" --public-origin \"$PINOMAD_PUBLIC_ORIGIN\" --trust-proxy \"$@\""]
