# Relay image for container platforms (Zeabur etc.): the published npm package,
# pinned, so the relay serves the same web client build as that release.
# Bump PINOMAD_VERSION together with the hosts (README "升级").
FROM node:26-slim
ARG PINOMAD_VERSION=0.1.1
RUN npm install -g pinomad@${PINOMAD_VERSION} && npm cache clean --force
USER node
ENV PORT=8080
EXPOSE 8080
# PINOMAD_PUBLIC_ORIGIN: the https origin clients open (e.g. https://nomad.example.com).
# PINOMAD_ALLOW_HOST: space-separated hostIds (`pinomad relay-id` on each host).
# The relay keeps splice state in memory: run exactly one instance.
CMD ["sh", "-c", "set --; for h in $PINOMAD_ALLOW_HOST; do set -- \"$@\" --allow-host \"$h\"; done; exec pinomad relay --listen 0.0.0.0 --port \"$PORT\" --public-origin \"$PINOMAD_PUBLIC_ORIGIN\" \"$@\""]
