# Installing swarmcode-mcp

## Requirements

SwarmCode needs a reachable Redis instance and a one-time workspace init
**before** the MCP server is useful — adding it to an MCP client config
alone is not a complete install.

1. A Redis instance (any machine, including a local Docker container):
   ```bash
   docker run -d --name redis -p 6379:6379 redis:alpine
   ```
2. Initialize the workspace once (creates the config the server reads):
   ```bash
   npm install -g swarmcode-mcp
   swarmcode-mcp init my-workspace --redis redis://your-redis-host:6379
   ```
3. Add the server to the MCP client, then restart the client.

Repeat step 2/3 (same Redis, different workspace name if needed) on every
other machine that should join the same channel.

## Required environment variables

| Variable | Description |
|----------|-------------|
| `SWARMCODE_REDIS_URL` | Redis connection URL (secret — treat like a credential if the Redis instance isn't purely local) |
| `SWARMCODE_WORKSPACE_ID` | Workspace identifier this instance joins |

## Known install footgun

If `SWARMCODE_REDIS_URL` points at a host that's unreachable at startup,
the server currently hangs during its MCP handshake instead of failing
fast with a clear error (it blocks on a Redis subscribe before the
transport connects). If the client reports a timeout adding the server,
verify Redis is actually reachable from wherever the server process runs
before assuming the client config is wrong.

## Verifying the install

Call `swarm_status` — a response listing registered workspaces confirms
Redis connectivity and a working install.
