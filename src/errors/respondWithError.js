import { AppError } from './AppError.js';
import { sendJson } from '../utils/http.js';

function normalizeError(error) {
  if (error instanceof AppError) return error;
  return new AppError({
    message: error instanceof Error ? error.message : 'Internal error',
    statusCode: 500,
    code: 'internal_error',
    publicMessage: error instanceof Error ? error.message : 'Internal error',
    jsonRpcCode: -32603
  });
}

export function respondWithError(res, error, context = 'http') {
  const appError = normalizeError(error);

  if (appError?.details?.headers && typeof appError.details.headers === 'object') {
    for (const [headerName, headerValue] of Object.entries(appError.details.headers)) {
      res.setHeader(headerName, headerValue);
    }
  }

  if (context === 'oauth') {
    sendJson(res, appError.statusCode, {
      error: appError.code,
      error_description: appError.publicMessage
    });
    return;
  }

  if (context === 'mcp') {
    sendJson(res, appError.statusCode, {
      jsonrpc: '2.0',
      error: {
        code: appError.jsonRpcCode,
        message: appError.publicMessage
      },
      id: null
    });
    return;
  }

  sendJson(res, appError.statusCode, {
    error: appError.publicMessage,
    code: appError.code
  });
}
