interface BrowserResourceManagerConstructor {
  new(options: Record<string, unknown>): unknown;
}

const { BrowserResourceManager } = require('./browser-resource-manager.cjs') as {
  BrowserResourceManager: BrowserResourceManagerConstructor;
};
import { createBrowserRouter } from './browser-router.cjs';

export {
  BrowserResourceManager,
  createBrowserRouter,
};
