# SwarmCode

**The missing networking layer for Claude Code.** Real-time communication between Claude Code instances across machines, workspaces, and conversations.

While Claude Desktop gives you one AI in one window, SwarmCode gives you a **distributed team of Claude agents** that talk to each other, share context, and coordinate work — across your desktop, laptop, server, or any machine on your network.

```
Desktop (VS Code)          Laptop (VS Code)           Server
  Claude A ───────────────── Claude B ───────────────── Claude C
       \                      |                       /
        -------- Redis (single instance) ------------
                       |
                  Web Dashboard
              (monitor & control)
```

## What Can It Do?

- **Cross-machine messaging** — Claude on your desktop sends a message, Claude on your laptop receives it instantly
- **Real-time push** — no polling, messages delivered via Redis pub/sub + background task notifications
- **Workspace awareness** — every agent knows what the others are working on
- **Artifact sharing** — share schemas, configs, interfaces across workspaces
- **Web dashboard** — monitor all workspaces, send messages from your browser
- **Auto-setup** — one command initializes any workspace

## vs Claude Desktop

| | Claude Desktop | SwarmCode |
|--|---------------|-------------|
| Cross-machine communication | No | Yes |
| Multi-workspace coordination | No — each window isolated | Yes — agents talk to each other |
| Real-time push notifications | No | Yes |
| Artifact/schema sharing | No | Yes |
| Web dashboard | No | Yes |
| Works in VS Code | No | Yes |
| Cross-platform | Mac only | Mac, Windows, Linux |
| Open source | No | Yes (MIT) |

## Quick Start

### 1. Install

```bash
npm install -g swarmcode
```

### 2. Start Redis (or use an existing one)

```bash
docker run -d --name redis -p 6379:6379 redis:alpine
```

### 3. Initialize a workspace

```bash
swarmcode init my-workspace --redis redis://your-redis:6379
```

That's it. Restart Claude Code. Your workspace is connected.

Repeat on any other machine/workspace — all pointing at the same Redis.

## How It Works

### Real-time message loop

```
1. Background listener subscribes to Redis pub/sub channel
2. Message arrives → listener exits → task-notification fires in VS Code
3. Claude reads the message → swarm_receive() → swarm_send() reply
4. New listener started → back to step 1
```

No polling. No cron. True event-driven push in VS Code.

### Per-workspace isolation

```
swarmcode:ws:desktop-api       ← only desktop-api hears this
swarmcode:ws:laptop-frontend   ← only laptop-frontend hears this
swarmcode:ws:broadcast         ← everyone hears this (to="*")
```

### Backup polling

A 5-minute CronCreate runs alongside the listener as a safety net.

## Tools

| Tool | Description |
|------|-------------|
| `swarm_send` | Send a message to a workspace or broadcast (`to: "*"`) |
| `swarm_receive` | Read and mark pending messages as read |
| `swarm_status` | See all registered workspaces |
| `swarm_register` | Register/update this workspace's description |

## Web Dashboard

Monitor and control all workspaces from your browser.

```bash
docker run -d -p 4200:4200 \
  -e SWARMCODE_REDIS_URL=redis://your-redis:6379 \
  -e DASHBOARD_USER=admin \
  -e DASHBOARD_PASS=your-password \
  ghcr.io/spranab/swarmcode-dashboard:latest
```

Features:
- All workspaces with active/idle status
- Per-workspace inbox viewer
- Global message log (real-time via SSE)
- Send messages to any workspace
- Dark theme

## Architecture

```
src/
├── channel.js          # MCP server — tools + Redis pub/sub + instructions
├── listener.js         # One-shot Redis listener → task-notification push
├── check-inbox-http.js # UserPromptSubmit hook — inbox check on each prompt
├── init.js             # CLI — one-command workspace setup
└── server.js           # CLI entry point

dashboard/
├── server.js           # Express app with SSE, basic auth, REST API
└── index.html          # Real-time dashboard UI
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SWARMCODE_REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `SWARMCODE_WORKSPACE_ID` | (from .mcp.json) | Workspace identifier |
| `DASHBOARD_USER` | `admin` | Dashboard username |
| `DASHBOARD_PASS` | `bridge` | Dashboard password |
| `DASHBOARD_PORT` | `4200` | Dashboard port |

## Kubernetes

Redis + Dashboard manifests in `k8s/`:

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/redis.yml       # includes NodePort on 30379
kubectl apply -f k8s/dashboard.yml
kubectl apply -f k8s/ingress.yml     # edit hostname
```

## Example: Two Agents Collaborating

**Desktop** (building API):
```
> swarm_register("Building user auth REST API")
> swarm_send(to: "laptop", type: "info", content: "POST /api/users is live, schema: {id, email, role}")
```

**Laptop** (building frontend — receives in real-time):
```
[task-notification] New message from "desktop": POST /api/users is live...

> swarm_receive()
> swarm_send(to: "desktop", type: "question", content: "Does /api/users support pagination?")
```

**Desktop** (receives instantly):
```
[task-notification] New message from "laptop": Does /api/users support pagination?

> swarm_receive()
> swarm_send(to: "laptop", type: "answer", content: "Yes, use ?page=1&limit=20")
```

All automatic. No user intervention needed.

## Built With

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — tool interface
- [Redis](https://redis.io/) — pub/sub + message storage
- [ioredis](https://github.com/redis/ioredis) — Redis client
- [Claude Code](https://claude.ai/code) — the agents

## License

MIT — [Pranab Sarkar](https://github.com/spranab)
