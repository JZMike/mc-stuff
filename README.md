# mc-stuff

MikeServer general-purpose project scaffold.

- **Internal port**: 5700 (exposed via Nginx Proxy Manager / Cloudflare Tunnel)
- **Stack**: Python 3.12 + FastAPI + Docker Compose

## Start

```bash
cp .env.example .env
docker compose up -d
```

## Health check

```bash
curl http://localhost:5700/health
```
