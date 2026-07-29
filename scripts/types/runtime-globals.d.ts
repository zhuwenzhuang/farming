export {};

declare global {
  interface Window {
    __FARMING_E2E__?: boolean;
    __farmingImeReproSetVisualViewport?: (
      next: Partial<{
        width: number;
        height: number;
        offsetTop: number;
        offsetLeft: number;
        pageTop: number;
        pageLeft: number;
        scale: number;
      }>,
      eventNames?: string[],
    ) => object;
    __farmingTerminalTest?: {
      getCellCenter: (agentId: string, row: number, column: number) => unknown;
      isReady: (agentId: string) => boolean;
      writeFixture: (agentId: string, fixture: string) => Promise<void>;
    };
  }
}
