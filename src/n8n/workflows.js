import { nowMs } from '../utils/crypto.js';
import { callN8nMcpTool, extractToolPayload } from './client.js';

const WORKFLOW_DISCOVERY_CACHE_TTL_MS = 60 * 1000;

let n8nWorkflowCache = {
  expires_at: 0,
  workflows: []
};

export function slugifyName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

export function parseWorkflowDescription(rawDescription) {
  const fullText = String(rawDescription || '').replace(/\r\n/g, '\n');
  const lines = fullText.split('\n');
  const summary = (lines[0] || '').trim();
  const metadataText = lines.slice(1).join('\n').trim();

  /** @type {Record<string, string>} */
  const inputHints = {};
  let returnImmediately = false;

  if (metadataText) {
    try {
      const parsed = JSON.parse(metadataText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const parsedVars = parsed.vars && typeof parsed.vars === 'object' && !Array.isArray(parsed.vars)
          ? parsed.vars
          : parsed;

        for (const [key, value] of Object.entries(parsedVars)) {
          if (key === 'return_immediately') continue;
          if (!key) continue;
          inputHints[key] = typeof value === 'string' ? value : String(value);
        }

        const returnImmediatelyValue = parsed.return_immediately;
        if (typeof returnImmediatelyValue === 'boolean') {
          returnImmediately = returnImmediatelyValue;
        } else if (typeof returnImmediatelyValue === 'string') {
          returnImmediately = returnImmediatelyValue.toLowerCase().trim() === 'true';
        }
      }
    } catch {
      // Ignore invalid JSON and fall back to generic input handling.
    }
  }

  return {
    summary,
    inputHints,
    returnImmediately
  };
}

export function inferWorkflowInputType(triggerInfo) {
  const info = String(triggerInfo || '').toLowerCase();
  if (info.includes('webhook')) return 'webhook';
  if (info.includes('form')) return 'form';
  return 'chat';
}

export function normalizeWorkflowInputType(value, fallbackType) {
  const normalized = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (normalized === 'chat' || normalized === 'form' || normalized === 'webhook') {
    return normalized;
  }
  return fallbackType;
}

export function buildWorkflowInputsWithAccessToken(inputs, accessToken, triggerInfo, hasInputHints = false) {
  const inferredType = inferWorkflowInputType(triggerInfo);

  if (hasInputHints) {
    const hintedValues = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {};
    if (inferredType === 'webhook') {
      return {
        type: 'webhook',
        webhookData: {
          method: 'POST',
          body: {
            ...hintedValues,
            access_token: accessToken
          }
        }
      };
    }

    if (inferredType === 'form') {
      return {
        type: 'form',
        formData: {
          ...hintedValues,
          access_token: accessToken
        }
      };
    }

    if (typeof hintedValues.chatInput === 'string') {
      return {
        type: 'chat',
        chatInput: hintedValues.chatInput
      };
    }

    return undefined;
  }

  if (inputs === undefined) {
    return undefined;
  }

  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const safeType = normalizeWorkflowInputType(inputs.type, inferredType);

    if (safeType === 'webhook') {
      const webhookData = inputs.webhookData && typeof inputs.webhookData === 'object'
        ? inputs.webhookData
        : {};
      const body = webhookData.body && typeof webhookData.body === 'object'
        ? webhookData.body
        : {};
      return {
        type: 'webhook',
        webhookData: {
          method: webhookData.method || 'POST',
          ...(webhookData.query ? { query: webhookData.query } : {}),
          ...(webhookData.headers ? { headers: webhookData.headers } : {}),
          body: {
            ...body,
            access_token: accessToken
          }
        }
      };
    }

    if (safeType === 'form') {
      const formData = inputs.formData && typeof inputs.formData === 'object'
        ? inputs.formData
        : {};
      return {
        type: 'form',
        formData: {
          ...formData,
          access_token: accessToken
        }
      };
    }

    return {
      type: 'chat',
      chatInput: typeof inputs.chatInput === 'string' ? inputs.chatInput : ''
    };
  }

  return undefined;
}

export async function discoverWorkflowsFromN8n() {
  const now = nowMs();
  if (n8nWorkflowCache.expires_at > now && n8nWorkflowCache.workflows.length > 0) {
    return n8nWorkflowCache.workflows;
  }

  const searchResult = await callN8nMcpTool('search_workflows', { limit: 200 });
  const searchPayload = extractToolPayload(searchResult);
  const workflows = Array.isArray(searchPayload?.data) ? searchPayload.data : [];

  const withDetails = await Promise.all(
    workflows.map(async (workflow) => {
      try {
        const detailResult = await callN8nMcpTool('get_workflow_details', {
          workflowId: workflow.id
        });
        const detailPayload = extractToolPayload(detailResult);
        return {
          id: workflow.id,
          name: workflow.name || detailPayload?.workflow?.name || `workflow_${workflow.id}`,
          description:
            detailPayload?.workflow?.description ||
            workflow.description ||
            `n8n workflow ${workflow.id}`,
          triggerInfo: detailPayload?.triggerInfo || ''
        };
      } catch (error) {
        return {
          id: workflow.id,
          name: workflow.name || `workflow_${workflow.id}`,
          description: workflow.description || `n8n workflow ${workflow.id}`,
          triggerInfo: `Unable to fetch trigger details: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    })
  );

  n8nWorkflowCache = {
    expires_at: now + WORKFLOW_DISCOVERY_CACHE_TTL_MS,
    workflows: withDetails
  };

  return withDetails;
}