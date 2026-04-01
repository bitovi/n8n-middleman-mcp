# n8n Middleman MCP

This project is an MCP (Model Context Protocol) connector that sits between an MCP client (like Claude Desktop) and an n8n MCP server.

It handles **Microsoft OAuth**, stores the Microsoft token in memory, dynamically discovers n8n workflows, and exposes those workflows as MCP tools.

---

## What this repo does

- Hosts an MCP HTTP endpoint at `http://localhost:<MCP_PORT>/mcp` (default `8787`)
- Implements OAuth endpoints for MCP clients:
  - `/.well-known/oauth-authorization-server`
  - `/.well-known/oauth-protected-resource/mcp`
  - `/authorize`
  - `/token`
  - `/oauth/callback`
- Uses Microsoft OAuth to obtain an access token
- Connects to an upstream n8n MCP server (`N8N_MCP`)
- Registers one MCP tool per discovered n8n workflow
- Injects Microsoft `access_token` into supported workflow input shapes before execution

---

## Prerequisites

- Node.js 18+
- An Azure app registration (for Microsoft OAuth)
- A reachable n8n MCP endpoint
- (Recommended for local OAuth callback testing) a public tunnel URL such as ngrok

---

## Microsoft Azure setup (App Registration)

You need an Azure App Registration so this connector can sign users in with Microsoft and exchange auth codes for tokens.

1. Go to **Azure Portal → Microsoft Entra ID → App registrations → New registration**.
2. Give the app a name (for example: `n8n-middleman-mcp`).
3. Choose supported account type:
   - **Accounts in any organizational directory and personal Microsoft accounts** for most flexible local testing (matches `MS_TENANT_ID=common`), or
   - your org-only option if you want single-tenant behavior.
4. Set a **Redirect URI** (Web):
   - `https://<your-public-host>/oauth/callback`
   - Example: `https://your-public-url.ngrok-free.app/oauth/callback`
5. Create the app registration.

Then configure the app:

1. In **API permissions**, add delegated permissions you need.
   - Minimum used by default in this repo: `User.Read`
   - Keep `openid`, `profile`, and `offline_access` in requested scopes.
2. Click **Grant admin consent** if your tenant policies require it.
3. Copy **Application (client) ID** and set it as `MS_CLIENT_ID` in `.env`.
4. (Optional/confidential clients) Create a **Client secret** under **Certificates & secrets** and set `MS_CLIENT_SECRET`.

Environment values to align with Azure:

- `MS_CLIENT_ID` = Azure Application (client) ID
- `MS_TENANT_ID` = `common` (multi-tenant/personal) or your tenant GUID/domain
- `MCP_PUBLIC_URL` must match the host used in your Azure redirect URI

> Important: if `MCP_PUBLIC_URL` changes (for example a new ngrok URL), update the Azure Redirect URI to the new `.../oauth/callback` URL.

---

## Install

```bash
npm install
```

---

## Environment variables

Create a `.env` file in the repo root.

### Required

| Variable | Description |
|---|---|
| `MS_CLIENT_ID` | Azure app client ID used for Microsoft OAuth |

### Usually required for real usage

| Variable | Description |
|---|---|
| `MCP_PUBLIC_URL` | Public base URL used in OAuth metadata and callbacks (for example an ngrok URL) |
| `N8N_MCP` | Upstream n8n MCP endpoint URL |

### Optional

| Variable | Default | Description |
|---|---|---|
| `MS_TENANT_ID` | `common` | Microsoft tenant |
| `MS_SCOPES` | `openid profile offline_access User.Read` | OAuth scopes requested from Microsoft |
| `MS_CLIENT_SECRET` | unset | Needed for confidential client flows |
| `N8N_MCP_AUTH_TOKEN` | unset | Bearer token for n8n MCP if your upstream requires auth |
| `N8N_DEFAULT_WEBHOOK_URL` | unset | Optional n8n webhook URL (reserved/auxiliary) |
| `MCP_PORT` | `8787` | Local server port |
| `MCP_USER` | `default-user` | In-memory user key for stored Microsoft tokens |

Example:

```env
MS_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MS_TENANT_ID=common
MS_SCOPES="openid profile offline_access User.Read"

MCP_PUBLIC_URL=https://your-public-url.ngrok-free.app
MCP_PORT=8787

N8N_MCP=https://your-n8n-host/mcp
N8N_MCP_AUTH_TOKEN=your_n8n_mcp_token
```

---

## Run

```bash
npm start
```

You should see:

```text
External MCP connector listening at http://localhost:8787/mcp
```

---

## How authentication works

1. MCP client requests authorization.
2. Connector redirects to Microsoft login.
3. Microsoft returns to `/oauth/callback`.
4. Connector exchanges code for Microsoft tokens.
5. Connector issues MCP auth code/access token/refresh token back to the MCP client.
6. MCP client calls `/mcp` with bearer token.

At tool execution time, the connector ensures a valid Microsoft access token and forwards workflow execution to n8n MCP.

> Current storage is in-memory (`Map` objects). Restarting the process clears sessions and tokens.

---

## Dynamic tool registration behavior

On startup, if `N8N_MCP` is configured, the connector:

1. Calls upstream `search_workflows`
2. Calls `get_workflow_details` per workflow
3. Registers each workflow as an MCP tool named like:

`n8n_workflow_<slugified_name>_<workflow_id_prefix>`

Workflow description metadata can include JSON hints for expected inputs and an optional `return_immediately` flag.

### How n8n description JSON parsing works

For each discovered workflow, the connector parses `workflow.description` using this pattern:

1. **First line** is treated as human-readable summary text.
2. **Remaining lines** are treated as JSON (optional).

If the JSON parses successfully, the connector interprets it as either:

- a plain object of input hints, or
- an object with a `vars` object plus optional top-level flags.

Supported parsing behavior:

- `return_immediately` (boolean or string) enables async fire-and-forget execution.
- All other keys become MCP tool input fields (as optional args) with descriptions from their values.
- If `vars` exists, keys are read from `vars` (except `return_immediately`, which is read from the top level).

Example description format:

```text
Create a calendar summary from user events
{
  "vars": {
    "startDate": "ISO start date",
    "endDate": "ISO end date",
    "timezone": "IANA timezone string"
  },
  "return_immediately": true
}
```

Notes:

- Invalid JSON in the metadata block is safely ignored; the connector falls back to generic `inputs` handling.
- When input hints are present, provided args are mapped into webhook/form/chat inputs automatically and `access_token` is injected where applicable.

---

## Local test script for upstream n8n MCP

You can verify your upstream n8n MCP setup directly:

```bash
npm run test:n8n-mcp
```

Optional test env vars:

- `TEST_TOOL_NAME` – tool to invoke after listing tools
- `TEST_TOOL_ARGS` – JSON string of arguments for that tool
- `VERBOSE_TOOL_SCHEMAS=1` – prints full tool schema details

---

## Troubleshooting

- **`Missing required environment variable: MS_CLIENT_ID`**
  - Add `MS_CLIENT_ID` to `.env`

- **401 / missing bearer token at `/mcp`**
  - Complete OAuth flow through your MCP client first

- **OAuth discovery errors requiring `MCP_PUBLIC_URL`**
  - Set `MCP_PUBLIC_URL` to a valid public base URL

- **Cannot connect to n8n MCP**
  - Check `N8N_MCP` URL
  - If protected, set/rotate `N8N_MCP_AUTH_TOKEN`

---

## Scripts

- `npm start` – start connector server
- `npm run test:n8n-mcp` – test upstream n8n MCP connectivity and tools
