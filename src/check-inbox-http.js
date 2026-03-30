#!/usr/bin/env node

/**
 * Inbox checker hook for Claude Code.
 * Reads config from .mcp.json, checks the Agent Bridge REST API for pending messages,
 * and outputs actionable directives that Claude must follow.
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

  // Always output workspace identity
  console.log(`[AGENT BRIDGE] You are workspace "${WORKSPACE_ID}". Use this ID for all agent-bridge tool calls (register, send, receive).`);

  if (messages.length === 0) {
    process.exit(0);
  }

  // Build action items based on message types
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

    // Generate specific action based on message type
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
} catch {
  process.exit(0);
}
