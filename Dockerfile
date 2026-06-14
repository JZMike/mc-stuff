FROM python:3.12-slim

# nsenter (util-linux) é preciso para executar ações no host (reboot, comandos)
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5700
# Liga só ao loopback: o `tailscale serve` faz a ponte tailnet:5700 -> 127.0.0.1:5700.
# (com network_mode:host, 0.0.0.0 colidiria com o tailscaled que já tem a tailnet:5700)
CMD ["uvicorn", "main:app", "--host", "127.0.0.1", "--port", "5700"]
