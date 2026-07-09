const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

class ThemeManager {
  constructor(options = {}) {
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
  
  loadAvailableThemes() {
    const themes = [];
    
    try {
      const themeDirs = fs.readdirSync(this.themesPath);
      
      themeDirs.forEach(dir => {
        const themePath = path.join(this.themesPath, dir, 'theme.json');
        
        if (fs.existsSync(themePath)) {
          try {
            const themeConfig = JSON.parse(fs.readFileSync(themePath, 'utf8'));
            themes.push({
              id: dir,
              ...themeConfig
            });
          } catch (error) {
            console.error(`Failed to load theme ${dir}:`, error.message);
          }
        }
      });
    } catch (error) {
      console.error('Failed to load themes:', error.message);
    }
    
    return themes;
  }
  
  loadUserThemeSettings() {
    try {
      if (fs.existsSync(this.themeSettingsFile)) {
        return JSON.parse(fs.readFileSync(this.themeSettingsFile, 'utf8'));
      }
    } catch (error) {
      console.error('Failed to load user theme settings:', error.message);
    }
    return {};
  }

  normalizeThemeSettings(settings) {
    const normalized = {};
    let current = settings;
    let depth = 0;

    while (current && typeof current === 'object' && !Array.isArray(current) && depth < 20) {
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

  normalizeUserThemeSettings(settings) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return {};
    return Object.fromEntries(Object.entries(settings).map(([themeId, value]) => (
      [themeId, this.normalizeThemeSettings(value)]
    )));
  }
  
  saveUserThemeSettings() {
    try {
      if (!fs.existsSync(this.farmingDir)) {
        fs.mkdirSync(this.farmingDir, { recursive: true });
      }
      fs.writeFileSync(this.themeSettingsFile, JSON.stringify(this.userThemeSettings, null, 2));
    } catch (error) {
      console.error('Failed to save user theme settings:', error.message);
    }
  }
  
  getTheme(themeId) {
    return this.availableThemes.find(t => t.id === themeId);
  }
  
  getAllThemes() {
    return this.availableThemes;
  }
  
  getThemeCSS(themeId) {
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
  
  getThemeSettings(themeId) {
    const theme = this.getTheme(themeId);
    if (!theme) {
      return {};
    }
    
    const defaultSettings = theme.defaultSettings || {};
    const userOverrides = this.userThemeSettings[themeId] || {};
    
    return { ...defaultSettings, ...userOverrides };
  }
  
  updateThemeSettings(themeId, settings) {
    const theme = this.getTheme(themeId);
    if (!theme) {
      return false;
    }
    
    const normalizedSettings = this.normalizeThemeSettings(settings);
    this.userThemeSettings[themeId] = {
      ...this.userThemeSettings[themeId],
      ...normalizedSettings
    };
    
    this.saveUserThemeSettings();
    return true;
  }
}

module.exports = ThemeManager;
