#!/usr/bin/env node

/**
 * Agent Bridge — MCP server for real-time cross-workspace communication.
 *
 * Uses McpServer with experimental task support for a persistent bridge_listen
 * tool that polls Redis pub/sub and completes when a message arrives.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental";
import Redis from "ioredis";
import { readFileSync } from "fs";
import { resolve } from "path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

// --- Config ---
const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const KEY_PREFIX = process.env.AGENT_BRIDGE_PREFIX || "agent-bridge:";
const WS_CHANNEL_PREFIX = "agent-bridge:ws:";

let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;

if (!WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const bridge = mcpConfig?.mcpServers?.["agent-bridge"];
    if (bridge?.env) WORKSPACE_ID = bridge.env.AGENT_BRIDGE_WORKSPACE_ID;
  } catch {}
}

if (!WORKSPACE_ID) {
  console.error("agent-bridge: No workspace_id found. Set AGENT_BRIDGE_WORKSPACE_ID or configure .mcp.json");
  process.exit(1);
}

console.error(`agent-bridge: workspace=${WORKSPACE_ID}, redis=${REDIS_URL}`);

// --- Redis ---
const redis = new Redis(REDIS_URL, { keyPrefix: KEY_PREFIX });
const publisher = new Redis(REDIS_URL);
const subscriber = new Redis(REDIS_URL);

// --- In-memory message buffer for task-based listening ---
let pendingMessage = null;
let messageResolve = null;

function waitForMessage() {
  if (pendingMessage) {
    const msg = pendingMessage;
    pendingMessage = null;
    return Promise.resolve(msg);
  }
  return new Promise((resolve) => {
    messageResolve = resolve;
  });
}

// Subscribe to workspace channels
await subscriber.subscribe(
  `${WS_CHANNEL_PREFIX}${WORKSPACE_ID}`,
  `${WS_CHANNEL_PREFIX}broadcast`
);

subscriber.on("message", (_ch, raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.from === WORKSPACE_ID) return;

    console.error(`agent-bridge: [${WORKSPACE_ID}] ← ${msg.from} (${msg.type})`);

    if (messageResolve) {
      const resolve = messageResolve;
      messageResolve = null;
      resolve(msg);
    } else {
      pendingMessage = msg;
    }
  } catch {}
});

console.error(`agent-bridge: Subscribed to ${WS_CHANNEL_PREFIX}${WORKSPACE_ID}`);

// --- MCP Server with task store ---
const taskStore = new InMemoryTaskStore();

const mcp = new McpServer(
  { name: "agent-bridge", version: "1.0.0" },
  {
    taskStore,
    capabilities: {
      experimental: { "claude/channel": {} },
    },
    instructions: `You are connected to Agent Bridge, a real-time communication layer between Claude Code instances.

Your workspace_id is "${WORKSPACE_ID}".

## CRITICAL: Do BOTH of these at the start of every conversation:

### 1. Start the background listener (real-time push):
  Bash(run_in_background=true, timeout=600000): AGENT_BRIDGE_REDIS_URL=${REDIS_URL} AGENT_BRIDGE_WORKSPACE_ID=${WORKSPACE_ID} npx -y mcp-agent-bridge listen

### 2. Set up a cron to check every 5 minutes (backup polling):
  CronCreate(cron="*/5 * * * *", prompt="Check agent bridge inbox. Call bridge_receive from agent-bridge. If there are messages, process them — reply to questions with bridge_send, acknowledge info, act on requests.")

The listener gives real-time push via task-notifications.
The cron is a backup in case the listener times out or misses a message.

When you see a task-notification from the listener:
1. Read the task output file to see the message
2. Call bridge_receive() to mark messages as read
3. Reply with bridge_send(to: "sender", type: "answer", content: "...")
4. Start a new listener (same Bash command as above)

## Tools
- bridge_send — send a message to another workspace (or to="*" for broadcast)
- bridge_receive — read and mark all pending messages as read
- bridge_status — see all active workspaces
- bridge_register — register/update your workspace description

