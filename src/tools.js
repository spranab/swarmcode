import { v4 as uuidv4 } from "uuid";
import { getRedis, WS_CHANNEL_PREFIX } from "./redis.js";

const WORKSPACE_TTL = 60 * 60 * 2; // 2 hours
const MESSAGE_TTL = 60 * 60 * 24; // 24 hours

// No global subscriber — each SSE session subscribes to its own workspace channel via server.js

export const toolDefinitions = [
  {
    name: "register",
    description:
      "Register this workspace with the bridge. YOU MUST call this at the very start of every conversation before doing anything else. This lets other Claude Code agents across machines know you exist and what you're working on. After registering, always check the returned pending_messages — other agents may have sent you important context.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description:
            'A short unique name for this workspace (e.g. "desktop-api", "laptop-frontend")',
        },
        description: {
          type: "string",
          description:
            "What this workspace is currently working on (e.g. \"Building the REST API for user auth\")",
        },
        machine: {
          type: "string",
          description:
            'Machine identifier (e.g. "desktop", "laptop", hostname)',
        },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: "send",
    description:
      'Send a message to a specific workspace or broadcast to all. You SHOULD proactively send messages when: (1) you complete a feature or API that other workspaces depend on, (2) you make a decision that affects shared code, (3) you need information from another workspace, (4) you change a shared interface or schema. Use to="*" to broadcast to all workspaces.',
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Your workspace_id (must be registered)",
        },
        to: {
          type: "string",
          description:
            'Target workspace_id, or "*" to broadcast to all',
        },
        type: {
          type: "string",
          enum: [
            "info",
            "request",
            "decision",
            "artifact",
            "question",
            "answer",
          ],
          description: "Message type for categorization",
        },
        content: {
          type: "string",
          description: "The message content",
        },
        metadata: {
          type: "object",
          description:
            "Optional structured data (e.g. file paths, schemas, configs)",
        },
        priority: {
          type: "string",
          enum: ["low", "normal", "high", "urgent"],
          description: "Message priority (default: normal)",
        },
      },
      required: ["from", "to", "content"],
    },
  },
  {
    name: "receive",
    description:
      "Check for messages sent to this workspace. YOU MUST call this: (1) at the start of every conversation, (2) before starting any new task, (3) after completing a significant piece of work, and (4) whenever the user mentions another workspace or cross-machine coordination. Messages may contain critical context, decisions, schemas, or requests from other Claude Code agents working in parallel.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Your workspace_id",
        },
        since: {
          type: "string",
          description:
            "ISO timestamp to fetch messages after (default: last 1 hour)",
        },
        type: {
          type: "string",
          description: "Filter by message type",
        },
        mark_read: {
          type: "boolean",
          description: "Mark fetched messages as read (default: true)",
        },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: "status",
    description:
      "See all registered workspaces, what they're working on, and when they were last active. Useful for understanding the distributed team state.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "share_artifact",
    description:
      "Share a code snippet, file content, schema, or any structured artifact with other workspaces. More structured than a plain message.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "Your workspace_id",
        },
        name: {
          type: "string",
          description:
            'Artifact name (e.g. "user-api-schema", "db-migration-v2")',
        },
        type: {
          type: "string",
          enum: [
            "schema",
            "snippet",
            "config",
            "interface",
            "decision",
            "file",
          ],
          description: "Artifact type",
        },
        content: {
          type: "string",
          description: "The artifact content (code, JSON, text, etc.)",
        },
        description: {
          type: "string",
          description: "What this artifact is and how to use it",
        },
      },
      required: ["from", "name", "type", "content"],
    },
  },
  {
    name: "get_artifact",
    description: "Retrieve a shared artifact by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Artifact name to retrieve",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_artifacts",
    description: "List all shared artifacts.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_status",
    description:
      "Update what your workspace is currently working on. Call this whenever you switch to a different task or hit a major milestone. Other agents see this when they call status, so keep it current.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "Your workspace_id",
        },
        description: {
          type: "string",
          description: "What you are currently working on",
        },
        progress: {
          type: "string",
          description:
            'Current progress note (e.g. "80% done with auth module")',
        },
      },
      required: ["workspace_id", "description"],
    },
  },
];

