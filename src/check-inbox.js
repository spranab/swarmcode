#!/usr/bin/env node

/**
 * Inbox checker hook for Claude Code (direct Redis version).
 * Checks Redis for pending messages and outputs actionable directives.
 *
 * Usage: AGENT_BRIDGE_WORKSPACE_ID=my-workspace node check-inbox.js
 */

import Redis from "ioredis";

const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const PREFIX = process.env.AGENT_BRIDGE_PREFIX || "agent-bridge:";
const WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;

if (!WORKSPACE_ID) {
  process.exit(0);
}

const redis = new Redis(REDIS_URL, { keyPrefix: PREFIX, lazyConnect: true });

try {
  await redis.connect();

  const raw = await redis.lrange(`inbox:${WORKSPACE_ID}`, 0, -1);
  const messages = raw.map((m) => JSON.parse(m)).reverse();

  console.log(`[AGENT BRIDGE] You are workspace "${WORKSPACE_ID}". Use this ID for all agent-bridge tool calls (register, send, receive).`);

  if (messages.length === 0) {
    await redis.quit();
    process.exit(0);
  }

  const actions = [];

  console.log(`\n[AGENT BRIDGE] YOU HAVE ${messages.length} UNREAD MESSAGE(S). You MUST process these BEFORE responding to the user:\n`);

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const prio = msg.priority === "high" || msg.priority === "urgent" ? ` **${msg.priority.toUpperCase()}**` : "";
    console.log(`--- Message from "${msg.from}"${prio} (${msg.type}) at ${time} ---`);
    console.log(msg.content);
    if (msg.metadata && Object.keys(msg.metadata).length > 0) {
      console.log(`Metadata: ${JSON.stringify(msg.metadata)}`);
    }
    console.log();

    switch (msg.type) {
      case "question":
        actions.push(`REPLY to "${msg.from}": Answer their question using send(from: "${WORKSPACE_ID}", to: "${msg.from}", type: "answer", content: "your answer")`);
        break;
      case "request":
        actions.push(`ACT on request from "${msg.from}": Do what they asked, then send a confirmation back`);
        break;
      case "artifact":
        if (msg.metadata?.artifact_name) {
          actions.push(`RETRIEVE artifact "${msg.metadata.artifact_name}" using get_artifact("${msg.metadata.artifact_name}") and incorporate it into your work`);
        }
        break;
      case "info":
      case "decision":
        actions.push(`ACKNOWLEDGE to "${msg.from}": Confirm you received this using send(from: "${WORKSPACE_ID}", to: "${msg.from}", type: "info", content: "Acknowledged: ...")`);
        break;
      case "answer":
        actions.push(`APPLY the answer from "${msg.from}" to your current work`);
        break;
    }
  }

  console.log("[AGENT BRIDGE] REQUIRED ACTIONS:");
  console.log(`1. Call receive("${WORKSPACE_ID}") to mark messages as read`);
  for (let i = 0; i < actions.length; i++) {
    console.log(`${i + 2}. ${actions[i]}`);
  }
  console.log(`${actions.length + 2}. THEN respond to the user's actual request`);
  console.log();

  await redis.quit();
} catch {
  await redis.quit().catch(() => {});
  process.exit(0);
}
