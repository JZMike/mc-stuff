FROM python:3.12-slim

# nsenter (util-linux) é preciso para executar ações no host (reboot, comandos)
RUN apt-get update && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5599
# Liga só ao loopback na porta do .env (default 5599); o `tailscale serve` faz a ponte
# tailnet:PORT -> 127.0.0.1:PORT. (com network_mode:host, 0.0.0.0 colidiria com o tailscaled.)
CMD ["sh", "-c", "exec uvicorn main:app --host 127.0.0.1 --port ${PORT:-5599}"]
