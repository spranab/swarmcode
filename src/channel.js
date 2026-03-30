#!/usr/bin/env node

/**
 * Agent Bridge Channel — real-time push notifications for Claude Code.
 *
 * This is a Claude Code channel (MCP server with claude/channel capability).
 * It subscribes to this workspace's Redis pub/sub channel and pushes incoming
 * messages directly into Claude's conversation as channel events.
 *
 * Claude can reply via the `bridge_send` tool, which publishes back to Redis.
 *
 * Config is read from .mcp.json (x-workspace-id header) or env vars.
 *
 * Usage:
 *   claude --channels server:agent-bridge-channel
 *   claude --dangerously-load-development-channels server:agent-bridge-channel
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Redis from "ioredis";
import { readFileSync } from "fs";
import { resolve } from "path";
import { v4 as uuidv4 } from "uuid";

// --- Config ---
const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const KEY_PREFIX = process.env.AGENT_BRIDGE_PREFIX || "agent-bridge:";
const WS_CHANNEL_PREFIX = "agent-bridge:ws:";

let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;
let BRIDGE_URL = process.env.AGENT_BRIDGE_URL;

// Read from .mcp.json if not set
if (!WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const server = mcpConfig?.mcpServers?.["agent-bridge"];
    if (server) {
      WORKSPACE_ID = server.headers?.["x-workspace-id"];
      if (server.url) {
        const parsed = new URL(server.url);
        BRIDGE_URL = BRIDGE_URL || `${parsed.protocol}//${parsed.host}`;
      }
    }
  } catch {}
}

if (!WORKSPACE_ID) {
  console.error("agent-bridge-channel: No workspace_id found. Set AGENT_BRIDGE_WORKSPACE_ID or configure .mcp.json");
  process.exit(1);
}

console.error(`agent-bridge-channel: workspace=${WORKSPACE_ID}, redis=${REDIS_URL}`);

// --- Redis connections ---
const redis = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX });
const publisher = new Redis(REDIS_URL); // separate connection for PUBLISH (can't publish on subscriber)
const subscriber = new Redis(REDIS_URL);

// --- MCP Server (Channel) ---
const mcp = new Server(
  { name: "agent-bridge-channel", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to Agent Bridge, a real-time communication layer between Claude Code instances.

Your workspace_id is "${WORKSPACE_ID}". Messages from other workspaces arrive as <channel source="agent-bridge-channel"> events.

When you receive a channel event:
1. Read the message content and metadata (from, type, priority)
2. Use the bridge_send tool to reply if needed
3. Use bridge_receive to mark messages as read
4. Use bridge_status to see all active workspaces

IMPORTANT: Always use bridge_send to communicate — other workspaces cannot see your text output.`,
  }
);

// --- Tools for Claude to use ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bridge_send",
      description: "Send a message to another workspace or broadcast to all. Use this to reply to channel events.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: 'Target workspace_id or "*" for broadcast' },
          content: { type: "string", description: "Message content" },
          type: {
            type: "string",
            enum: ["info", "request", "decision", "artifact", "question", "answer"],
            description: "Message type",
          },
          priority: {
            type: "string",
            enum: ["low", "normal", "high", "urgent"],
            description: "Priority (default: normal)",
          },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "bridge_receive",
      description: "Read and mark pending messages as read.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bridge_status",
      description: "See all registered workspaces and what they're working on.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "bridge_register",
      description: "Register/update this workspace's description. Call at conversation start.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "What you're currently working on" },
        },
        required: ["description"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "bridge_send": {
      const msg = {
        id: uuidv4(),
        from: WORKSPACE_ID,
        to: args.to,
        type: args.type || "info",
        content: args.content,
        metadata: {},
        priority: args.priority || "normal",
        timestamp: new Date().toISOString(),
        read: false,
      };

      // Store in inbox
      if (args.to === "*") {
        const workspaces = await redis.hgetall("workspaces");
        for (const wsId of Object.keys(workspaces)) {
          if (wsId !== WORKSPACE_ID) {
            await redis.lpush(`inbox:${wsId}`, JSON.stringify(msg));
            await redis.expire(`inbox:${wsId}`, 86400);
          }
        }
        await publisher.publish(`${WS_CHANNEL_PREFIX}broadcast`, JSON.stringify(msg));
      } else {
        await redis.lpush(`inbox:${args.to}`, JSON.stringify(msg));
        await redis.expire(`inbox:${args.to}`, 86400);
        await publisher.publish(`${WS_CHANNEL_PREFIX}${args.to}`, JSON.stringify(msg));
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "sent", to: args.to, message_id: msg.id }) }],
      };
    }

    case "bridge_receive": {
      const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
      const messages = raw.map((m) => JSON.parse(m)).reverse();
      await redis.del(`inbox:${WORKSPACE_ID}`);
      return {
        content: [{ type: "text", text: JSON.stringify({ messages, count: messages.length }) }],
      };
    }

    case "bridge_status": {
      const raw = await redis.hgetall("workspaces");
      const workspaces = Object.values(raw).map((v) => JSON.parse(v));
      for (const ws of workspaces) {
        ws.pending_messages = await redis.llen(`inbox:${ws.id}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ workspaces }) }],
      };
    }

    case "bridge_register": {
      const workspace = {
        id: WORKSPACE_ID,
        description: args.description || "",
        machine: (await import("os")).hostname(),
        registered_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      await redis.hset("workspaces", WORKSPACE_ID, JSON.stringify(workspace));
      await redis.expire("workspaces", 7200);

      const allWs = await redis.hgetall("workspaces");
      const others = Object.values(allWs)
        .map((v) => JSON.parse(v))
        .filter((w) => w.id !== WORKSPACE_ID);

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "registered", workspace, active_workspaces: others }) }],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

// --- Subscribe to workspace channel + broadcast ---
const channelDirect = `${WS_CHANNEL_PREFIX}${WORKSPACE_ID}`;
const channelBroadcast = `${WS_CHANNEL_PREFIX}broadcast`;

subscriber.subscribe(channelDirect, channelBroadcast, (err) => {
  if (err) {
    console.error("agent-bridge-channel: Redis subscribe error:", err.message);
  } else {
    console.error(`agent-bridge-channel: Subscribed to ${channelDirect} and ${channelBroadcast}`);
  }
});

subscriber.on("message", async (channel, raw) => {
  try {
    const msg = JSON.parse(raw);

    // Skip own broadcasts
    if (channel === channelBroadcast && msg.from === WORKSPACE_ID) return;

    console.error(`agent-bridge-channel: [${WORKSPACE_ID}] ← ${msg.from} (${msg.type})`);

    // Push to Claude as a channel notification
    const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.content,
        meta: {
          from: msg.from,
          type: msg.type || "info",
          priority: msg.priority || "normal",
          message_id: msg.id,
          timestamp: msg.timestamp,
        },
      },
    });
  } catch (err) {
    console.error("agent-bridge-channel: notification error:", err.message);
  }
});

// --- Connect ---
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("agent-bridge-channel: Connected and listening");

// --- Auto-register ---
const workspace = {
  id: WORKSPACE_ID,
  description: `Workspace ${WORKSPACE_ID}`,
  machine: (await import("os")).hostname(),
  registered_at: new Date().toISOString(),
  last_active: new Date().toISOString(),
};
await redis.hset("workspaces", WORKSPACE_ID, JSON.stringify(workspace));
console.error(`agent-bridge-channel: Auto-registered as ${WORKSPACE_ID}`);

process.on("SIGINT", async () => {
  await redis.quit();
  await publisher.quit();
  await subscriber.quit();
  process.exit(0);
});
