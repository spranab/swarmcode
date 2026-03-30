#!/usr/bin/env node

/**
 * Inbox checker hook for Claude Code.
 * Reads config from .mcp.json and checks for pending messages.
 *
 * Supports two sources:
 *   1. HTTP API (from agent-bridge SSE server URL in .mcp.json)
 *   2. Direct Redis (from agent-bridge-channel env in .mcp.json)
 *
 * Two modes based on AGENT_BRIDGE_HOOK_MODE env var:
 *   "stop"   → outputs JSON {decision:"block", reason:"..."} to force Claude to continue
 *   default  → outputs text directives for UserPromptSubmit context injection
 */

import { readFileSync } from "fs";
import { resolve } from "path";

let BASE_URL = process.env.AGENT_BRIDGE_URL;
let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;
let REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL;
const HOOK_MODE = process.env.AGENT_BRIDGE_HOOK_MODE || "prompt";

// Try to read from .mcp.json
if (!BASE_URL || !WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));

    // Try SSE server first
    const sseServer = mcpConfig?.mcpServers?.["agent-bridge"];
    if (sseServer?.url) {
      WORKSPACE_ID = WORKSPACE_ID || sseServer.headers?.["x-workspace-id"];
      const parsed = new URL(sseServer.url);
      BASE_URL = BASE_URL || `${parsed.protocol}//${parsed.host}`;
    }

    // Try channel config
    const channel = mcpConfig?.mcpServers?.["agent-bridge-channel"];
    if (channel?.env) {
      WORKSPACE_ID = WORKSPACE_ID || channel.env.AGENT_BRIDGE_WORKSPACE_ID;
      REDIS_URL = REDIS_URL || channel.env.AGENT_BRIDGE_REDIS_URL;
    }
  } catch {}
}

if (!WORKSPACE_ID) {
  process.exit(0);
}

// Fetch messages — try HTTP first, fall back to direct Redis
let messages = [];

if (BASE_URL) {
  try {
    const res = await fetch(`${BASE_URL}/api/inbox/${WORKSPACE_ID}`);
    if (res.ok) {
      const data = await res.json();
      messages = data.messages || [];
    }
  } catch {}
} else if (REDIS_URL) {
  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { keyPrefix: "agent-bridge:" });
    const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
    messages = raw.map((m) => JSON.parse(m)).reverse();
    await redis.quit();
  } catch {}
}

if (messages.length === 0) {
  if (HOOK_MODE === "prompt") {
    console.log(`[AGENT BRIDGE] You are workspace "${WORKSPACE_ID}". Use this ID for all agent-bridge tool calls.`);
  }
  process.exit(0);
}

// Build message summary and actions
const lines = [];
const actions = [];

lines.push(`You are workspace "${WORKSPACE_ID}". You have ${messages.length} unread message(s):\n`);

for (const msg of messages) {
  const time = new Date(msg.timestamp).toLocaleTimeString();
  const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
  lines.push(`From "${msg.from}"${prio} (${msg.type}) at ${time}:`);
  lines.push(msg.content);
  if (msg.metadata && Object.keys(msg.metadata).length > 0) {
    lines.push(`Metadata: ${JSON.stringify(msg.metadata)}`);
  }
  lines.push("");

  switch (msg.type) {
    case "question":
      actions.push(`REPLY to "${msg.from}": Answer using bridge_send(to: "${msg.from}", type: "answer", content: "your answer")`);
      break;
    case "request":
      actions.push(`ACT on request from "${msg.from}", then send confirmation back`);
      break;
    case "artifact":
      if (msg.metadata?.artifact_name) {
        actions.push(`RETRIEVE artifact "${msg.metadata.artifact_name}"`);
      }
      break;
    case "info":
    case "decision":
      actions.push(`ACKNOWLEDGE to "${msg.from}" using bridge_send(to: "${msg.from}", type: "info", content: "Acknowledged: ...")`);
      break;
    case "answer":
      actions.push(`APPLY the answer from "${msg.from}" to your current work`);
      break;
  }
}

lines.push("REQUIRED ACTIONS:");
lines.push(`1. Call bridge_receive() to mark messages as read`);
for (let i = 0; i < actions.length; i++) {
  lines.push(`${i + 2}. ${actions[i]}`);
}

const reason = lines.join("\n");

if (HOOK_MODE === "stop") {
  console.log(JSON.stringify({ decision: "block", reason }));
} else {
  console.log(`[AGENT BRIDGE] ${reason}`);
}
