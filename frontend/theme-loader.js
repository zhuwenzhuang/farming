let currentTheme = 'terminal';

async function loadTheme(themeId) {
  try {
    const response = await fetch(`/api/themes/${themeId}`);
    const data = await response.json();
    
    if (data.css) {
      // 移除旧主题样式
      const oldStyle = document.getElementById('theme-style');
      if (oldStyle) {
        oldStyle.remove();
      }
      
      // 添加新主题样式
      const styleElement = document.createElement('style');
      styleElement.id = 'theme-style';
      styleElement.textContent = data.css;
      document.head.appendChild(styleElement);
      
      currentTheme = themeId;
      console.log('Theme loaded:', themeId);
    }
  } catch (error) {
    console.error('Failed to load theme:', error);
  }
}

async function getAllThemes() {
  try {
    const response = await fetch('/api/themes');
    return await response.json();
  } catch (error) {
    console.error('Failed to get themes:', error);
    return { themes: [], current: 'terminal' };
  }
}

async function setTheme(themeId) {
  try {
    const response = await fetch(`/api/themes/${themeId}/set`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    
    if (data.success) {
      await loadTheme(themeId);
      return true;
    }
  } catch (error) {
    console.error('Failed to set theme:', error);
  }
  
  return false;
}

// 初始化时加载当前主题
async function initTheme() {
  const themesData = await getAllThemes();
  if (themesData.current) {
    await loadTheme(themesData.current);
  }
}

module.exports = {
  loadTheme,
  getAllThemes,
  setTheme,
  initTheme,
  getCurrentTheme: () => currentTheme
};