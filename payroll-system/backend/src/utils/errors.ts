/** Application error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Unauthorized') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message);

export const notFound = (entity: string) =>
  new AppError(404, 'NOT_FOUND', `${entity} not found`);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);

/**
 * A conflict that the caller is expected to branch on, carrying its own code
 * rather than the generic CONFLICT. Matching on a message string is brittle -
 * it breaks the moment the wording is improved or translated.
 */
export const codedConflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const serviceUnavailable = (message: string) =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);
