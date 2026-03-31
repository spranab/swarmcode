#!/usr/bin/env node

/**
 * Initialize a workspace for Agent Bridge.
 *
 * Usage:
 *   npx mcp-agent-bridge init <workspace-id> [--redis <redis-url>]
 *
 * Examples:
 *   npx mcp-agent-bridge init desktop-api
 *   npx mcp-agent-bridge init laptop-frontend --redis redis://redis.mcp.mycluster.cyou:30379
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);

if (args[0] !== "init" || !args[1]) {
  console.log("Usage: mcp-agent-bridge init <workspace-id> [--redis <redis-url>]");
  console.log("");
  console.log("Examples:");
  console.log("  npx mcp-agent-bridge init desktop-api");
  console.log("  npx mcp-agent-bridge init laptop-frontend --redis redis://your-host:6379");
  process.exit(1);
}

const workspaceId = args[1];
const redisIdx = args.indexOf("--redis");
const redisUrl = redisIdx !== -1 ? args[redisIdx + 1] : "redis://localhost:6379";
const cwd = process.cwd();

// No hardcoded paths — use npx to resolve from installed package

// 1. Create/update .mcp.json (merges — preserves other MCP servers)
const mcpPath = resolve(cwd, ".mcp.json");
let mcpConfig = {};
if (existsSync(mcpPath)) {
  try {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {}
}
mcpConfig.mcpServers = mcpConfig.mcpServers || {};
// Remove old SSE server if present
delete mcpConfig.mcpServers["agent-bridge"];
// Channel server — direct Redis, real-time push
mcpConfig.mcpServers["agent-bridge-channel"] = {
  command: "npx",
  args: ["-y", "mcp-agent-bridge", "channel"],
  env: {
    AGENT_BRIDGE_REDIS_URL: redisUrl,
    AGENT_BRIDGE_WORKSPACE_ID: workspaceId,
  },
};
writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
console.log(`✓ .mcp.json — workspace_id: "${workspaceId}", redis: ${redisUrl}`);

// 2. Create/update .claude/settings.json (merges — preserves existing hooks and settings)
const claudeDir = resolve(cwd, ".claude");
const settingsPath = resolve(claudeDir, "settings.json");
if (!existsSync(claudeDir)) {
  mkdirSync(claudeDir, { recursive: true });
}

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch {}
}

const hookEntry = {
  matcher: "",
  hooks: [{ type: "command", command: `AGENT_BRIDGE_REDIS_URL=${redisUrl} AGENT_BRIDGE_WORKSPACE_ID=${workspaceId} npx -y mcp-agent-bridge check`, timeout: 5000 }],
};

settings.hooks = settings.hooks || {};
for (const event of ["UserPromptSubmit"]) {
  settings.hooks[event] = settings.hooks[event] || [];
  // Remove old agent-bridge hooks
  settings.hooks[event] = settings.hooks[event].filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes("agent-bridge") || hook.command?.includes("check-inbox"))
  );
  settings.hooks[event].push(hookEntry);
}
// Remove old Stop hook
if (settings.hooks.Stop) {
  settings.hooks.Stop = settings.hooks.Stop.filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes("agent-bridge") || hook.command?.includes("check-inbox"))
  );
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`✓ .claude/settings.json — hook: UserPromptSubmit`);

// 3. Register with Redis directly
try {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(redisUrl, { keyPrefix: "agent-bridge:" });
  const workspace = {
    id: workspaceId,
    description: `Workspace ${workspaceId}`,
    machine: (await import("os")).hostname(),
    registered_at: new Date().toISOString(),
    last_active: new Date().toISOString(),
  };
  await redis.hset("workspaces", workspaceId, JSON.stringify(workspace));

  const allWs = await redis.hgetall("workspaces");
  const others = Object.keys(allWs).filter((k) => k !== workspaceId);
  console.log(`✓ Registered — ${others.length} other workspace(s) online${others.length ? ": " + others.join(", ") : ""}`);
  await redis.quit();
} catch {
  console.log(`⚠ Could not reach Redis at ${redisUrl} — will auto-register when Claude connects`);
}

console.log("");
console.log(`Done! Restart Claude Code in this workspace to activate.`);
console.log(`Other workspaces can reach you as "${workspaceId}".`);
