#!/usr/bin/env node

/**
 * Fast inbox checker hook for Claude Code.
 *
 * Priority order:
 *   1. Queue file (.agent-bridge-inbox) — written by persistent listener, instant read
 *   2. Direct Redis — fallback if listener isn't running
 *
 * Clears the queue file after reading so messages aren't shown twice.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";

let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;
let REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL;

// Read from .mcp.json if not set
if (!WORKSPACE_ID || !REDIS_URL) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const bridge = mcpConfig?.mcpServers?.["agent-bridge"];
    if (bridge?.env) {
      WORKSPACE_ID = WORKSPACE_ID || bridge.env.AGENT_BRIDGE_WORKSPACE_ID;
      REDIS_URL = REDIS_URL || bridge.env.AGENT_BRIDGE_REDIS_URL;
    }
  } catch {}
}

if (!WORKSPACE_ID) {
  process.exit(0);
}

const queueDir = process.env.AGENT_BRIDGE_QUEUE_DIR || process.cwd();
const QUEUE_FILE = resolve(queueDir, ".agent-bridge-inbox");

// 1. Try queue file first (instant — written by persistent listener)
let messages = [];
if (existsSync(QUEUE_FILE)) {
  try {
    messages = JSON.parse(readFileSync(QUEUE_FILE, "utf-8"));
    // Clear the queue after reading
    unlinkSync(QUEUE_FILE);
  } catch {}
}

// 2. Fall back to Redis if no queue file (listener not running)
if (messages.length === 0 && REDIS_URL) {
  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { keyPrefix: "agent-bridge:" });
    const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
    messages = raw.map((m) => JSON.parse(m)).reverse();
    // Don't clear Redis inbox here — bridge_receive handles that
    await redis.quit();
  } catch {}
}

if (messages.length === 0) {
  console.log(`[AGENT BRIDGE] You are workspace "${WORKSPACE_ID}".`);
  process.exit(0);
}

// Build directives
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

console.log(`[AGENT BRIDGE] ${lines.join("\n")}`);
