FROM caddy:2.10.2-alpine
ARG REVISION
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY web/ /srv/
RUN test -n "$REVISION" && printf '{"revision":"%s"}\n' "$REVISION" > /srv/release.json
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
