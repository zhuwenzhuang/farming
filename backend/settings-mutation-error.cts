interface ErrorRecord extends Error {
  code?: string;
  status?: number;
  statusCode?: number;
}

export class SettingsMutationResponseError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SettingsMutationResponseError';
    this.code = code;
    this.status = status;
  }
}

export function caughtError(value: unknown): ErrorRecord {
  if (value instanceof Error) return value as ErrorRecord;
  const normalized = new Error(String(value)) as ErrorRecord;
  if (value && typeof value === 'object') Object.assign(normalized, value);
  return normalized;
}

export function responseError(
  caught: unknown,
  fallbackMessage: string,
  fallbackCode: string,
  fallbackStatus: number,
): SettingsMutationResponseError {
  const error = caughtError(caught);
  const status = Number(error.status || error.statusCode);
  return new SettingsMutationResponseError(
    error.message || fallbackMessage,
    error.code || fallbackCode,
    Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallbackStatus,
    { cause: caught },
  );
}
