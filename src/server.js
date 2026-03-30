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
import { connect, disconnect, getRedis, createSubscriber, WS_CHANNEL_PREFIX } from "./redis.js";
import { toolDefinitions, handleTool } from "./tools.js";

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
Use \`priority\`: "low", "normal", "high", "urgent"`;

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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleTool(name, args || {});
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "agent-bridge-guide",
        description: "How to use Agent Bridge for cross-workspace communication",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    if (request.params.name === "agent-bridge-guide") {
      return {
        description: "Agent Bridge usage guide",
        messages: [
          { role: "user", content: { type: "text", text: GUIDE_PROMPT } },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${request.params.name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const r = getRedis();
    const raw = await r.hgetall("workspaces");
    const resources = Object.keys(raw).map((wsId) => ({
      uri: `agent-bridge://inbox/${wsId}`,
      name: `Inbox: ${wsId}`,
      description: `Pending messages for workspace "${wsId}".`,
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

  if (useSSE) {
    const app = express();
    // sessionId -> { transport, server, wsId, subscriber }
    const sessions = {};

    /**
     * Subscribe a session to its workspace channel + broadcast channel.
     * Called when the client registers via the register tool.
     */
    function subscribeSession(sessionId, wsId) {
      const session = sessions[sessionId];
      if (!session || session.wsId === wsId) return; // already subscribed

      // Clean up old subscription if workspace changed
      if (session.subscriber) {
        session.subscriber.quit().catch(() => {});
      }

      session.wsId = wsId;
      const sub = createSubscriber();
      session.subscriber = sub;

      sub.connect().then(() => {
        // Subscribe to direct channel + broadcast
        sub.subscribe(
          `${WS_CHANNEL_PREFIX}${wsId}`,
          `${WS_CHANNEL_PREFIX}broadcast`
        );

        sub.on("message", async (channel, raw) => {
          try {
            const msg = JSON.parse(raw);

            // Skip own broadcasts
            if (channel === `${WS_CHANNEL_PREFIX}broadcast` && msg.from === wsId) return;

            console.error(`[${wsId}] Message from ${msg.from} via ${channel.replace(WS_CHANNEL_PREFIX, "")}`);

            // Try MCP sampling to push message to Claude
            try {
              await session.server.createMessage({
                messages: [
                  {
                    role: "user",
                    content: {
                      type: "text",
                      text: `[AGENT BRIDGE] New message from "${msg.from}" (${msg.type}${msg.priority === "high" || msg.priority === "urgent" ? `, ${msg.priority.toUpperCase()}` : ""}): ${msg.content}\n\nYou MUST: 1) call receive("${wsId}") to mark as read, 2) respond using send(from: "${wsId}", to: "${msg.from}", ...)`,
                    },
                  },
                ],
                maxTokens: 1024,
              });
            } catch (err) {
              // Sampling not supported — fall back to resource notification
              console.error(`[${wsId}] Sampling failed: ${err.message}`);
              try {
                session.server.sendResourceUpdated({ uri: `agent-bridge://inbox/${wsId}` });
              } catch {}
            }
          } catch {}
        });
      });
    }

    // Intercept register tool calls to set up channel subscriptions
    const originalCreateServer = createServer;
    function createServerWithSubscription(sessionId) {
      const server = originalCreateServer();

      // Wrap the CallToolRequest handler to intercept register calls
      const origHandler = server._requestHandlers?.get("tools/call");

      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await handleTool(name, args || {});

        // If this was a register call, subscribe this session to the workspace channel
        if (name === "register" && args?.workspace_id) {
          subscribeSession(sessionId, args.workspace_id);
        }

        return result;
      });

      return server;
    }

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      const server = createServerWithSubscription(transport.sessionId);

      sessions[transport.sessionId] = { transport, server, wsId: null, subscriber: null };

      res.on("close", () => {
        const session = sessions[transport.sessionId];
        if (session?.subscriber) {
          session.subscriber.quit().catch(() => {});
        }
        delete sessions[transport.sessionId];
        console.error(`[session] Disconnected: ${transport.sessionId}`);
      });

      await server.connect(transport);
      console.error(`[session] Connected: ${transport.sessionId}`);
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

    // REST API
    app.use(express.json());

    app.post("/api/register", async (req, res) => {
      const result = await handleTool("register", req.body || {});
      res.json(JSON.parse(result.content[0].text));
    });

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
        subscribed: Object.values(sessions).filter((s) => s.wsId).map((s) => s.wsId),
      });
    });

    app.listen(PORT, () => {
      console.error(`Agent Bridge MCP server (SSE) listening on http://0.0.0.0:${PORT}`);
      console.error(`  SSE endpoint:  http://localhost:${PORT}/sse`);
      console.error(`  Health check:  http://localhost:${PORT}/health`);
      console.error(`  Channels:      ${WS_CHANNEL_PREFIX}<workspace-id> (per-workspace)`);
      console.error(`                 ${WS_CHANNEL_PREFIX}broadcast (gossip/all)`);
    });
  } else {
    // Stdio mode — single client, subscribe after register
    const server = createServer();

    // For stdio, wrap register to subscribe
    let stdioPubSub = null;
    const origCallHandler = server._requestHandlers?.get("tools/call");

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await handleTool(name, args || {});

      if (name === "register" && args?.workspace_id) {
        // Subscribe to this workspace's channel
        if (stdioPubSub) stdioPubSub.quit().catch(() => {});
        stdioPubSub = createSubscriber();
        await stdioPubSub.connect();
        await stdioPubSub.subscribe(
          `${WS_CHANNEL_PREFIX}${args.workspace_id}`,
          `${WS_CHANNEL_PREFIX}broadcast`
        );
        stdioPubSub.on("message", async (channel, raw) => {
          try {
            const msg = JSON.parse(raw);
            if (channel === `${WS_CHANNEL_PREFIX}broadcast` && msg.from === args.workspace_id) return;
            try {
              await server.createMessage({
                messages: [
                  {
                    role: "user",
                    content: {
                      type: "text",
                      text: `[AGENT BRIDGE] New message from "${msg.from}" (${msg.type}): ${msg.content}\n\nYou MUST: 1) call receive("${args.workspace_id}") to mark as read, 2) respond using send()`,
                    },
                  },
                ],
                maxTokens: 1024,
              });
            } catch {
              try {
                server.sendResourceUpdated({ uri: `agent-bridge://inbox/${args.workspace_id}` });
              } catch {}
            }
          } catch {}
        });
        console.error(`Subscribed to channel: ${WS_CHANNEL_PREFIX}${args.workspace_id}`);
      }

      return result;
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
