const express = require('express');

interface ExpressRequest {
  body?: unknown;
  params: Record<string, string>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void;

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface ThemeManagerPort {
  getTheme(themeId: string): unknown;
  getThemeCSS(themeId: string): string | null;
  getThemeSettings(themeId: string): unknown;
  updateThemeSettings(themeId: string, settings: unknown): boolean;
}

type SelectTheme = (themeId: string) => void;

const expressFactory = express as ExpressFactory;

function createThemeRouter(
  themeManager: ThemeManagerPort,
  selectTheme: SelectTheme,
): ExpressRouter {
  const router = expressFactory.Router();

  router.post('/:themeId/set', expressFactory.json(), (req, res) => {
    const theme = themeManager.getTheme(req.params.themeId);
    if (!theme) {
      res.status(404).json({ error: 'Theme not found' });
      return;
    }

    selectTheme(req.params.themeId);
    res.json({ success: true, theme: req.params.themeId });
  });

  router.get('/:themeId/settings', (req, res) => {
    const theme = themeManager.getTheme(req.params.themeId);
    if (!theme) {
      res.status(404).json({ error: 'Theme not found' });
      return;
    }

    const settings = themeManager.getThemeSettings(req.params.themeId);
    res.json({ settings });
  });

  router.post('/:themeId/settings', expressFactory.json(), (req, res) => {
    const theme = themeManager.getTheme(req.params.themeId);
    if (!theme) {
      res.status(404).json({ error: 'Theme not found' });
      return;
    }

    const success = themeManager.updateThemeSettings(req.params.themeId, req.body);
    if (success) {
      res.json({ success: true, settings: themeManager.getThemeSettings(req.params.themeId) });
    } else {
      res.status(500).json({ error: 'Failed to update theme settings' });
    }
  });

  router.get('/:themeId', (req, res) => {
    const theme = themeManager.getTheme(req.params.themeId);
    if (!theme) {
      res.status(404).json({ error: 'Theme not found' });
      return;
    }

    const css = themeManager.getThemeCSS(req.params.themeId);
    res.json({
      theme,
      css,
    });
  });

  return router;
}

export { createThemeRouter, type SelectTheme, type ThemeManagerPort };
