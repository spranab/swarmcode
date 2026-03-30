#!/usr/bin/env node

/**
 * Inbox checker hook for Claude Code.
 * Reads config from .mcp.json, checks the Agent Bridge REST API for pending messages.
 *
 * Two modes based on AGENT_BRIDGE_HOOK_MODE env var:
 *   "stop"   → outputs JSON {decision:"block", reason:"..."} to force Claude to continue
 *   default  → outputs text directives for UserPromptSubmit context injection
 */

import { readFileSync } from "fs";
import { resolve } from "path";

let BASE_URL = process.env.AGENT_BRIDGE_URL;
let WORKSPACE_ID = process.env.AGENT_BRIDGE_WORKSPACE_ID;
const HOOK_MODE = process.env.AGENT_BRIDGE_HOOK_MODE || "prompt";

// Try to read from .mcp.json
if (!BASE_URL || !WORKSPACE_ID) {
  try {
    const mcpPath = resolve(process.cwd(), ".mcp.json");
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    const server = mcpConfig?.mcpServers?.["agent-bridge"];
    if (server) {
      WORKSPACE_ID = WORKSPACE_ID || server.headers?.["x-workspace-id"];
      if (server.url) {
        const parsed = new URL(server.url);
        BASE_URL = BASE_URL || `${parsed.protocol}//${parsed.host}`;
      }
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

  if (messages.length === 0) {
    if (HOOK_MODE === "prompt") {
      console.log(`[AGENT BRIDGE] You are workspace "${WORKSPACE_ID}". Use this ID for all agent-bridge tool calls (register, send, receive).`);
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
        actions.push(`REPLY to "${msg.from}": Answer using send(from: "${WORKSPACE_ID}", to: "${msg.from}", type: "answer", content: "your answer")`);
        break;
      case "request":
        actions.push(`ACT on request from "${msg.from}", then send confirmation back`);
        break;
      case "artifact":
        if (msg.metadata?.artifact_name) {
          actions.push(`RETRIEVE artifact "${msg.metadata.artifact_name}" using get_artifact("${msg.metadata.artifact_name}")`);
        }
        break;
      case "info":
      case "decision":
        actions.push(`ACKNOWLEDGE to "${msg.from}" using send(from: "${WORKSPACE_ID}", to: "${msg.from}", type: "info", content: "Acknowledged: ...")`);
        break;
      case "answer":
        actions.push(`APPLY the answer from "${msg.from}" to your current work`);
        break;
    }
  }

  lines.push("REQUIRED ACTIONS:");
  lines.push(`1. Call receive("${WORKSPACE_ID}") to mark messages as read`);
  for (let i = 0; i < actions.length; i++) {
    lines.push(`${i + 2}. ${actions[i]}`);
  }

  const reason = lines.join("\n");

  if (HOOK_MODE === "stop") {
    // Stop hook mode: output JSON to block stopping and force Claude to process messages
    console.log(JSON.stringify({ decision: "block", reason }));
  } else {
    // UserPromptSubmit mode: output text directives
    console.log(`[AGENT BRIDGE] ${reason}`);
  }
} catch {
  process.exit(0);
}
