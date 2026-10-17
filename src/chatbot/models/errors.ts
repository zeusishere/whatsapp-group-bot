/**
 * An error with a stable, machine-readable code. The code ends up in
 * `ConversationTurn.error_details.error_code`, so dashboards can group failures without parsing
 * messages.
 */
export class CodedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CodedError';
  }
}

export const errorCode = (e: unknown): string =>
  e instanceof CodedError ? e.code : typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'UNEXPECTED_ERROR';

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
