# MikeCockpit 🎛️

Painel de comando e telemetria do **MikeServer** (N97 · Proxmox → Debian → Docker).
Não é só leitura — **agir** à distância a partir do telemóvel, via Tailscale, como PWA instalável.

- **Porta**: `5700` · **URL**: `https://mikeserver.tail228d40.ts.net:5700`
- **Stack**: Python 3.12 + FastAPI + PWA vanilla (zero-build) — leve por design para o N97.
- **Acesso**: privado, só via Tailscale (sem auth, conforme decidido — confia-se na tailnet).

## Secções da app
| Aba | O que faz |
|---|---|
| **Visão** | CPU, RAM, temperatura, disco (gauges) + load, uptime, rede, por-núcleo, sparklines. |
| **Docker** | Lista de containers + estado; toca → reiniciar / parar / pausar / arrancar + ver logs. |
| **Sistema** | Info do host, top processos (CPU/RAM) e **reboot da VM** (com confirmação escrita). |
| **Comandos** | Allowlist de comandos no host (sync CoreRoom, guardar vault, prune, df…) com output. |
| **Claude** | Gerir sessões Claude em tmux por projeto (Start/Stop/Restart via `~/bin/mikeclaude`, como utilizador, sem sudo). |
| **Apps** | Auto-discovery de portas → links Tailscale das apps (CoreRoom, Portainer, Kuma…). |
| **Alertas** | Limiares + estado do Telegram + teste de push + histórico de alertas. |

## Notificações push
Alertas via **Telegram** quando CPU/RAM/disco/temperatura passam o limiar de forma sustentada,
ou quando um container cai. Configura `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` no `.env`.

## Deploy (no MikeServer)
```bash
# 1. clonar para a pasta de stacks
cd /opt/projects
git clone https://github.com/JZMike/mc-stuff.git mikecockpit
cd mikecockpit

# 2. configurar e subir
cp .env.example .env        # preenche TELEGRAM_* para teres push
./deploy.sh                 # build + up + health + tailscale serve
```
Abre `https://mikeserver.tail228d40.ts.net:5700` no telemóvel → **Adicionar ao ecrã principal** = PWA.

## Health
```bash
curl http://localhost:5700/health
```

## Notas de arquitetura
- O container corre com `pid: host`, `network_mode: host`, `privileged` e `docker.sock` montado —
  necessário para ver métricas reais do host, sensores de temperatura, processos, e poder agir
  (restart de containers, reboot, comandos). É o teu próprio servidor atrás de Tailscale.
- A PWA só faz polling da **aba ativa** e pausa quando está em background → leve no N97.
- `/api/*` nunca é cacheado pelo service worker (dados sempre frescos); a shell é offline-first.
