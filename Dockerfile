FROM node:22.16.0-bookworm-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN VITE_GUIDE_MODE=demo npm run build

FROM python:3.11.14-slim-bookworm AS runtime
RUN pip install --no-cache-dir uv==0.13.7
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src/ ./src/
RUN uv sync --frozen --no-dev --no-editable && \
    groupadd --gid 10001 guide && useradd --uid 10001 --gid guide --no-create-home guide && \
    mkdir /data && chown guide:guide /data
COPY --from=frontend /build/frontend/dist ./frontend/dist
COPY tools/course_proxy.py /app/course_proxy.py
ARG GUIDE_RELEASE_ID=local
LABEL org.opencontainers.image.source="https://github.com/Joey-Z-G-W/AI-Enterprise-Exhibition" \
      org.opencontainers.image.revision=$GUIDE_RELEASE_ID
ENV PATH="/app/.venv/bin:$PATH" GUIDE_DEMO_DB=/data/guide.sqlite3 \
    GUIDE_STATIC_DIR=/app/frontend/dist GUIDE_RELEASE_ID=$GUIDE_RELEASE_ID PYTHONUNBUFFERED=1
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)"
CMD ["uvicorn", "exhibition_guide.demo:create_demo_app", "--factory", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
