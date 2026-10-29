/** Structured API error. `code` is stable for clients; `message` is user-facing and actionable. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = "Please sign in to continue.") =>
  new ApiError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have access to this resource.") =>
  new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new ApiError(422, code, message, details);
