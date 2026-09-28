# Multi-stage: build the frontend, then a slim Python runtime that serves
# both the API and the built SPA from one process (app/main.py already
# mounts frontend/dist itself — no separate nginx/frontend container).
#
# Code (app/, migrations/, frontend/dist/, VERSION, requirements.txt) lives
# in the image and is replaced by pulling a new tag, not by self-update's
# in-place file swap — see app/self_update.py, which refuses to auto-apply
# when CORTEXARR_DOCKER=1 (set below) for exactly this reason. Persistent
# state (config.yaml, the database, logs) lives under /data, the one
# volume this image expects.

FROM node:20-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/bsnwgit/cortexarr"

RUN groupadd --system cortexarr && useradd --system --gid cortexarr --home /data cortexarr

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY migrations/ ./migrations/
COPY docs/ ./docs/
COPY VERSION config.example.yaml ./
COPY --from=frontend /src/frontend/dist ./frontend/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV CORTEXARR_INSTALL_DIR=/data \
    CORTEXARR_CONFIG=/data/config.yaml \
    CORTEXARR_DOCKER=1

RUN mkdir -p /data/logs && chown -R cortexarr:cortexarr /data /app
VOLUME ["/data"]
USER cortexarr

EXPOSE 8770
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "-m", "app.main"]
