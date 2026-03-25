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

async function main() {
  loadDotEnv();

  const endpoint = process.env.N8N_MCP;
  if (!endpoint) {
    throw new Error('N8N_MCP is missing. Set it in .env or your shell env.');
  }

  const testToolName = process.env.TEST_TOOL_NAME;
  const testToolArgs = parseJsonEnv('TEST_TOOL_ARGS', {});

  const client = new Client({ name: 'n8n-mcp-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));

  console.log(`[test] Connecting to n8n MCP: ${endpoint}`);
  await client.connect(transport);

  try {
    const { tools = [] } = await client.listTools();
    console.log(`[test] listTools() success. Discovered ${tools.length} tool(s).`);

    if (tools.length) {
      console.log('[test] First 25 tool names:');
      for (const name of tools.slice(0, 25).map((t) => t.name)) {
        console.log(`  - ${name}`);
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
