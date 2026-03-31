#!/usr/bin/env node

/**
 * One-shot Redis listener for Agent Bridge.
 *
 * Subscribes to workspace channel, waits for ONE message, outputs it, exits.
 * The exit triggers a task-notification in Claude Code.
 * Claude processes the message, then starts a new listener.
 *
 * This creates a real-time event loop:
 *   listener → message → exit → task-notification → process → new listener → repeat
 */

import Redis from "ioredis";
import { readFileSync } from "fs";
import { resolve } from "path";

const REDIS_URL = process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const WS_CHANNEL_PREFIX = "agent-bridge:ws:";
let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;

// Read from .mcp.json if not set
if (!WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const bridge = mcpConfig?.mcpServers?.["agent-bridge"];
    if (bridge?.env) WORKSPACE_ID = bridge.env.AGENT_BRIDGE_WORKSPACE_ID;
  } catch {}
}

if (!WORKSPACE_ID) {
  console.error("No workspace_id found");
  process.exit(1);
}

const sub = new Redis(REDIS_URL);

await sub.subscribe(
  `${WS_CHANNEL_PREFIX}${WORKSPACE_ID}`,
  `${WS_CHANNEL_PREFIX}broadcast`
);

sub.on("message", async (ch, raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.from === WORKSPACE_ID) return;

    const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
    console.log(`New message from "${msg.from}"${prio} (${msg.type}): ${msg.content}`);
    console.log(`\nYou MUST do ALL of these in order:`);
    console.log(`1. Call bridge_receive() to mark as read`);
    console.log(`2. Reply with bridge_send(to: "${msg.from}", type: "answer", content: "your reply")`);
    console.log(`3. IMMEDIATELY run: Bash(run_in_background=true, timeout=600000): npx -y mcp-agent-bridge listen`);
  } catch {}

  await sub.quit();
  process.exit(0);
});

// Timeout after 10 minutes — Claude should restart
setTimeout(async () => {
  console.log("Listener timeout — no messages. Restart with: Bash(run_in_background=true, timeout=600000): npx -y mcp-agent-bridge listen");
  await sub.quit();
  process.exit(0);
}, 10 * 60 * 1000);
