/** Thrown for malformed client input. The API layer maps it to `400 validation_failed`. */
export class ValidationError extends Error {
  readonly code = 'validation_failed' as const;
  readonly status = 400 as const;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}
