/**
 * ACP terminal resize route handler.
 *
 * Validates cols/rows at the HTTP boundary before forwarding to the
 * AgentManager. Canonical PTY constraints (acp/client-services.cts):
 * cols 2..1000, rows 1..1000, safe integers only.
 */

interface ResizeRequest {
  body: Record<string, unknown>;
  params: Record<string, string>;
}

interface ResizeResponse {
  json(value: unknown): ResizeResponse;
  status(code: number): ResizeResponse;
}

interface ResizeManager {
  resizeAcpTerminal(agentId: string, terminalId: string, cols: number, rows: number): unknown;
}

function caughtMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message || '')
    : '';
}

function createAcpTerminalResizeHandler(manager: ResizeManager) {
  return (req: ResizeRequest, res: ResizeResponse) => {
    try {
      const cols = req.body?.cols;
      const rows = req.body?.rows;
      if (typeof cols !== 'number' || typeof rows !== 'number'
        || !Number.isSafeInteger(cols) || cols < 2 || cols > 1000
        || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
        res.status(400).json({ error: 'cols (2-1000) and rows (1-1000) must be safe integers' });
        return;
      }
      res.json(manager.resizeAcpTerminal(
        req.params.agentId,
        req.params.terminalId,
        cols,
        rows,
      ));
    } catch (caught) {
      const message = caughtMessage(caught) || 'Failed to resize ACP terminal';
      const status = message === 'Agent not found' || message === 'Unknown ACP terminal' ? 404 : 409;
      res.status(status).json({ error: message });
    }
  };
}

export { createAcpTerminalResizeHandler };
export type { ResizeManager, ResizeRequest, ResizeResponse };
