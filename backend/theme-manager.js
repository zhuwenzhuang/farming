const fs = require('fs');
const path = require('path');
const storageLayout = require('./storage-layout');

class ThemeManager {
  constructor(options = {}) {
    this.themesPath = path.join(__dirname, '../frontend/themes');
    this.farmingDir = options.configDir || storageLayout.farmingConfigDir();
    this.themeSettingsFile = storageLayout.themeSettingsFile(this.farmingDir);
    this.availableThemes = this.loadAvailableThemes();
    this.userThemeSettings = this.loadUserThemeSettings();
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
    
    this.userThemeSettings[themeId] = {
      ...this.userThemeSettings[themeId],
      ...settings
    };
    
    this.saveUserThemeSettings();
    return true;
  }
}

module.exports = ThemeManager;
