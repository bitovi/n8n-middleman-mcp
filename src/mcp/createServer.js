import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { N8N_MCP_URL } from '../config.js';
import { discoverWorkflowsFromN8n, slugifyName, parseWorkflowDescription } from '../n8n/workflows.js';
import { buildInputSchema, buildToolDescription, buildToolName, createWorkflowToolHandler } from './workflowTools.js';

export async function createServer() {
  const server = new McpServer(
    {
      name: 'n8n-middleman-ms-connector',
      version: '2.1.0'
    },
    {
      capabilities: {
        tools: { listChanged: true },
        logging: {}
      }
    }
  );

  if (N8N_MCP_URL) {
    try {
      const workflows = await discoverWorkflowsFromN8n();
      const usedNames = new Set();

      for (const workflow of workflows) {
        const slugBase = slugifyName(workflow.name) || 'workflow';
        const toolName = buildToolName({ ...workflow, slugBase }, usedNames);

        const parsedDescription = parseWorkflowDescription(workflow.description);
        const { hasInputHints, inputSchema } = buildInputSchema(parsedDescription);
        const description = buildToolDescription(workflow, parsedDescription);

        server.registerTool(
          toolName,
          {
            description,
            inputSchema
          },
          createWorkflowToolHandler(workflow, parsedDescription, hasInputHints)
        );
      }
    } catch (error) {
      console.error('[n8n-mcp] Failed to discover workflows for dynamic tool registration:',
        error instanceof Error ? error.message : error
      );
    }
  }

  return server;
}