IMPORTANT: Always use bridge_send to communicate — other workspaces cannot see your text output.`,
  }
);

// --- Regular tools ---
mcp.tool(
  "bridge_send",
  "Send a message to another workspace or broadcast to all.",
  {
    to: z.string().describe('Target workspace_id or "*" for broadcast'),
    content: z.string().describe("Message content"),
    type: z.enum(["info", "request", "decision", "artifact", "question", "answer"]).optional().describe("Message type"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Priority"),
  },
  async (args) => {
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

    // Store in global log (for dashboard)
    await redis.lpush("messages:log", JSON.stringify(msg));
    await redis.ltrim("messages:log", 0, 499);

    return { content: [{ type: "text", text: JSON.stringify({ status: "sent", to: args.to, message_id: msg.id }) }] };
  }
);

mcp.tool(
  "bridge_receive",
  "Read and mark all pending messages as read.",
  {},
  async () => {
    const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
    const messages = raw.map((m) => JSON.parse(m)).reverse();
    await redis.del(`inbox:${WORKSPACE_ID}`);
    return { content: [{ type: "text", text: JSON.stringify({ messages, count: messages.length }) }] };
  }
);

mcp.tool(
  "bridge_status",
  "See all registered workspaces and what they're working on.",
  {},
  async () => {
    const raw = await redis.hgetall("workspaces");
    const workspaces = Object.values(raw).map((v) => JSON.parse(v));
    for (const ws of workspaces) {
      ws.pending_messages = await redis.llen(`inbox:${ws.id}`);
    }
    return { content: [{ type: "text", text: JSON.stringify({ workspaces }) }] };
  }
);

mcp.tool(
  "bridge_register",
  "Register/update this workspace's description. Call at conversation start.",
  {
    description: z.string().describe("What you're currently working on"),
  },
  async (args) => {
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
      content: [
        { type: "text", text: JSON.stringify({ status: "registered", workspace, active_workspaces: others }) },
        { type: "text", text: "Now call bridge_listen to start receiving real-time messages." },
      ],
    };
  }
);

// --- Task-based bridge_listen tool ---
mcp.experimental.tasks.registerToolTask(
  "bridge_listen",
  {
    description: "Wait for the next message from another workspace. This is a long-running task that completes when a message arrives. Call this at the start of every conversation and after processing each message.",
    execution: { taskSupport: "optional" },
  },
  {
    createTask: async (extra) => {
      const task = await extra.taskStore.createTask({
        ttl: 600000, // 10 min
        pollInterval: 1000, // poll every 1 second
      });

      // Wait for message in background
      waitForMessage().then(async (msg) => {
        const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
        const result = {
          content: [
            {
              type: "text",
              text: `New message from "${msg.from}"${prio} (${msg.type}): ${msg.content}\n\nYou MUST:\n1. Call bridge_receive() to mark as read\n2. Reply with bridge_send(to: "${msg.from}", ...)\n3. Call bridge_listen again to wait for the next message`,
            },
          ],
        };
        await extra.taskStore.storeTaskResult(task.taskId, "completed", result);
      });

      return { task };
    },

    getTask: async (_args, extra) => {
      const task = await extra.taskStore.getTask(extra.taskId);
      return task || { taskId: extra.taskId, status: "working", createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString() };
    },

    getTaskResult: async (_args, extra) => {
      return await extra.taskStore.getTaskResult(extra.taskId);
    },
  }
);

// --- Auto-register ---
const workspace = {
  id: WORKSPACE_ID,
  description: `Workspace ${WORKSPACE_ID}`,
  machine: (await import("os")).hostname(),
  registered_at: new Date().toISOString(),
  last_active: new Date().toISOString(),
};
await redis.hset("workspaces", WORKSPACE_ID, JSON.stringify(workspace));
console.error(`agent-bridge: Auto-registered as ${WORKSPACE_ID}`);

// --- Connect ---
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error("agent-bridge: Connected and listening");

process.on("SIGINT", async () => {
  await redis.quit();
  await publisher.quit();
  await subscriber.quit();
  process.exit(0);
});
