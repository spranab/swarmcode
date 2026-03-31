# Agent Bridge

Real-time communication between Claude Code instances across machines and workspaces.

```
Desktop                        Laptop
  Claude A ──► Redis ◄── Claude B
         bridge_send    bridge_receive
              pub/sub channels
```

Agents can send messages, share artifacts, and coordinate work — across machines, workspaces, and conversations. Messages are delivered in real-time using Redis pub/sub and background task notifications.

## Quick Start

### 1. Install

```bash
npm install -g mcp-agent-bridge
```

### 2. Have Redis running

```bash
# Local
docker run -d --name redis -p 6379:6379 redis:alpine

# Or use any accessible Redis (cloud, K8s, etc.)
```

### 3. Initialize a workspace

```bash
npx mcp-agent-bridge init my-workspace --redis redis://your-redis:6379
```

This creates two files and registers with the bridge:

**`.mcp.json`** — channel MCP server (direct Redis):
```json
{
  "mcpServers": {
    "agent-bridge-channel": {
      "command": "node",
      "args": ["/path/to/channel.js"],
      "env": {
        "AGENT_BRIDGE_REDIS_URL": "redis://your-redis:6379",
        "AGENT_BRIDGE_WORKSPACE_ID": "my-workspace"
      }
    }
  }
}
```

**`.claude/settings.json`** — hook for inbox check on each prompt:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/check-inbox-http.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

Restart Claude Code and the bridge is active.

### 4. Start the real-time listener

In your Claude Code session, run:
```
Start background listener: node /path/to/agent-bridge/src/listener.js
```

Or Claude will start it automatically after calling `bridge_receive`.

## How It Works

### Real-time push (background task pattern)

```
1. Background listener subscribes to Redis channel
2. Message arrives → listener exits → task-notification fires
3. Claude reads output → bridge_receive → bridge_send reply
4. New listener started → back to step 1
```

No polling. No cron. True event-driven push in VS Code.

### Per-workspace isolation

Each workspace gets its own Redis pub/sub channel:

```
agent-bridge:ws:desktop-api       ← only desktop-api hears this
agent-bridge:ws:laptop-frontend   ← only laptop-frontend hears this
agent-bridge:ws:broadcast         ← everyone hears this (to="*")
```

Messages are stored in per-workspace inbox lists with 24h TTL. Workspace registrations expire after 2h of inactivity.

## Tools

The channel MCP server exposes these tools to Claude:

| Tool | Description |
|------|-------------|
| `bridge_send` | Send a message to a workspace or broadcast (`to: "*"`) |
| `bridge_receive` | Read pending messages and mark as read |
| `bridge_status` | See all registered workspaces |
| `bridge_register` | Register/update this workspace's description |

## Message Types

| Type | When to use |
|------|-------------|
| `info` | General notifications ("API is ready") |
| `request` | Asking another workspace to do something |
| `question` | Asking for information |
| `answer` | Responding to a question |
| `decision` | Recording a design decision |
| `artifact` | Sharing code, schemas, configs |

## Deployment

### All you need is Redis

Every workspace connects to the same Redis. Options:

```bash
# Local Docker
docker run -d --name redis -p 6379:6379 redis:alpine

# Kubernetes (included in k8s/ manifests)
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/redis.yml

# Cloud (Upstash, Redis Cloud, etc.)
# Just use the connection URL
```

### Kubernetes manifests

Included in `k8s/` for Redis with NodePort exposure:

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/redis.yml    # includes NodePort on 30379
```

## Architecture

```
src/
├── channel.js          # MCP server — tools + Redis pub/sub subscriber
├── listener.js         # One-shot Redis listener for background task notifications
├── check-inbox-http.js # Hook script — checks inbox on each prompt (fallback)
├── init.js             # CLI — initialize a workspace in one command
└── server.js           # CLI entry point — routes to init/channel/listen
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGENT_BRIDGE_REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `AGENT_BRIDGE_WORKSPACE_ID` | (from .mcp.json) | This workspace's ID |
| `AGENT_BRIDGE_PREFIX` | `agent-bridge:` | Redis key prefix |

## Example Session

**Desktop** (building API):
```
> bridge_register("Building user auth API")
> bridge_send(to: "laptop-frontend", type: "info", content: "POST /api/users is live")
```

**Laptop** (building frontend — receives message in real-time):
```
[task-notification] New message from "desktop-api": POST /api/users is live

> bridge_receive()  // mark as read
> bridge_send(to: "desktop-api", type: "question", content: "Does /api/users support pagination?")
```

**Desktop** (receives reply in real-time):
```
[task-notification] New message from "laptop-frontend": Does /api/users support pagination?

> bridge_receive()
> bridge_send(to: "laptop-frontend", type: "answer", content: "Yes, use ?page=1&limit=20")
```

## License

MIT — Pranab Sarkar
