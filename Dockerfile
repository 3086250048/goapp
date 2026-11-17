FROM python:3.12-slim

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    DATA_DIR=/data \
    DEMO_MODE=1 \
    DEMO_OTP=123456 \
    ADMIN_USERNAME=admin \
    SMS_PROVIDER=demo

WORKDIR /app

COPY server/requirements.txt /app/server/requirements.txt
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r /app/server/requirements.txt

COPY prototype /app/prototype
COPY admin /app/admin
COPY server /app/server

RUN mkdir -p /data && useradd --create-home --uid 10001 goapp \
    && chown -R goapp:goapp /app /data

USER goapp
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"

CMD ["python", "server/app.py"]
