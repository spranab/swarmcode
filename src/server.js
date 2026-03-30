#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { connect, disconnect, getRedis } from "./redis.js";
import { toolDefinitions, handleTool, setupSubscriber, onMessage } from "./tools.js";

const useSSE = process.argv.includes("--sse");
const PORT = parseInt(process.env.AGENT_BRIDGE_PORT || "4100", 10);

async function main() {
  await connect();
  setupSubscriber();

  const server = new Server(
    { name: "agent-bridge", version: "1.0.0" },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true, listChanged: true },
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

  // --- Resources: expose each workspace's inbox as a live resource ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const r = getRedis();
    const raw = await r.hgetall("workspaces");
    const resources = Object.keys(raw).map((wsId) => ({
      uri: `agent-bridge://inbox/${wsId}`,
      name: `Inbox: ${wsId}`,
      description: `Pending messages for workspace "${wsId}". Subscribe for real-time updates.`,
      mimeType: "application/json",
    }));
    // Also expose a global status resource
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
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ workspaces }, null, 2),
          },
        ],
      };
    }

    if (uri === "agent-bridge://artifacts") {
      const raw = await r.hgetall("artifacts");
      const artifacts = Object.values(raw).map((v) => {
        const a = JSON.parse(v);
        return { name: a.name, type: a.type, description: a.description, shared_by: a.shared_by, shared_at: a.shared_at };
      });
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ artifacts }, null, 2),
          },
        ],
      };
    }

    const match = uri.match(/^agent-bridge:\/\/inbox\/(.+)$/);
    if (match) {
      const wsId = match[1];
      const raw = await r.lrange(`inbox:${wsId}`, 0, -1);
      const messages = raw.map((m) => JSON.parse(m)).reverse();
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ workspace: wsId, messages }, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
  });

  // --- Real-time: when Redis pub/sub fires, notify connected clients ---
  onMessage((msg) => {
    // Notify that the target workspace's inbox resource was updated
    try {
      if (msg.to === "*") {
        // Broadcast — notify all inbox resources + status
        server.sendResourceUpdated({ uri: "agent-bridge://status" });
        // We don't know all workspace IDs here easily, so trigger list changed
        server.sendResourceListChanged();
      } else {
        server.sendResourceUpdated({
          uri: `agent-bridge://inbox/${msg.to}`,
        });
      }
    } catch {
      // Client may not be subscribed, ignore
    }
  });

  if (useSSE) {
    const app = express();
    const transports = {};

    app.get("/sse", async (req, res) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      const sessionId = req.query.sessionId;
      const transport = transports[sessionId];
      if (transport) {
        await transport.handlePostMessage(req, res);
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
        connections: Object.keys(transports).length,
      });
    });

    app.listen(PORT, () => {
      console.error(
        `Agent Bridge MCP server (SSE) listening on http://0.0.0.0:${PORT}`
      );
      console.error(`  SSE endpoint:  http://localhost:${PORT}/sse`);
      console.error(`  Health check:  http://localhost:${PORT}/health`);
    });
  } else {
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
