# SwarmCode — Workspace Setup

One command:

```bash
npx swarmcode init <workspace-id> --redis redis://your-redis:6379
```

This creates `.mcp.json` + `.claude/settings.json` and registers with the bridge.

For real-time push, start the background listener in your Claude session:
```
Run in background: node /path/to/swarmcode/src/listener.js
```

Claude will auto-restart the listener after each message via `swarm_receive`.
