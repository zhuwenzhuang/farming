import { validReadOnlyShareHours } from '../shared/read-only-share-duration.js';
import { defaultBrowserComputerSettings } from './browser-computer-settings.cjs';
import { BrowserComputerSettingsLifecycle, type BrowserComputerRuntimePorts } from './browser-computer-settings-lifecycle.cjs';
import { SettingsMutationResponseError, caughtError, responseError } from './settings-mutation-error.cjs';
const express = require('express');

interface ExpressRequest {
  body?: unknown;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface SettingsRecord {
  [key: string]: unknown;
  agentHomes?: unknown;
  languageServerEnabled?: unknown;
}

interface SettingsMutationPorts extends BrowserComputerRuntimePorts {
  getSettings(): SettingsRecord;
  invalidateAgentExtensionInventory(): void;
  invalidateAgentSessionInventory(): void;
  normalizeAgentHomes(value: unknown): SettingsRecord['agentHomes'];
  publishSettingsMetadata(): void;
  stopAllLanguageServers(): Promise<unknown>;
  updateSettings(patch: SettingsRecord): void;
}

interface SettingsMutationResult {
  settings: SettingsRecord;
  success: true;
}

const expressFactory = express as ExpressFactory;
const PROTECTED_SETTINGS_KEYS = [
  'mainPageSessionKeys',
  'projectWorkspaces',
  'pinnedProjectWorkspaces',
] as const;

function owns(record: SettingsRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

class SettingsMutationCoordinator {
  private readonly ports: SettingsMutationPorts;
  private readonly browserComputer: BrowserComputerSettingsLifecycle;

  constructor(ports: SettingsMutationPorts) {
    this.ports = ports;
    this.browserComputer = new BrowserComputerSettingsLifecycle(ports);
  }

  async mutate(rawPatch: unknown): Promise<SettingsMutationResult> {
    const settingsPatch: SettingsRecord = rawPatch && typeof rawPatch === 'object'
      ? { ...(rawPatch as Record<string, unknown>) }
      : {};
    if (owns(settingsPatch, 'readOnlyShareHours') && !validReadOnlyShareHours(settingsPatch.readOnlyShareHours)) {
      throw new SettingsMutationResponseError('Read-only share duration must be an integer from 1 to 168 hours.', 'INVALID_SHARE_DURATION', 400);
    }
    PROTECTED_SETTINGS_KEYS.forEach(key => delete settingsPatch[key]);
    const currentSettings = this.ports.getSettings();
    const changesAgentHomes = owns(settingsPatch, 'agentHomes');
    if (changesAgentHomes) {
      try {
        settingsPatch.agentHomes = this.ports.normalizeAgentHomes(settingsPatch.agentHomes);
      } catch (caught) {
        throw responseError(
          caught,
          'Agent Home configuration is invalid',
          'AGENT_HOME_INVALID',
          400,
        );
      }
    }

    const commit = async () => {
      this.commitSettings(settingsPatch);
      if (
        owns(settingsPatch, 'languageServerEnabled')
        && currentSettings.languageServerEnabled !== false
        && settingsPatch.languageServerEnabled !== true
      ) {
        await this.ports.stopAllLanguageServers();
      }
    };
    if (Object.keys(settingsPatch).some(key => Object.hasOwn(defaultBrowserComputerSettings, key))) {
      await this.browserComputer.apply(currentSettings, settingsPatch, commit);
    } else {
      await commit();
    }
    if (changesAgentHomes) {
      this.ports.invalidateAgentSessionInventory();
      this.ports.invalidateAgentExtensionInventory();
    }
    return { success: true, settings: this.ports.getSettings() };
  }

  private commitSettings(settingsPatch: SettingsRecord) {
    try {
      this.ports.updateSettings(settingsPatch);
    } catch (caught) {
      const error = caughtError(caught);
      if (error.code?.startsWith('AGENT_HOME_')) {
        throw responseError(
          caught,
          'Agent Home configuration conflicts with persisted Agent metadata',
          error.code,
          409,
        );
      }
      throw caught;
    }
  }
}

function createSettingsMutationRouter(ports: SettingsMutationPorts): ExpressRouter {
  const router = expressFactory.Router();
  const coordinator = new SettingsMutationCoordinator(ports);
  router.post('/', expressFactory.json(), async (req, res) => {
    try {
      res.json(await coordinator.mutate(req.body));
      ports.publishSettingsMetadata();
    } catch (caught) {
      if (!(caught instanceof SettingsMutationResponseError)) throw caught;
      res.status(caught.status).json({ error: caught.message, code: caught.code });
    }
  });
  return router;
}

export {
  SettingsMutationCoordinator,
  SettingsMutationResponseError,
  createSettingsMutationRouter,
  type SettingsMutationPorts,
  type SettingsMutationResult,
};
