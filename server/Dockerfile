FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml ./
ARG INSTALL_AI=false
RUN python -m pip install --no-cache-dir --upgrade 'pip>=26.1.2' && \
    if [ "$INSTALL_AI" = "true" ]; then pip install --no-cache-dir '.[ai]'; else pip install --no-cache-dir .; fi
COPY app ./app
COPY alembic.ini ./
COPY alembic ./alembic
COPY entrypoint.sh ./

RUN useradd --create-home --uid 10001 finance && mkdir -p /data/documents && chown -R finance:finance /data
USER finance

CMD ["sh", "entrypoint.sh"]