// Tool handlers
export async function handleTool(name, args) {
  const r = getRedis();

  switch (name) {
    case "register": {
      const workspace = {
        id: args.workspace_id,
        description: args.description || "",
        machine: args.machine || "unknown",
        registered_at: new Date().toISOString(),
        last_active: new Date().toISOString(),
      };
      await r.hset("workspaces", args.workspace_id, JSON.stringify(workspace));
      await r.expire("workspaces", WORKSPACE_TTL);

      // Check for pending messages
      const inbox = await getInboxMessages(r, args.workspace_id);

      // Get other active workspaces
      const allWs = await r.hgetall("workspaces");
      const others = Object.values(allWs)
        .map((v) => JSON.parse(v))
        .filter((w) => w.id !== args.workspace_id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "registered",
                workspace: workspace,
                pending_messages: inbox.length,
                messages: inbox.slice(0, 5),
                active_workspaces: others.map((w) => ({
                  id: w.id,
                  description: w.description,
                  machine: w.machine,
                  last_active: w.last_active,
                })),
                instructions: {
                  your_id: args.workspace_id,
                  how_to_send: `send(from: "${args.workspace_id}", to: "TARGET_WORKSPACE_ID", type: "info|question|request|decision", content: "your message")`,
                  how_to_receive: `receive("${args.workspace_id}")`,
                  how_to_broadcast: `send(from: "${args.workspace_id}", to: "*", content: "your message")`,
                  auto_loop: "Your inbox is checked automatically after every response via the Stop hook. If a new message arrives while you're responding, you'll see it immediately after and should process it.",
                  behavior: "Always reply to questions. Acknowledge info/decisions. Act on requests. Retrieve shared artifacts. Use send() to communicate back — never assume the other workspace can read your text output.",
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "send": {
      const msg = {
        id: uuidv4(),
        from: args.from,
        to: args.to,
        type: args.type || "info",
        content: args.content,
        metadata: args.metadata || {},
        priority: args.priority || "normal",
        timestamp: new Date().toISOString(),
        read: false,
      };

      // Store in target's inbox (or broadcast)
      if (args.to === "*") {
        const workspaces = await r.hgetall("workspaces");
        for (const wsId of Object.keys(workspaces)) {
          if (wsId !== args.from) {
            await r.lpush(`inbox:${wsId}`, JSON.stringify(msg));
            await r.expire(`inbox:${wsId}`, MESSAGE_TTL);
          }
        }
      } else {
        await r.lpush(`inbox:${args.to}`, JSON.stringify(msg));
        await r.expire(`inbox:${args.to}`, MESSAGE_TTL);
      }

      // Also store in global log
      await r.lpush("messages:log", JSON.stringify(msg));
      await r.ltrim("messages:log", 0, 499);

      // Publish to per-workspace channels for real-time delivery
      if (args.to === "*") {
        // Broadcast channel — all subscribers hear it
        await getRedis().publish(`${WS_CHANNEL_PREFIX}broadcast`, JSON.stringify(msg));
      } else {
        // Direct channel — only target workspace hears it
        await getRedis().publish(`${WS_CHANNEL_PREFIX}${args.to}`, JSON.stringify(msg));
      }

      // Update sender's last_active
      await touchWorkspace(r, args.from);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "sent", message_id: msg.id, to: args.to },
              null,
              2
            ),
          },
        ],
      };
    }

    case "receive": {
      const since = args.since
        ? new Date(args.since).getTime()
        : Date.now() - 60 * 60 * 1000;
      const markRead = args.mark_read !== false;

      let messages = await getInboxMessages(r, args.workspace_id);

      // Filter by time
      messages = messages.filter(
        (m) => new Date(m.timestamp).getTime() >= since
      );

      // Filter by type
      if (args.type) {
        messages = messages.filter((m) => m.type === args.type);
      }

      if (markRead) {
        // Clear inbox after reading
        await r.del(`inbox:${args.workspace_id}`);
        // Re-add any messages older than our filter
        const allMsgs = await getInboxMessages(r, args.workspace_id);
        const older = allMsgs.filter(
          (m) => new Date(m.timestamp).getTime() < since
        );
        for (const m of older) {
          await r.rpush(
            `inbox:${args.workspace_id}`,
            JSON.stringify(m)
          );
        }
      }

      await touchWorkspace(r, args.workspace_id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspace: args.workspace_id,
                message_count: messages.length,
                messages: messages,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "status": {
      const raw = await r.hgetall("workspaces");
      const workspaces = Object.values(raw).map((v) => JSON.parse(v));

      // Get pending message counts
      for (const ws of workspaces) {
        const len = await r.llen(`inbox:${ws.id}`);
        ws.pending_messages = len;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                workspace_count: workspaces.length,
                workspaces: workspaces,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    case "share_artifact": {
      const artifact = {
        name: args.name,
        type: args.type,
        content: args.content,
        description: args.description || "",
        shared_by: args.from,
        shared_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      await r.hset("artifacts", args.name, JSON.stringify(artifact));

      // Notify all workspaces
      const notif = {
        id: uuidv4(),
        from: args.from,
        to: "*",
        type: "artifact",
        content: `Shared artifact "${args.name}" (${args.type}): ${args.description || args.name}`,
        metadata: { artifact_name: args.name, artifact_type: args.type },
        priority: "normal",
        timestamp: new Date().toISOString(),
        read: false,
      };
      const workspaces = await r.hgetall("workspaces");
      for (const wsId of Object.keys(workspaces)) {
        if (wsId !== args.from) {
          await r.lpush(`inbox:${wsId}`, JSON.stringify(notif));
        }
      }

      await touchWorkspace(r, args.from);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "shared", artifact: { ...artifact, content: `${artifact.content.slice(0, 100)}...` } },
              null,
              2
            ),
          },
        ],
      };
    }

    case "get_artifact": {
      const raw = await r.hget("artifacts", args.name);
      if (!raw) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: `Artifact "${args.name}" not found` }) },
          ],
        };
      }
      return {
        content: [{ type: "text", text: raw }],
      };
    }

    case "list_artifacts": {
      const raw = await r.hgetall("artifacts");
      const artifacts = Object.values(raw).map((v) => {
        const a = JSON.parse(v);
        return { name: a.name, type: a.type, description: a.description, shared_by: a.shared_by, shared_at: a.shared_at };
      });
      return {
        content: [
          { type: "text", text: JSON.stringify({ count: artifacts.length, artifacts }, null, 2) },
        ],
      };
    }

    case "update_status": {
      const raw = await r.hget("workspaces", args.workspace_id);
      if (!raw) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Workspace not registered. Call register first." }) },
          ],
        };
      }
      const ws = JSON.parse(raw);
      ws.description = args.description;
      ws.progress = args.progress || "";
      ws.last_active = new Date().toISOString();
      await r.hset("workspaces", args.workspace_id, JSON.stringify(ws));

      return {
        content: [
          { type: "text", text: JSON.stringify({ status: "updated", workspace: ws }, null, 2) },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}

async function getInboxMessages(r, workspaceId) {
  const raw = await r.lrange(`inbox:${workspaceId}`, 0, -1);
  return raw.map((m) => JSON.parse(m)).reverse(); // oldest first
}

async function touchWorkspace(r, workspaceId) {
  const raw = await r.hget("workspaces", workspaceId);
  if (raw) {
    const ws = JSON.parse(raw);
    ws.last_active = new Date().toISOString();
    await r.hset("workspaces", workspaceId, JSON.stringify(ws));
  }
}
