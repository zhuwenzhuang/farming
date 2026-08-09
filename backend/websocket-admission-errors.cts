interface ErrorClient {
  readyState: number;
  send(data: string): void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function reportWebSocketAdmissionFailure(
  client: ErrorClient,
  error: unknown,
  options: { openState: number; fallbackMessage: string },
): boolean {
  if (client.readyState !== options.openState) return false;
  try {
    client.send(JSON.stringify({
      type: 'error',
      message: errorMessage(error, options.fallbackMessage),
    }));
    return true;
  } catch {
    // A socket may close between the readyState check and send. The rejected
    // admission is already terminal and must not create a second rejection.
    return false;
  }
}

export { reportWebSocketAdmissionFailure };
