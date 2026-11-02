# Hermes Agency Hub — control plane image.
#
# This container's power comes entirely from the mounted Docker socket, not
# from any capability of its own: it needs no privileged flags, no added
# capabilities and no root filesystem access beyond the data root. Keep it
# that way — a hub that needs privileges is a hub that can be escalated out of.
FROM python:3.12-slim

# Python behaviour: no .pyc writes (the filesystem is disposable), unbuffered
# stdout so `docker logs` is live rather than lagging a block behind.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# curl is here for the image's own HEALTHCHECK. tini reaps zombies: uvicorn
# spawns no children today, but PID 1 without a reaper is a trap waiting for
# the first subprocess someone adds.
RUN apt-get update \
    && apt-get install --no-install-recommends -y curl tini \
    && rm -rf /var/lib/apt/lists/*

# Dependencies before source, so editing code does not invalidate the
# (slow) pip layer.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY templates ./templates
COPY alembic.ini ./
COPY migrations ./migrations

# Run unprivileged. The socket's group is granted at runtime by compose
# (group_add), not baked in here — the host's docker GID is not knowable at
# build time.
RUN useradd --create-home --uid 10001 hub \
    && chown -R hub:hub /app
USER hub

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8080"]
