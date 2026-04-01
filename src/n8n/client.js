import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { N8N_MCP_AUTH_TOKEN, N8N_MCP_URL } from '../config.js';

let n8nMcpClient = null;
let n8nMcpTransport = null;

export async function ensureN8nMcpClient() {
  if (n8nMcpClient && n8nMcpTransport) return n8nMcpClient;
  if (!N8N_MCP_URL) {
    throw new Error('N8N_MCP environment variable is not configured.');
  }

  const requestInit = N8N_MCP_AUTH_TOKEN
    ? {
        headers: {
          Authorization: `Bearer ${N8N_MCP_AUTH_TOKEN}`
        }
      }
    : undefined;

  const client = new Client({ name: 'n8n-middleman-upstream-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(N8N_MCP_URL), { requestInit });

  transport.onclose = () => {
    n8nMcpClient = null;
    n8nMcpTransport = null;
  };

  await client.connect(transport);
  n8nMcpClient = client;
  n8nMcpTransport = transport;
  return client;
}

export function extractToolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }

  if (Array.isArray(result?.content)) {
    const textPart = result.content.find((item) => item?.type === 'text' && typeof item.text === 'string');
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return null;
      }
    }
  }

  return null;
}

export async function callN8nMcpTool(name, args = {}) {
  const client = await ensureN8nMcpClient();
  return client.callTool({ name, arguments: args });
}