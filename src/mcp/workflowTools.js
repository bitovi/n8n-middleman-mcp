import * as z from 'zod/v4';
import { MCP_USER } from '../config.js';
import { ensureUsableToken } from '../auth/oauth.js';
import { buildWorkflowInputsWithAccessToken } from '../n8n/workflows.js';
import { callN8nMcpTool, extractToolPayload } from '../n8n/client.js';

export function buildToolName(workflow, usedNames) {
  const baseName = String(workflow.slugBase || 'workflow');
  let toolName = `n8n_workflow_${baseName}_${String(workflow.id).slice(0, 8)}`;
  let dedupe = 1;
  while (usedNames.has(toolName)) {
    dedupe += 1;
    toolName = `n8n_workflow_${baseName}_${String(workflow.id).slice(0, 8)}_${dedupe}`;
  }
  usedNames.add(toolName);
  return toolName;
}

export function buildInputSchema(parsedDescription) {
  const hasInputHints = Object.keys(parsedDescription.inputHints).length > 0;
  if (hasInputHints) {
    return {
      hasInputHints,
      inputSchema: Object.fromEntries(
        Object.entries(parsedDescription.inputHints).map(([key, hint]) => [
          key,
          z.any().optional().describe(hint)
        ])
      )
    };
  }

  return {
    hasInputHints,
    inputSchema: {
      inputs: z
        .any()
        .optional()
        .describe('Optional complete n8n execute_workflow.inputs object. For description-based args, this connector maps values into webhookData/formData automatically.')
    }
  };
}

export function buildToolDescription(workflow, parsedDescription) {
  return [
    `Execute n8n workflow "${workflow.name}" (id: ${workflow.id}).`,
    parsedDescription.summary,
    parsedDescription.returnImmediately
      ? 'Configured to return immediately without waiting for workflow completion.'
      : 'Configured to wait for workflow completion before returning.',
    workflow.triggerInfo ? `Trigger info: ${workflow.triggerInfo}` : ''
  ].filter(Boolean).join(' ').trim();
}

export function createWorkflowToolHandler(workflow, parsedDescription, hasInputHints) {
  return async (args) => {
    try {
      const userTokens = await ensureUsableToken(MCP_USER);
      if (!userTokens?.access_token) {
        throw new Error('No valid Microsoft access token available. Re-authenticate and try again.');
      }

      const workflowInputs = hasInputHints
        ? (args && typeof args === 'object' ? args : undefined)
        : args?.inputs;

      const executeInputs = buildWorkflowInputsWithAccessToken(
        workflowInputs,
        userTokens.access_token,
        workflow.triggerInfo,
        hasInputHints
      );

      const executeWorkflowArgs = {
        workflowId: workflow.id,
        ...(executeInputs ? { inputs: executeInputs } : {})
      };

      if (parsedDescription.returnImmediately) {
        callN8nMcpTool('execute_workflow', executeWorkflowArgs).catch((error) => {
          console.error(
            `[n8n-mcp] Async execution failed for workflow ${workflow.id}:`,
            error instanceof Error ? error.message : error
          );
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  workflowId: workflow.id,
                  workflowName: workflow.name,
                  accepted: true,
                  message: 'Workflow execution started and is running asynchronously.'
                },
                null,
                2
              )
            }
          ]
        };
      }

      const result = await callN8nMcpTool('execute_workflow', executeWorkflowArgs);
      const payload = extractToolPayload(result);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                workflowId: workflow.id,
                workflowName: workflow.name,
                result: payload || result
              },
              null,
              2
            )
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Failed to execute workflow ${workflow.id}: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  };
}
