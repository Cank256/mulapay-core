import { getErrorDefinition, renderMessage, type ErrorCode } from './catalogue';

export interface AppErrorOptions {
  /** Machine-actionable fields. Returned only if the catalogue marks them safe. */
  readonly details?: Readonly<Record<string, unknown>>;
  readonly messageParams?: Readonly<Record<string, string>>;
  /** Internal cause. Logged, never returned. */
  readonly cause?: unknown;
}

/** An error with a catalogue code. The only error type that reaches clients with detail. */
export class AppError extends Error {
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    readonly code: ErrorCode,
    options: AppErrorOptions = {}
  ) {
    super(renderMessage(getErrorDefinition(code).message, options.messageParams), {
      cause: options.cause,
    });
    this.name = 'AppError';
    this.details = options.details;
  }

  get httpStatus(): number {
    return getErrorDefinition(this.code).httpStatus;
  }
}
