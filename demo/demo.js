#!/usr/bin/env node

/**
 * SwarmCode Demo — Two workspaces having a real-time conversation.
 *
 * Run: node demo/demo.js [--redis redis://host:6379]
 *
 * This simulates two Claude Code workspaces talking to each other
 * via SwarmCode. Perfect for screen recording.
 */

import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";

const REDIS_URL = process.argv.includes("--redis")
  ? process.argv[process.argv.indexOf("--redis") + 1]
  : "redis://localhost:6379";

const PREFIX = "swarmcode:";
const WS_PREFIX = "swarmcode:ws:";

const redis = new Redis(REDIS_URL, { keyPrefix: PREFIX });
const pub = new Redis(REDIS_URL);
const sub1 = new Redis(REDIS_URL);
const sub2 = new Redis(REDIS_URL);

// ANSI colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  blue: "\x1b[38;5;75m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;221m",
  purple: "\x1b[38;5;141m",
  red: "\x1b[38;5;210m",
  gray: "\x1b[38;5;244m",
  cyan: "\x1b[38;5;80m",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timestamp() {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function printHeader() {
  console.log();
  console.log(`${c.bold}${c.purple}  ╔═══════════════════════════════════════════════════════╗${c.reset}`);
  console.log(`${c.bold}${c.purple}  ║           SwarmCode — Live Demo                       ║${c.reset}`);
  console.log(`${c.bold}${c.purple}  ║   Real-time messaging between Claude Code instances    ║${c.reset}`);
  console.log(`${c.bold}${c.purple}  ╚═══════════════════════════════════════════════════════╝${c.reset}`);
  console.log();
}

function printWorkspace(name, machine, color) {
  console.log(`  ${color}${c.bold}[${name}]${c.reset} ${c.dim}on ${machine}${c.reset}`);
}

function printAction(ws, action, color) {
  console.log(`  ${c.gray}${timestamp()}${c.reset}  ${color}${c.bold}${ws}${c.reset}  ${action}`);
}

function printMsg(from, to, content, color) {
  const arrow = to === "*" ? "→ *broadcast*" : `→ ${to}`;
  console.log(`  ${c.gray}${timestamp()}${c.reset}  ${color}${c.bold}${from}${c.reset} ${c.dim}${arrow}${c.reset}`);
  console.log(`  ${c.gray}         ${c.reset}  ${c.dim}"${content}"${c.reset}`);
}

function printReceive(ws, count, color) {
  console.log(`  ${c.gray}${timestamp()}${c.reset}  ${color}${c.bold}${ws}${c.reset}  ${c.yellow}← ${count} message(s) received${c.reset}`);
}

function printDivider() {
  console.log(`  ${c.gray}${"─".repeat(55)}${c.reset}`);
}

async function send(from, to, content, type = "info", priority = "normal") {
  const msg = {
    id: uuidv4(),
    from, to, type, content,
    metadata: {},
    priority,
    timestamp: new Date().toISOString(),
    read: false,
  };

  if (to === "*") {
    const workspaces = await redis.hgetall("workspaces");
    for (const wsId of Object.keys(workspaces)) {
      if (wsId !== from) {
        await redis.lpush(`inbox:${wsId}`, JSON.stringify(msg));
      }
    }
    await pub.publish(`${WS_PREFIX}broadcast`, JSON.stringify(msg));
  } else {
    await redis.lpush(`inbox:${to}`, JSON.stringify(msg));
    await pub.publish(`${WS_PREFIX}${to}`, JSON.stringify(msg));
  }
  await redis.lpush("messages:log", JSON.stringify(msg));
}

async function receive(wsId) {
  const raw = await redis.lrange(`inbox:${wsId}`, 0, -1);
  const messages = raw.map((m) => JSON.parse(m)).reverse();
  await redis.del(`inbox:${wsId}`);
  return messages;
}

async function register(id, desc, machine) {
  const ws = { id, description: desc, machine, registered_at: new Date().toISOString(), last_active: new Date().toISOString() };
  await redis.hset("workspaces", id, JSON.stringify(ws));
}

async function cleanup() {
  const keys = await pub.keys(`${PREFIX}*`);
  if (keys.length) await pub.del(...keys);
}

// --- Demo Script ---
async function main() {
  printHeader();

  console.log(`  ${c.dim}Redis: ${REDIS_URL}${c.reset}`);
  console.log(`  ${c.dim}Cleaning up...${c.reset}`);
  await cleanup();
  console.log();

  // Step 1: Register workspaces
  console.log(`${c.bold}  Step 1: Workspaces come online${c.reset}`);
  printDivider();
  await sleep(500);

  await register("desktop-api", "Building REST API for user auth", "desktop");
  printWorkspace("desktop-api", "desktop", c.blue);
  printAction("desktop-api", `${c.green}registered${c.reset} — "Building REST API for user auth"`, c.blue);
  await sleep(800);

  await register("laptop-frontend", "Building React frontend", "laptop");
  printWorkspace("laptop-frontend", "laptop", c.green);
  printAction("laptop-frontend", `${c.green}registered${c.reset} — "Building React frontend"`, c.green);
  await sleep(1000);
  console.log();

  // Step 2: Desktop builds API and notifies
  console.log(`${c.bold}  Step 2: Desktop builds API, notifies laptop${c.reset}`);
  printDivider();
  await sleep(500);

  printAction("desktop-api", "Building POST /api/users endpoint...", c.blue);
  await sleep(1500);

  await send("desktop-api", "laptop-frontend", "POST /api/users is live. Schema: { id: uuid, email: string, name: string, role: string }. Auth via JWT.", "info", "high");
  printMsg("desktop-api", "laptop-frontend", "POST /api/users is live. Schema: { id, email, name, role }. Auth via JWT.", c.blue);
  await sleep(1000);

  // Step 3: Laptop receives and asks question
  console.log();
  console.log(`${c.bold}  Step 3: Laptop receives message, asks a question${c.reset}`);
  printDivider();
  await sleep(500);

  const msgs1 = await receive("laptop-frontend");
  printReceive("laptop-frontend", msgs1.length, c.green);
  await sleep(500);
  printAction("laptop-frontend", `${c.dim}Processing: "${msgs1[0].content.slice(0, 50)}..."${c.reset}`, c.green);
  await sleep(1000);

  await send("laptop-frontend", "desktop-api", "Got it! Building the signup form now. Does /api/users support pagination for listing?", "question");
  printMsg("laptop-frontend", "desktop-api", "Got it! Building the signup form. Does /api/users support pagination?", c.green);
  await sleep(1000);

  // Step 4: Desktop receives question, answers
  console.log();
  console.log(`${c.bold}  Step 4: Desktop receives question, answers instantly${c.reset}`);
  printDivider();
  await sleep(500);

  const msgs2 = await receive("desktop-api");
  printReceive("desktop-api", msgs2.length, c.blue);
  await sleep(800);

  await send("desktop-api", "laptop-frontend", "Yes! GET /api/users?page=1&limit=20. Also adding GET /api/users/:id for single user.", "answer");
  printMsg("desktop-api", "laptop-frontend", "Yes! GET /api/users?page=1&limit=20. Also adding GET /api/users/:id.", c.blue);
  await sleep(1000);

  // Step 5: Artifact sharing
  console.log();
  console.log(`${c.bold}  Step 5: Desktop shares API schema as artifact${c.reset}`);
  printDivider();
  await sleep(500);

  await send("desktop-api", "*", 'Shared artifact "user-api-schema" — TypeScript interfaces for all user endpoints. Use swarm_receive to get it.', "artifact");
  printMsg("desktop-api", "*", 'Shared artifact "user-api-schema" — TypeScript interfaces for all endpoints', c.blue);
  await sleep(500);

  const msgs3 = await receive("laptop-frontend");
  printReceive("laptop-frontend", msgs3.length, c.green);
  printAction("laptop-frontend", `${c.cyan}Retrieved artifact → generating TypeScript types${c.reset}`, c.green);
  await sleep(1000);

  // Step 6: Laptop confirms integration
  console.log();
  console.log(`${c.bold}  Step 6: Laptop confirms integration complete${c.reset}`);
  printDivider();
  await sleep(500);

  await send("laptop-frontend", "desktop-api", "Signup form done. Login flow working end-to-end with JWT. Pagination integrated. Ready for review.", "info", "high");
  printMsg("laptop-frontend", "desktop-api", "Signup + login done. JWT auth working. Pagination integrated. Ready for review.", c.green);
  await sleep(500);

  const msgs4 = await receive("desktop-api");
  printReceive("desktop-api", msgs4.length, c.blue);
  printAction("desktop-api", `${c.green}Acknowledged — frontend integration complete${c.reset}`, c.blue);
  await sleep(500);

  // Summary
  console.log();
  printDivider();
  console.log();
  console.log(`${c.bold}${c.purple}  Demo complete!${c.reset}`);
  console.log(`  ${c.dim}6 messages exchanged in real-time between desktop and laptop.${c.reset}`);
  console.log(`  ${c.dim}No copy-pasting. No manual coordination. Agents talked directly.${c.reset}`);
  console.log();
  console.log(`  ${c.bold}Install:${c.reset}  npm install -g swarmcode-mcp`);
  console.log(`  ${c.bold}Setup:${c.reset}    swarmcode init my-workspace --redis redis://your-host:6379`);
  console.log(`  ${c.bold}GitHub:${c.reset}   https://github.com/spranab/swarmcode`);
  console.log();

  await cleanup();
  await redis.quit();
  await pub.quit();
  await sub1.quit();
  await sub2.quit();
}

main().catch(console.error);
