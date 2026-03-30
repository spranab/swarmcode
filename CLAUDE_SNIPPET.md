# Agent Bridge — Workspace Setup

Two files per workspace. Replace `YOUR_WORKSPACE_ID`.

## 1. `.mcp.json`

```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "sse",
      "url": "https://agent-bridge.mcp.mycluster.cyou/sse?workspace_id=YOUR_WORKSPACE_ID"
    }
  }
}
```

## 2. `.claude/settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node c:\\Users\\sync\\codes\\agent-bridge\\src\\check-inbox-http.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

The hook reads `workspace_id` from `.mcp.json` — no duplication needed.
