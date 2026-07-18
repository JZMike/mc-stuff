# MikeCockpit 🎛️

Painel de comando e telemetria do **MikeServer** (N97 · Proxmox → Debian → Docker).
Não é só leitura — **agir** à distância a partir do telemóvel, via Tailscale, como PWA instalável.

- **Porta**: `5599` · **URL**: `https://mikeserver.tail228d40.ts.net:5599`
- **Stack**: Python 3.12 + FastAPI + PWA vanilla (zero-build) — leve por design para o N97.
- **Acesso**: privado, só via Tailscale (sem auth, conforme decidido — confia-se na tailnet).

## Secções da app (5 destinos por intenção)
| Aba | O que faz |
|---|---|
| **Home** | Vista por defeito: hero de saúde global, "precisa de atenção", gauges CPU/RAM/disco com sparklines, preview vivo do mapa, uptime/carga/containers/apps. |
| **Infra** | Segmented control **Docker · Apps · Mapa**: containers agrupados por stack compose (com restart do stack todo), logs snapshot **e ao vivo (SSE)**, auto-discovery de portas → links Tailscale, e o mapa orbital do servidor. |
| **Sistema** | Acordeão: info do host, **histórico de métricas (CPU/RAM/temp, 1h/6h/24h)**, Tailscale, backups, top processos (CPU/RAM) e **reboot da VM** (com confirmação escrita). |
| **Automação** | Segmented **Comandos · Claude · AL**: allowlist de comandos no host, gestão de sessões Claude em tmux (Start/Stop/Restart/**Remote Control** via `~/bin/mikeclaude`, sem sudo), e **projetos AL do Azure DevOps** (ver abaixo). |
| **Alertas** | Limiares + estado do Telegram + teste de push + histórico de alertas. |

**Command palette**: botão ⌕ no topo (ou `⌘K` / `/`) — salta para qualquer container, app, comando ou sessão.

## Projetos AL / Azure DevOps
Trabalhar os projetos AL (Business Central) a partir do telemóvel, com o PC desligado:

1. **Sync** clona/atualiza o repo DevOps para `/opt/projects/al-<repo>` (auth via PAT no `.env`,
   nunca gravado no clone).
2. **Sessão** escreve o briefing (erro colado ou work item do DevOps) em `TASK.md` e arranca
   uma sessão Claude em tmux (`claude-al-<repo>`), que trabalha numa branch `fix/…` segundo as
   regras do `CLAUDE.md` (nunca push direto à default; compilar com `alc` se disponível).
3. **PR** faz push da branch e cria o Pull Request no DevOps — reves no VS Code (`git pull`)
   ou no browser antes do merge.

Config no `.env`: `AZDO_ORG_URL` (https://dev.azure.com/&lt;org&gt;), `AZDO_PROJECT`,
`AZDO_PAT` (scopes: **Code Read & Write** + **Work Items Read**). Os bugs abertos do projeto
aparecem na secção AL e na command palette.

## Notificações push
Alertas via **Telegram** quando CPU/RAM/disco/temperatura passam o limiar de forma sustentada,
ou quando um container cai. Configura `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` no `.env`.
Os alertas de container caído trazem **botões inline** (↻ Reiniciar · 🔕 Silenciar 1h) — agir
sem abrir a app. O bot só aceita callbacks do `TELEGRAM_CHAT_ID` configurado.

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
Abre `https://mikeserver.tail228d40.ts.net:5599` no telemóvel → **Adicionar ao ecrã principal** = PWA.

## Health
```bash
curl http://localhost:5599/health
```

## Notas de arquitetura
- O container corre com `pid: host`, `network_mode: host`, `privileged` e `docker.sock` montado —
  necessário para ver métricas reais do host, sensores de temperatura, processos, e poder agir
  (restart de containers, reboot, comandos). É o teu próprio servidor atrás de Tailscale.
- A PWA só faz polling da **aba ativa** e pausa quando está em background → leve no N97.
- `/api/*` nunca é cacheado pelo service worker (dados sempre frescos); a shell é offline-first.
