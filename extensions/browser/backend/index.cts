interface BrowserResourceManagerConstructor {
  new(options: Record<string, unknown>): unknown;
}

import { BrowserResourceManager } from './browser-resource-manager.cjs';
import { createBrowserRouter } from './browser-router.cjs';

export {
  BrowserResourceManager,
  createBrowserRouter,
};
