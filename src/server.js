#!/usr/bin/env node

/**
 * Agent Bridge CLI entry point.
 *
 * Usage:
 *   agent-bridge init <workspace-id> [--redis <redis-url>]
 *   agent-bridge channel   (starts the channel MCP server — normally spawned by Claude Code)
 *   agent-bridge listen    (starts the one-shot Redis listener — normally run as background task)
 *   agent-bridge check     (quick inbox check — used by hooks)
 */

const cmd = process.argv[2];

if (cmd === "init") {
  await import("./init.js");
} else if (cmd === "channel") {
  await import("./channel.js");
} else if (cmd === "listen") {
  await import("./listener.js");
} else if (cmd === "check") {
  await import("./check-inbox-http.js");
} else {
  console.log("Agent Bridge — real-time communication between Claude Code instances\n");
  console.log("Usage:");
  console.log("  npx mcp-agent-bridge init <workspace-id> --redis <redis-url>");
  console.log("  npx mcp-agent-bridge channel    (MCP server — spawned by Claude Code)");
  console.log("  npx mcp-agent-bridge listen      (background Redis listener)");
  console.log("  npx mcp-agent-bridge check       (quick inbox check for hooks)\n");
  console.log("Quick start:");
  console.log("  npx mcp-agent-bridge init my-workspace --redis redis://your-redis:6379");
}
