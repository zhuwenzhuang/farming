// Generated from TypeScript. Do not edit.
"use strict";
let currentTheme = 'terminal';
function themeApiPath(path) {
    const runtimePaths = window.FarmingRuntimePaths;
    if (!runtimePaths)
        throw new Error('FarmingRuntimePaths must load before the theme loader');
    return runtimePaths.apiPath(path);
}
async function loadTheme(themeId) {
    try {
        const response = await fetch(themeApiPath(`/themes/${themeId}`));
        const data = await response.json();
        if (data.css) {
            document.getElementById('theme-style')?.remove();
            const styleElement = document.createElement('style');
            styleElement.id = 'theme-style';
            styleElement.textContent = data.css;
            document.head.appendChild(styleElement);
            currentTheme = themeId;
            console.log('Theme loaded:', themeId);
        }
    }
    catch (error) {
        console.error('Failed to load theme:', error);
    }
}
async function getAllThemes() {
    try {
        const response = await fetch(themeApiPath('/themes'));
        return await response.json();
    }
    catch (error) {
        console.error('Failed to get themes:', error);
        return { themes: [], current: 'terminal' };
    }
}
async function setTheme(themeId) {
    try {
        const response = await fetch(themeApiPath(`/themes/${themeId}/set`), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
        });
        const data = await response.json();
        if (data.success) {
            await loadTheme(themeId);
            return true;
        }
    }
    catch (error) {
        console.error('Failed to set theme:', error);
    }
    return false;
}
async function initTheme() {
    const themesData = await getAllThemes();
    if (themesData.current)
        await loadTheme(themesData.current);
}
module.exports = {
    getAllThemes,
    initTheme,
    loadTheme,
    setTheme,
    getCurrentTheme: () => currentTheme,
};
