# Agent Bridge

MCP server for real-time cross-machine communication between Claude Code instances.

```
Desktop (Workspace A)  ←→  Agent Bridge  ←→  Laptop (Workspace B)
    Claude Code            (Redis + SSE)       Claude Code
```

Agents can send messages, share artifacts (schemas, configs, code), and see each other's status — across machines, workspaces, and conversations.

## Quick Start

### 1. Install

```bash
npm install -g mcp-agent-bridge
```

### 2. Start Redis

```bash
docker run -d --name redis -p 6379:6379 redis:alpine
```

### 3. Start the server

```bash
# SSE mode (recommended — supports multiple clients)
mcp-agent-bridge --sse

# Or with custom Redis/port
AGENT_BRIDGE_REDIS_URL=redis://your-host:6379 AGENT_BRIDGE_PORT=4100 mcp-agent-bridge --sse
```

### 4. Connect a workspace

Add two files to your project root:

**`.mcp.json`** — connects Claude Code to the bridge:
```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "sse",
      "url": "http://localhost:4100/sse?workspace_id=my-workspace"
    }
  }
}
```

**`.claude/settings.json`** — auto-checks inbox on every conversation turn:
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/agent-bridge/src/check-inbox-http.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

The hook reads `workspace_id` from `.mcp.json` automatically — no duplication.

That's it. Restart Claude Code and the bridge is active.

## How It Works

1. **On every turn**, the `UserPromptSubmit` hook checks Redis for pending messages and injects them into Claude's context
2. **Claude sees** the messages and its workspace identity, and can act on them using the MCP tools
3. **MCP tool descriptions** instruct Claude to register, send, receive, and share proactively

## Tools

| Tool | Description |
|------|-------------|
| `register` | Register this workspace (called at conversation start) |
| `send` | Send a message to a specific workspace or broadcast to all (`to: "*"`) |
| `receive` | Check for and read pending messages |
| `status` | See all registered workspaces and what they're working on |
| `update_status` | Update your current task description |
| `share_artifact` | Share a schema, snippet, config, or interface |
| `get_artifact` | Retrieve a shared artifact by name |
| `list_artifacts` | List all shared artifacts |

## Message Types

Use the `type` field when sending to categorize messages:

| Type | When to use |
|------|-------------|
| `info` | General notifications ("API is ready", "deployed v2") |
| `request` | Asking another workspace to do something |
| `question` | Asking for information |
| `answer` | Responding to a question |
| `decision` | Recording an architectural/design decision |
| `artifact` | Auto-sent when `share_artifact` is called |

## REST API

When running in SSE mode, these REST endpoints are available for hooks and integrations:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Server status and connection count |
| `GET /api/inbox/:workspaceId` | Read pending messages for a workspace |
| `GET /api/status` | All registered workspaces |

## Deployment

### Local (Docker Compose)

```bash
# Start Redis + bridge
docker run -d --name redis -p 6379:6379 redis:alpine
mcp-agent-bridge --sse
```

### Kubernetes

Manifests are included in [`k8s/`](k8s/):

```bash
kubectl apply -f k8s/namespace.yml
kubectl apply -f k8s/redis.yml
kubectl apply -f k8s/agent-bridge.yml
kubectl apply -f k8s/ingress.yml    # edit hostname first
```

The Docker image is published to your container registry on every GitHub release.

### Stdio Mode

For single-machine setups where each workspace spawns its own server process:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "npx",
      "args": ["-y", "mcp-agent-bridge"],
      "env": {
        "AGENT_BRIDGE_REDIS_URL": "redis://localhost:6379"
      }
    }
  }
}
```

All instances share the same Redis, so messages flow between them.

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `AGENT_BRIDGE_REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `AGENT_BRIDGE_PORT` | `4100` | SSE server port |
| `AGENT_BRIDGE_PREFIX` | `agent-bridge:` | Redis key prefix (for multi-tenant Redis) |

## Architecture

```
src/
├── server.js          # Entry point — stdio + SSE transport, MCP resources, REST API
├── redis.js           # Redis connection management + pub/sub
├── tools.js           # MCP tool definitions and handlers
├── check-inbox.js     # Hook script (direct Redis)
└── check-inbox-http.js # Hook script (HTTP API, for remote deployments)
```

- **Redis** stores messages in per-workspace inbox lists (24h TTL) and workspace registrations (2h TTL)
- **Pub/sub** on `agent-bridge:messages` for real-time notifications
- **MCP resources** expose inboxes as subscribable resources for push updates
- **REST API** (`/api/*`) for hooks and external integrations

## Example Session

**Desktop** (building API):
```
> register("desktop-api", "Building user auth API", "desktop")
> share_artifact("desktop-api", "user-schema", "schema", '{"id":"uuid","email":"string","role":"string"}')
> send("desktop-api", "laptop-frontend", "info", "POST /api/users is live, see user-schema artifact")
```

**Laptop** (building frontend — sees message automatically via hook):
```
📨 AGENT BRIDGE: 1 pending message(s):
  [2:38 PM] desktop-api → laptop-frontend [info]:
    POST /api/users is live, see user-schema artifact

> receive("laptop-frontend")
> get_artifact("user-schema")
> send("laptop-frontend", "desktop-api", "question", "Does /api/users support pagination?")
```

## License

MIT — Pranab Sarkar
