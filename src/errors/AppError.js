export class AppError extends Error {
  constructor({
    message,
    statusCode = 500,
    code = 'internal_error',
    publicMessage,
    details,
    jsonRpcCode = -32603
  }) {
    super(message || publicMessage || 'Internal error');
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.publicMessage = publicMessage || message || 'Internal error';
    this.details = details;
    this.jsonRpcCode = jsonRpcCode;
  }
}

export class InvalidRequestError extends AppError {
  constructor(message = 'Invalid request', details) {
    super({
      message,
      statusCode: 400,
      code: 'invalid_request',
      publicMessage: message,
      details,
      jsonRpcCode: -32000
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized', details) {
    super({
      message,
      statusCode: 401,
      code: 'unauthorized',
      publicMessage: message,
      details,
      jsonRpcCode: -32001
    });
  }
}

export class InvalidGrantError extends AppError {
  constructor(message = 'Invalid grant', details) {
    super({
      message,
      statusCode: 400,
      code: 'invalid_grant',
      publicMessage: message,
      details,
      jsonRpcCode: -32000
    });
  }
}

export class UnsupportedGrantTypeError extends AppError {
  constructor(message = 'Unsupported grant type', details) {
    super({
      message,
      statusCode: 400,
      code: 'unsupported_grant_type',
      publicMessage: message,
      details,
      jsonRpcCode: -32000
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found', details) {
    super({
      message,
      statusCode: 404,
      code: 'not_found',
      publicMessage: message,
      details,
      jsonRpcCode: -32000
    });
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message = 'Method not allowed', details) {
    super({
      message,
      statusCode: 405,
      code: 'method_not_allowed',
      publicMessage: message,
      details,
      jsonRpcCode: -32000
    });
  }
}
