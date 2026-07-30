const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
import * as storageLayout from './storage-layout.cjs';

type ThemeSettings = Record<string, unknown>;

interface ThemeConfig extends Record<string, unknown> {
  defaultSettings?: ThemeSettings;
  id: string;
}

interface ThemeManagerOptions {
  configDir?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

class ThemeManager {
  themesPath: string;
  farmingDir: string;
  themeSettingsFile: string;
  availableThemes: ThemeConfig[];
  userThemeSettings: Record<string, ThemeSettings>;

  constructor(options: ThemeManagerOptions = {}) {
    this.themesPath = path.join(__dirname, '../frontend/themes');
    this.farmingDir = options.configDir || storageLayout.farmingConfigDir();
    this.themeSettingsFile = storageLayout.themeSettingsFile(this.farmingDir);
    this.availableThemes = this.loadAvailableThemes();
    const loadedThemeSettings = this.loadUserThemeSettings();
    this.userThemeSettings = this.normalizeUserThemeSettings(loadedThemeSettings);
    if (JSON.stringify(this.userThemeSettings) !== JSON.stringify(loadedThemeSettings)) {
      this.saveUserThemeSettings();
    }
  }
  
  loadAvailableThemes(): ThemeConfig[] {
    const themes: ThemeConfig[] = [];
    
    try {
      const themeDirs: string[] = fs.readdirSync(this.themesPath);
      
      themeDirs.forEach(dir => {
        const themePath = path.join(this.themesPath, dir, 'theme.json');
        
        if (fs.existsSync(themePath)) {
          try {
            const parsedThemeConfig: unknown = JSON.parse(fs.readFileSync(themePath, 'utf8'));
            const themeConfig = isObject(parsedThemeConfig) ? parsedThemeConfig : {};
            themes.push({
              id: dir,
              ...themeConfig
            });
          } catch (error: unknown) {
            console.error(`Failed to load theme ${dir}:`, errorMessage(error));
          }
        }
      });
    } catch (error: unknown) {
      console.error('Failed to load themes:', errorMessage(error));
    }
    
    return themes;
  }
  
  loadUserThemeSettings(): unknown {
    try {
      if (fs.existsSync(this.themeSettingsFile)) {
        return JSON.parse(fs.readFileSync(this.themeSettingsFile, 'utf8'));
      }
    } catch (error: unknown) {
      console.error('Failed to load user theme settings:', errorMessage(error));
    }
    return {};
  }

  normalizeThemeSettings(settings: unknown): ThemeSettings {
    const normalized: ThemeSettings = {};
    let current: unknown = settings;
    let depth = 0;

    while (isObject(current) && depth < 20) {
      Object.entries(current).forEach(([key, value]) => {
        if (key !== 'settings' && normalized[key] === undefined) {
          normalized[key] = value;
        }
      });
      current = current.settings;
      depth += 1;
    }

    return normalized;
  }

  normalizeUserThemeSettings(settings: unknown): Record<string, ThemeSettings> {
    if (!isObject(settings)) return {};
    return Object.fromEntries(Object.entries(settings).map(([themeId, value]) => (
      [themeId, this.normalizeThemeSettings(value)]
    )));
  }
  
  saveUserThemeSettings(settings: Record<string, ThemeSettings> = this.userThemeSettings): boolean {
    let temporaryFile = '';
    try {
      if (!fs.existsSync(this.farmingDir)) {
        fs.mkdirSync(this.farmingDir, { recursive: true });
      }
      temporaryFile = `${this.themeSettingsFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(temporaryFile, JSON.stringify(settings, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporaryFile, this.themeSettingsFile);
      return true;
    } catch (error: unknown) {
      console.error('Failed to save user theme settings:', errorMessage(error));
      return false;
    } finally {
      if (temporaryFile) {
        try {
          fs.unlinkSync(temporaryFile);
        } catch {
          // A successful rename already removed the temporary path.
        }
      }
    }
  }
  
  getTheme(themeId: string): ThemeConfig | undefined {
    return this.availableThemes.find(t => t.id === themeId);
  }
  
  getAllThemes(): ThemeConfig[] {
    return this.availableThemes;
  }
  
  getThemeCSS(themeId: string): string | null {
    const theme = this.getTheme(themeId);
    if (!theme) {
      return null;
    }
    
    const cssPath = path.join(this.themesPath, themeId, 'style.css');
    
    if (fs.existsSync(cssPath)) {
      return fs.readFileSync(cssPath, 'utf8');
    }
    
    return null;
  }
  
  getThemeSettings(themeId: string): ThemeSettings {
    const theme = this.getTheme(themeId);
    if (!theme) {
      return {};
    }
    
    const defaultSettings = theme.defaultSettings || {};
    const userOverrides = this.userThemeSettings[themeId] || {};
    
    return { ...defaultSettings, ...userOverrides };
  }
  
  updateThemeSettings(themeId: string, settings: unknown): boolean {
    const theme = this.getTheme(themeId);
    if (!theme) {
      return false;
    }
    
    const normalizedSettings = this.normalizeThemeSettings(settings);
    const nextUserThemeSettings = {
      ...this.userThemeSettings[themeId],
      ...normalizedSettings
    };
    const nextSettings = {
      ...this.userThemeSettings,
      [themeId]: nextUserThemeSettings,
    };
    if (!this.saveUserThemeSettings(nextSettings)) return false;
    this.userThemeSettings = nextSettings;
    return true;
  }
}

export { ThemeManager };
