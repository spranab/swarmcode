# SwarmCode

[![npm](https://img.shields.io/npm/v/swarmcode-mcp)](https://www.npmjs.com/package/swarmcode-mcp)
[![npm downloads](https://img.shields.io/npm/dm/swarmcode-mcp)](https://www.npmjs.com/package/swarmcode-mcp)

> **Using `mcp-agent-bridge`?** That is the old name of this project and it no
> longer gets updates. Switch with
> `npm uninstall -g mcp-agent-bridge && npm install -g swarmcode-mcp`, then
> re-run `swarmcode-mcp init <workspace>`. Same Redis, same protocol; the
> tools are now `swarm_*` instead of `bridge_*`. See
> [Migrating from mcp-agent-bridge](#migrating-from-mcp-agent-bridge).

Two Claude Code instances can't talk to each other. The one on your desktop
that just changed the API schema has no way to tell the one on your laptop
that's writing the client against it — so you copy-paste between windows and
act as the message bus yourself.

SwarmCode is that message bus. Agents on any machine on your network join a
Redis-backed channel and send each other messages, artifacts, and workspace
status, delivered as real-time push into VS Code — no polling, no manual
relay.

```
Desktop (VS Code)          Laptop (VS Code)           Server
  Claude A ───────────────── Claude B ───────────────── Claude C
       \                      |                       /
        -------- Redis (single instance) ------------
                       |
                  Web Dashboard
              (monitor & control)
```

## Install (60 seconds)

```bash
npm install -g swarmcode-mcp

# Redis, if you don't already have one
docker run -d --name redis -p 6379:6379 redis:alpine

swarmcode-mcp init my-workspace --redis redis://your-redis:6379
```

Restart Claude Code. Repeat on every other machine, all pointing at the same
Redis. That's the whole setup.

## What it looks like

**Desktop** (building the API):

```
> swarm_register("Building user auth REST API")
> swarm_send(to: "laptop", type: "info",
             content: "POST /api/users is live, schema: {id, email, role}")
```

**Laptop** — the message arrives as a task-notification while its agent is
mid-task:

```
[task-notification] New message from "desktop": POST /api/users is live...
> swarm_receive()
> swarm_send(to: "desktop", type: "question",
             content: "Does /api/users support pagination?")
```

**Desktop**, instantly:

```
[task-notification] New message from "laptop": Does /api/users support pagination?
> swarm_receive()
> swarm_send(to: "laptop", type: "answer", content: "Yes, use ?page=1&limit=20")
```

No user in the loop. A terminal recording of the same exchange is in
[`demo/demo.cast`](demo/demo.cast) (`asciinema play demo/demo.cast`).

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

## Built With

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) — tool interface
- [Redis](https://redis.io/) — pub/sub + message storage
- [ioredis](https://github.com/redis/ioredis) — Redis client
- [Claude Code](https://claude.ai/code) — the agents

## Migrating from mcp-agent-bridge

SwarmCode was published as `mcp-agent-bridge` until the rename. The old
package still works but is frozen — new features and fixes only land in
`swarmcode-mcp`.

```bash
npm uninstall -g mcp-agent-bridge
npm install -g swarmcode-mcp
swarmcode-mcp init my-workspace --redis redis://your-redis:6379
```

What changes:

| Old (`mcp-agent-bridge`) | New (`swarmcode-mcp`) |
|---|---|
| `bridge_send` / `bridge_receive` / `bridge_register` | `swarm_send` / `swarm_receive` / `swarm_register` |
| `AGENT_BRIDGE_REDIS_URL` | `SWARMCODE_REDIS_URL` |
| `AGENT_BRIDGE_WORKSPACE_ID` | `SWARMCODE_WORKSPACE_ID` |
| binary `mcp-agent-bridge` | binary `swarmcode` / `swarmcode-mcp` |

The old `AGENT_BRIDGE_*` environment variables are still read as a fallback,
and the Redis wire format is unchanged, so a migrated workspace can talk to a
not-yet-migrated one during the switchover. Re-running `init` rewrites the
workspace's `.mcp.json` entry and hooks for you.

## Related projects

Other agent infrastructure by the same author, built to be used together:

- [saga-mcp](https://github.com/spranab/saga-mcp) — SQLite-backed project
  tracker so a swarm of agents shares one plan.
- [yantrikdb-mcp](https://github.com/yantrikos/yantrikdb-mcp) — persistent
  cognitive memory across sessions and machines.
- [brainstorm-mcp](https://github.com/spranab/brainstorm-mcp) — multi-model
  debate as an MCP tool.
- [mcpier](https://github.com/spranab/mcpier) — self-hosted MCP control plane
  that keeps API keys off your clients.

## License

MIT — [Pranab Sarkar](https://github.com/spranab)
