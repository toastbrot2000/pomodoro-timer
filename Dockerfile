# Stdlib-only Python app — no dependencies to install, no build step.
FROM python:3.12-slim

WORKDIR /app

# App code (see .dockerignore for what's excluded)
COPY server.py ./
COPY public ./public

# SQLite database lives here; mount a volume at /data to persist it.
ENV POMODORO_DB=/data/pomodoro.db \
    HOST=0.0.0.0 \
    PORT=8080
VOLUME ["/data"]

EXPOSE 8080

# Run as a non-root user
RUN useradd --system --uid 10001 pomodoro \
    && mkdir -p /data \
    && chown -R pomodoro /data
USER pomodoro

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8080/api/state').status==200 else 1)" || exit 1

CMD ["python", "server.py"]
