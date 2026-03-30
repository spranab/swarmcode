#!/usr/bin/env node

/**
 * Lightweight inbox checker that reads config from .mcp.json.
 * Works with remote deployments — no direct Redis access needed.
 *
 * Reads the agent-bridge URL and workspace_id from .mcp.json:
 *   { "mcpServers": { "agent-bridge": { "url": "https://host/sse?workspace_id=my-ws" } } }
 *
 * Falls back to env vars AGENT_BRIDGE_URL and AGENT_BRIDGE_WORKSPACE_ID.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

let BASE_URL = process.env.AGENT_BRIDGE_URL;
let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;

// Try to read from .mcp.json
if (!BASE_URL || !WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const sseUrl = mcpConfig?.mcpServers?.["agent-bridge"]?.url;
    if (sseUrl) {
      const parsed = new URL(sseUrl);
      WORKSPACE_ID = WORKSPACE_ID || parsed.searchParams.get("workspace_id");
      BASE_URL = BASE_URL || `${parsed.protocol}//${parsed.host}`;
    }
  } catch {}
}

if (!BASE_URL || !WORKSPACE_ID) {
  process.exit(0);
}

try {
  const res = await fetch(`${BASE_URL}/api/inbox/${WORKSPACE_ID}`);
  if (!res.ok) process.exit(0);

  const data = await res.json();
  const messages = data.messages || [];

  // Always output workspace identity so Claude knows who it is
  console.log(`\nAGENT BRIDGE: Your workspace_id is "${WORKSPACE_ID}". Use this for register(), send(from:), and receive().`);

  if (messages.length === 0) {
    console.log("No pending messages.\n");
    process.exit(0);
  }

  // Get workspace status
  let workspaces = [];
  try {
    const statusRes = await fetch(`${BASE_URL}/api/status`);
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      workspaces = statusData.workspaces || [];
    }
  } catch {}

  console.log(`\n📨 AGENT BRIDGE: ${messages.length} pending message(s) from other workspaces:\n`);

  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString();
    const prio = msg.priority === "high" || msg.priority === "urgent" ? ` [${msg.priority.toUpperCase()}]` : "";
    console.log(`  [${time}] ${msg.from} → ${msg.to}${prio} (${msg.type}):`);
    console.log(`    ${msg.content}`);
    if (msg.metadata && Object.keys(msg.metadata).length > 0) {
      console.log(`    metadata: ${JSON.stringify(msg.metadata)}`);
    }
    console.log();
  }

  if (workspaces.length > 0) {
    console.log(`Active workspaces: ${workspaces.map((w) => `${w.id} (${w.description})`).join(", ")}`);
  }

  console.log(`\nIMPORTANT: You have unread messages above. Acknowledge them and call receive("${WORKSPACE_ID}") to mark as read. If any require a response, use send() to reply.\n`);
} catch {
  process.exit(0);
}
