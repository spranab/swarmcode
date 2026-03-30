#!/usr/bin/env node

// Route "init" subcommand to the init script
if (process.argv[2] === "init") {
  await import("./init.js");
  process.exit(0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { connect, disconnect, getRedis } from "./redis.js";
import { toolDefinitions, handleTool, setupSubscriber, onMessage } from "./tools.js";

const useSSE = process.argv.includes("--sse");
const PORT = parseInt(process.env.AGENT_BRIDGE_PORT || "4100", 10);

const GUIDE_PROMPT = `# Agent Bridge — Cross-Workspace Communication

You are connected to Agent Bridge, a real-time communication layer between Claude Code instances across machines and workspaces.

## Your Identity
Your workspace_id is provided by the user's hook or must be set via register(). Check the conversation context for a line like "AGENT BRIDGE: Your workspace_id is ...". Use that ID for all tool calls.

## Mandatory Workflow

1. **FIRST THING every conversation**: Call \`register\` with your workspace_id, a description of what you're working on, and the machine name. Then call \`receive\` to check for pending messages.

2. **Before starting any task**: Call \`receive\` — another agent may have sent critical context.

3. **After completing significant work**: Call \`send\` to notify other workspaces. Include specifics: API endpoints, schemas, file paths, decisions made.

4. **When you change a shared interface or schema**: Call \`share_artifact\` so other workspaces can consume it.

5. **When switching tasks**: Call \`update_status\` with what you're now working on.

## Tools Available
- \`register(workspace_id, description, machine)\` — announce yourself
- \`send(from, to, content, type, priority)\` — message a workspace or broadcast (to="*")
- \`receive(workspace_id)\` — read pending messages
- \`status()\` — see all workspaces and what they're doing
- \`update_status(workspace_id, description, progress)\` — update your current task
- \`share_artifact(from, name, type, content, description)\` — share code/schemas/configs
- \`get_artifact(name)\` — retrieve a shared artifact
- \`list_artifacts()\` — list all shared artifacts

## Message Types
Use \`type\` when sending: "info", "request", "question", "answer", "decision", "artifact"

## Priority
Use \`priority\`: "low", "normal", "high", "urgent"

## Example
\`\`\`
register("my-workspace", "Building REST API for users", "desktop")
receive("my-workspace")
// ... do work ...
send({from: "my-workspace", to: "*", type: "info", content: "POST /api/users is live"})
share_artifact({from: "my-workspace", name: "user-schema", type: "schema", content: "..."})
\`\`\``;

/**
 * Creates a new MCP Server instance with all handlers registered.
 * Each SSE connection gets its own instance (MCP SDK requirement).
 */
function createServer() {
  const server = new Server(
    { name: "agent-bridge", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        prompts: {},
      },
    }
  );

  // --- Tools ---
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleTool(name, args || {});
  });

  // --- Prompts ---
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "agent-bridge-guide",
        description:
          "How to use Agent Bridge for cross-workspace communication",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === "agent-bridge-guide") {
      return {
        description: "Agent Bridge usage guide",
        messages: [
          {
            role: "user",
            content: { type: "text", text: GUIDE_PROMPT },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  // --- Resources ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const r = getRedis();
    const raw = await r.hgetall("workspaces");
    const resources = Object.keys(raw).map((wsId) => ({
      uri: `agent-bridge://inbox/${wsId}`,
      name: `Inbox: ${wsId}`,
      description: `Pending messages for workspace "${wsId}". Subscribe for real-time updates.`,
      mimeType: "application/json",
    }));
    resources.push({
      uri: "agent-bridge://status",
      name: "Bridge Status",
      description: "All registered workspaces and their current status.",
      mimeType: "application/json",
    });
    resources.push({
      uri: "agent-bridge://artifacts",
      name: "Shared Artifacts",
      description: "All shared artifacts across workspaces.",
      mimeType: "application/json",
    });
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const r = getRedis();

    if (uri === "agent-bridge://status") {
      const raw = await r.hgetall("workspaces");
      const workspaces = Object.values(raw).map((v) => JSON.parse(v));
      for (const ws of workspaces) {
        ws.pending_messages = await r.llen(`inbox:${ws.id}`);
      }
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ workspaces }, null, 2) }],
      };
    }

    if (uri === "agent-bridge://artifacts") {
      const raw = await r.hgetall("artifacts");
      const artifacts = Object.values(raw).map((v) => {
        const a = JSON.parse(v);
        return { name: a.name, type: a.type, description: a.description, shared_by: a.shared_by, shared_at: a.shared_at };
      });
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ artifacts }, null, 2) }],
      };
    }

    const match = uri.match(/^agent-bridge:\/\/inbox\/(.+)$/);
    if (match) {
      const wsId = match[1];
      const raw = await r.lrange(`inbox:${wsId}`, 0, -1);
      const messages = raw.map((m) => JSON.parse(m)).reverse();
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ workspace: wsId, messages }, null, 2) }],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}

async function main() {
  await connect();
  setupSubscriber();

  if (useSSE) {
    const app = express();
    const sessions = {}; // sessionId -> { transport, server }

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      const server = createServer();

      sessions[transport.sessionId] = { transport, server };

      // Push resource updates to this client on new messages
      const unsubscribe = onMessage((msg) => {
        try {
          if (msg.to === "*") {
            server.sendResourceUpdated({ uri: "agent-bridge://status" });
            server.sendResourceListChanged();
          } else {
            server.sendResourceUpdated({ uri: `agent-bridge://inbox/${msg.to}` });
          }
        } catch {}
      });

      res.on("close", () => {
        unsubscribe();
        delete sessions[transport.sessionId];
      });

      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId;
      const session = sessions[sessionId];
      if (session) {
        await session.transport.handlePostMessage(req, res);
      } else {
        res.status(404).json({ error: "Session not found" });
      }
    });

    // REST API for hooks and external integrations
    app.get("/api/inbox/:workspaceId", async (_req, res) => {
      const r = getRedis();
      const raw = await r.lrange(`inbox:${_req.params.workspaceId}`, 0, -1);
      const messages = raw.map((m) => JSON.parse(m)).reverse();
      res.json({ workspace: _req.params.workspaceId, messages });
    });

    app.get("/api/status", async (_req, res) => {
      const r = getRedis();
      const raw = await r.hgetall("workspaces");
      const workspaces = Object.values(raw).map((v) => JSON.parse(v));
      for (const ws of workspaces) {
        ws.pending_messages = await r.llen(`inbox:${ws.id}`);
      }
      res.json({ workspaces });
    });

    app.get("/health", (_req, res) => {
      res.json({
        status: "ok",
        mode: "sse",
        connections: Object.keys(sessions).length,
      });
    });

    app.listen(PORT, () => {
      console.error(`Agent Bridge MCP server (SSE) listening on http://0.0.0.0:${PORT}`);
      console.error(`  SSE endpoint:  http://localhost:${PORT}/sse`);
      console.error(`  Health check:  http://localhost:${PORT}/health`);
    });
  } else {
    // Stdio mode: single client
    const server = createServer();

    onMessage((msg) => {
      try {
        if (msg.to === "*") {
          server.sendResourceUpdated({ uri: "agent-bridge://status" });
          server.sendResourceListChanged();
        } else {
          server.sendResourceUpdated({ uri: `agent-bridge://inbox/${msg.to}` });
        }
      } catch {}
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Agent Bridge MCP server (stdio) connected");
  }

  process.on("SIGINT", async () => {
    await disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
