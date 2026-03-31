#!/usr/bin/env node

/**
 * SwarmCode one-shot Redis listener.
 *
 * Subscribes to workspace channel, waits for ONE message, outputs it, exits.
 * The exit triggers a task-notification in Claude Code.
 */

import Redis from "ioredis";
import { readFileSync } from "fs";
import { resolve } from "path";

const REDIS_URL = process.env.SWARMCODE_REDIS_URL || process.env.AGENT_BRIDGE_REDIS_URL || "redis://localhost:6379";
const WS_CHANNEL_PREFIX = "swarmcode:ws:";
let WORKSPACE_ID = process.env.SWARMCODE_WORKSPACE_ID || process.env.AGENT_BRIDGE_WORKSPACE_ID;

if (!WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const sc = mcpConfig?.mcpServers?.["swarmcode"];
    if (sc?.env) WORKSPACE_ID = sc.env.SWARMCODE_WORKSPACE_ID;
    if (!WORKSPACE_ID) {
      const ab = mcpConfig?.mcpServers?.["agent-bridge"];
      if (ab?.env) WORKSPACE_ID = ab.env.AGENT_BRIDGE_WORKSPACE_ID;
    }
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

sub.on("message", async (_ch, raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.from === WORKSPACE_ID) return;

    const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
    console.log(`New message from "${msg.from}"${prio} (${msg.type}): ${msg.content}`);
    console.log(`\nYou MUST do ALL of these in order:`);
    console.log(`1. Call swarm_receive() to mark as read`);
    console.log(`2. Reply with swarm_send(to: "${msg.from}", type: "answer", content: "your reply")`);
    console.log(`3. IMMEDIATELY run: Bash(run_in_background=true, timeout=600000): npx -y swarmcode listen`);
  } catch {}

  await sub.quit();
  process.exit(0);
});

setTimeout(async () => {
  console.log("Listener timeout — no messages. Restart with: Bash(run_in_background=true, timeout=600000): npx -y swarmcode listen");
  await sub.quit();
  process.exit(0);
}, 10 * 60 * 1000);
