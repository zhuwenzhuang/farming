interface BrowserResourceManagerConstructor {
  new(options: Record<string, unknown>): unknown;
}

import { BrowserResourceManager } from './browser-resource-manager.cjs';
import { createBrowserRouter } from './browser-router.cjs';
import { DesktopBrowserAdapterRegistry } from './desktop-browser-adapter.cjs';

export {
  BrowserResourceManager,
  createBrowserRouter,
  DesktopBrowserAdapterRegistry,
};
