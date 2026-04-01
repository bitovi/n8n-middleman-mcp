import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function loadDotEnv(filePath = '.env') {
  const absolutePath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) return;

  const text = fs.readFileSync(absolutePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildCandidateEndpoints(rawEndpoint) {
  const clean = String(rawEndpoint || '').trim();
  if (!clean) return [];

  const withoutTrailingSlash = clean.replace(/\/+$/, '');
  const candidates = [
    clean,
    withoutTrailingSlash,
    `${withoutTrailingSlash}/mcp`,
    `${withoutTrailingSlash}/mcp/`,
    `${withoutTrailingSlash}/mcp-server/http`,
    `${withoutTrailingSlash}/mcp-server/http/`,
    `${withoutTrailingSlash}/mcp-server/sse`,
    `${withoutTrailingSlash}/mcp-server/sse/`,
    `${withoutTrailingSlash}/rest/mcp`,
    `${withoutTrailingSlash}/api/mcp`
  ];

  return [...new Set(candidates.filter(Boolean))];
}

function extractPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }

  if (Array.isArray(result?.content)) {
    const textPart = result.content.find((item) => item?.type === 'text' && typeof item.text === 'string');
    if (textPart?.text) {
      try {
        return JSON.parse(textPart.text);
      } catch {
        return { text: textPart.text };
      }
    }
  }

  return result ?? null;
}

function extractWorkflows(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const candidates = [
    payload.data,
    payload.workflows,
    payload.items,
    payload.results,
    payload.result?.data,
    payload.result?.workflows,
    payload.result?.items
  ];

  for (const value of candidates) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

async function connectWithEndpointFallback(client, endpoint, requestInit) {
  const endpoints = buildCandidateEndpoints(endpoint);
  let lastError = null;

  for (const candidate of endpoints) {
    const transport = new StreamableHTTPClientTransport(new URL(candidate), { requestInit });

    try {
      console.log(`[test] Trying MCP endpoint: ${candidate}`);
      await client.connect(transport);
      return { transport, endpoint: candidate };
    } catch (error) {
      lastError = error;
      await transport.close().catch(() => {});
      console.log(
        `[test] Connection failed for ${candidate}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const lastErrorMessage = lastError instanceof Error ? lastError.message : String(lastError);
  const authHint = /unauthorized|invalid signature|401/i.test(lastErrorMessage)
    ? ' Hint: n8n MCP endpoint appears reachable but your N8N_MCP_AUTH_TOKEN is invalid/expired. Rotate or recreate the MCP API key in n8n and update .env.'
    : '';

  throw new Error(
    `Unable to connect to n8n MCP. Tried: ${endpoints.join(', ')}. Last error: ${lastErrorMessage}.${authHint}`
  );
}

async function main() {
  loadDotEnv();

  const endpoint = process.env.N8N_MCP;
  if (!endpoint) {
    throw new Error('N8N_MCP is missing. Set it in .env or your shell env.');
  }

  const n8nMcpAuthToken = process.env.N8N_MCP_AUTH_TOKEN;

  const testToolName = process.env.TEST_TOOL_NAME;
  const testToolArgs = parseJsonEnv('TEST_TOOL_ARGS', {});

  const client = new Client({ name: 'n8n-mcp-test-client', version: '1.0.0' });
  const requestInit = n8nMcpAuthToken
    ? {
        headers: {
          Authorization: `Bearer ${n8nMcpAuthToken}`
        }
      }
    : undefined;

  console.log(`[test] Connecting to n8n MCP (base): ${endpoint}`);
  const { transport, endpoint: resolvedEndpoint } = await connectWithEndpointFallback(client, endpoint, requestInit);
  console.log(`[test] Connected using endpoint: ${resolvedEndpoint}`);

  try {
    const { tools = [] } = await client.listTools();
    console.log(`[test] listTools() success. Discovered ${tools.length} tool(s).`);

    if (tools.length) {
      console.log('[test] First 25 tool names:');
      for (const name of tools.slice(0, 25).map((t) => t.name)) {
        console.log(`  - ${name}`);
      }
    }

    if (process.env.VERBOSE_TOOL_SCHEMAS === '1') {
      console.log('[test] Full tool definitions:');
      console.log(JSON.stringify(tools, null, 2));
    }

    const searchWorkflowsTool = tools.find((tool) => tool.name === 'search_workflows');
    if (searchWorkflowsTool) {
      console.log('[test] Detected search_workflows tool, running discovery check...');
      try {
        const searchResult = await client.callTool({
          name: 'search_workflows',
          arguments: { limit: 50 }
        });
        const payload = extractPayload(searchResult);
        const workflows = extractWorkflows(payload);
        console.log(`[test] search_workflows returned ${workflows.length} workflow(s).`);
        if (workflows.length > 0) {
          console.log('[test] Workflow preview:');
          for (const wf of workflows.slice(0, 10)) {
            const id = wf?.id ?? wf?.workflowId ?? wf?.workflow_id ?? '(no id)';
            const name = wf?.name ?? wf?.title ?? '(no name)';
            console.log(`  - ${name} [${id}]`);
          }
        } else {
          console.log('[test] search_workflows payload (no array detected):');
          console.log(JSON.stringify(payload, null, 2));
        }
      } catch (error) {
        console.log(`[test] search_workflows check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!testToolName) {
      console.log('[test] Skipping callTool() test (set TEST_TOOL_NAME to run a live tool call).');
      return;
    }

    console.log(`[test] Calling tool: ${testToolName}`);
    const callResult = await client.callTool({
      name: testToolName,
      arguments: testToolArgs
    });

    console.log('[test] callTool() success. Result preview:');
    console.log(JSON.stringify(callResult, null, 2));
  } finally {
    await transport.close();
    console.log('[test] Connection closed.');
  }
}

main().catch((error) => {
  console.error('[test] FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
