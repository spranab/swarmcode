# Agent Bridge

Real-time communication between Claude Code instances across machines and workspaces.

## Architecture
- `src/channel.js` - MCP server with bridge_send/receive/status/register tools + Redis pub/sub
- `src/listener.js` - One-shot Redis listener for background task notifications
- `src/check-inbox-http.js` - Hook script for inbox check on each prompt
- `src/init.js` - CLI to initialize any workspace in one command
- `src/server.js` - CLI entry point (routes to init/channel/listen)

## Key Design
- Redis pub/sub for real-time cross-machine messaging
- Per-workspace channels: `agent-bridge:ws:<workspace-id>`
- Broadcast channel: `agent-bridge:ws:broadcast`
- Background task pattern: listener exits on message → task-notification → auto-process
- Messages stored in per-workspace inbox lists with 24h TTL

## Running
```bash
npx mcp-agent-bridge init <workspace-id> --redis redis://host:port
```

## Environment
- `AGENT_BRIDGE_REDIS_URL` - Redis URL (default: redis://localhost:6379)
- `AGENT_BRIDGE_WORKSPACE_ID` - Workspace identifier
