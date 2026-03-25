import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fetch from "node-fetch";
import https from "https";

const agent = new https.Agent({ rejectUnauthorized: false });
const N8N_BASE = "https://localhost:5678/webhook";

// ── 1. All possible workflows ──────────────────────────────────────────────
const ALL_WORKFLOWS = {
  get_weather: {
    description: "Gets current weather for a city",
    webhookPath: "get-weather",
    inputSchema: z.object({ city: z.string() }),
  },
  create_task: {
    description: "Creates a task in the task manager",
    webhookPath: "create-task",
    inputSchema: z.object({ title: z.string(), due_date: z.string().optional() }),
  },
  email_draft: {
    description: "Drafts an email given a recipient and message body",
    webhookPath: "email-draft",
    inputSchema: z.object({ to: z.string(), body: z.string() }),
  },
};

// ── 2. Per-user permissions ────────────────────────────────────────────────
const USER_PERMISSIONS = {
  "nikita.email1.com": ["get_weather", "create_task"],
  "nikita.email2@gmail.com": ["email_draft"],
};

// ── 3. Read current user from env variable ─────────────────────────────────
const currentUser = process.env.MCP_USER;

if (!currentUser) {
  console.error("ERROR: MCP_USER environment variable is not set.");
  process.exit(1);
}

const allowedTools = USER_PERMISSIONS[currentUser];

if (!allowedTools) {
  console.error(`ERROR: No permissions found for user: ${currentUser}`);
  process.exit(1);
}

console.error(`Middleman MCP running as: ${currentUser}`);
console.error(`Allowed tools: ${allowedTools.join(", ")}`);

// ── 4. Register only allowed tools ────────────────────────────────────────
const server = new McpServer({ name: "middleman-mcp", version: "1.0.0" });

for (const toolName of allowedTools) {
  const config = ALL_WORKFLOWS[toolName];
  server.tool(toolName, config.description, config.inputSchema.shape, async (params) => {
    const response = await fetch(`${N8N_BASE}/${config.webhookPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      agent,
    });
    const result = await response.json();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);