#!/usr/bin/env node

/**
 * SwarmCode fast inbox checker hook for Claude Code.
 * Reads from Redis, outputs actionable directives.
 */

import { readFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";

let WORKSPACE_ID = process.env.SWARMCODE_WORKSPACE_ID || process.env.AGENT_BRIDGE_WORKSPACE_ID;
let REDIS_URL = process.env.SWARMCODE_REDIS_URL || process.env.AGENT_BRIDGE_REDIS_URL;

if (!WORKSPACE_ID || !REDIS_URL) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const sc = mcpConfig?.mcpServers?.["swarmcode"];
    if (sc?.env) {
      WORKSPACE_ID = WORKSPACE_ID || sc.env.SWARMCODE_WORKSPACE_ID;
      REDIS_URL = REDIS_URL || sc.env.SWARMCODE_REDIS_URL;
    }
    if (!WORKSPACE_ID) {
      const ab = mcpConfig?.mcpServers?.["agent-bridge"];
      if (ab?.env) {
        WORKSPACE_ID = WORKSPACE_ID || ab.env.AGENT_BRIDGE_WORKSPACE_ID;
        REDIS_URL = REDIS_URL || ab.env.AGENT_BRIDGE_REDIS_URL;
      }
    }
  } catch {}
}

if (!WORKSPACE_ID) {
  process.exit(0);
}

let messages = [];

// Check Redis with timeout
if (REDIS_URL) {
  try {
    const { default: Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, {
      keyPrefix: "swarmcode:",
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // don't retry — fail fast
    });
    const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
    messages = raw.map((m) => JSON.parse(m)).reverse();
    await redis.quit();
  } catch {
    // Redis unavailable — silently skip
    process.exit(0);
  }
}

if (messages.length === 0) {
  console.log(`[SWARMCODE] You are workspace "${WORKSPACE_ID}".`);
  process.exit(0);
}

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
      actions.push(`REPLY to "${msg.from}": Answer using swarm_send(to: "${msg.from}", type: "answer", content: "your answer")`);
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
      actions.push(`ACKNOWLEDGE to "${msg.from}" using swarm_send(to: "${msg.from}", type: "info", content: "Acknowledged: ...")`);
      break;
    case "answer":
      actions.push(`APPLY the answer from "${msg.from}" to your current work`);
      break;
  }
}

lines.push("REQUIRED ACTIONS:");
lines.push(`1. Call swarm_receive() to mark messages as read`);
for (let i = 0; i < actions.length; i++) {
  lines.push(`${i + 2}. ${actions[i]}`);
}

console.log(`[SWARMCODE] ${lines.join("\n")}`);
