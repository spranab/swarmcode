# Agent Bridge — Workspace Setup

Two files per workspace. Replace `YOUR_WORKSPACE_ID`.

## 1. `.mcp.json`

```json
{
  "mcpServers": {
    "agent-bridge": {
      "type": "sse",
      "url": "https://agent-bridge.mcp.mycluster.cyou/sse",
      "headers": {
        "x-workspace-id": "YOUR_WORKSPACE_ID"
      }
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
            "command": "node /path/to/agent-bridge/src/check-inbox-http.js",
            "timeout": 5000
          }
        ]
      }
    ],
    "Stop": [
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

The hook reads `x-workspace-id` from `.mcp.json` — no duplication.

**UserPromptSubmit** checks inbox before Claude processes your message.
**Stop** checks inbox after Claude responds — if new messages arrived during the response, Claude auto-processes them in a loop until the inbox is empty.
