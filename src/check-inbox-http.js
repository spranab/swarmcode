#!/usr/bin/env node

/**
 * Lightweight inbox checker that uses the Agent Bridge REST API.
 * Works with remote K8s deployments — no direct Redis access needed.
 *
 * Usage: AGENT_BRIDGE_URL=https://mcp.mycluster.cyou AGENT_BRIDGE_WORKSPACE_ID=my-workspace node check-inbox-http.js
 */

const BASE_URL = process.env.AGENT_BRIDGE_URL;
const WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;

if (!BASE_URL || !WORKSPACE_ID) {
  process.exit(0);
}

try {
  const res = await fetch(`${BASE_URL}/api/inbox/${WORKSPACE_ID}`);
  if (!res.ok) process.exit(0);

  const data = await res.json();
  const messages = data.messages || [];

  if (messages.length === 0) process.exit(0);

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
