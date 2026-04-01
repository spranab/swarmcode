#!/usr/bin/env node

/**
 * Initialize a workspace for SwarmCode.
 *
 * Usage:
 *   swarmcode init <workspace-id> [--redis <redis-url>]
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";

const args = process.argv.slice(2);

if (args[0] !== "init" || !args[1]) {
  console.log("Usage: swarmcode init <workspace-id> [--redis <redis-url>]");
  console.log("");
  console.log("Examples:");
  console.log("  swarmcode init desktop-api");
  console.log("  swarmcode init laptop-frontend --redis redis://your-host:6379");
  process.exit(1);
}

const workspaceId = args[1];
const redisIdx = args.indexOf("--redis");
const redisUrl = redisIdx !== -1 ? args[redisIdx + 1] : "redis://localhost:6379";
const cwd = process.cwd();

// 1. Create/update .mcp.json (merges — preserves other MCP servers)
const mcpPath = resolve(cwd, ".mcp.json");
let mcpConfig = {};
if (existsSync(mcpPath)) {
  try {
    mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {}
}
mcpConfig.mcpServers = mcpConfig.mcpServers || {};
// Remove old entries
delete mcpConfig.mcpServers["agent-bridge"];
delete mcpConfig.mcpServers["agent-bridge-channel"];
// SwarmCode MCP server
mcpConfig.mcpServers["swarmcode"] = {
  command: "npx",
  args: ["-y", "swarmcode-mcp", "channel"],
  env: {
    SWARMCODE_REDIS_URL: redisUrl,
    SWARMCODE_WORKSPACE_ID: workspaceId,
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
  hooks: [{ type: "command", command: `SWARMCODE_REDIS_URL=${redisUrl} SWARMCODE_WORKSPACE_ID=${workspaceId} swarmcode check`, timeout: 3000 }],
};

settings.hooks = settings.hooks || {};
for (const event of ["UserPromptSubmit"]) {
  settings.hooks[event] = settings.hooks[event] || [];
  // Remove old agent-bridge and swarmcode hooks
  settings.hooks[event] = settings.hooks[event].filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes("agent-bridge") || hook.command?.includes("swarmcode") || hook.command?.includes("check-inbox"))
  );
  settings.hooks[event].push(hookEntry);
}
// Remove old Stop hooks
if (settings.hooks.Stop) {
  settings.hooks.Stop = settings.hooks.Stop.filter(
    (h) => !h.hooks?.some((hook) => hook.command?.includes("agent-bridge") || hook.command?.includes("swarmcode") || hook.command?.includes("check-inbox"))
  );
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
}

writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`✓ .claude/settings.json — hook: UserPromptSubmit`);

// 3. Register with Redis directly
try {
  const { default: Redis } = await import("ioredis");
  const redis = new Redis(redisUrl, { keyPrefix: "swarmcode:" });
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
