declare const module: { exports: Record<string, unknown> };

interface ThemeConfig {
  id?: string
  name?: string
  [key: string]: unknown
}

interface ThemesResponse {
  current: string
  themes: ThemeConfig[]
}

interface ThemeCssResponse {
  css?: string
}

interface SetThemeResponse {
  success?: boolean
}

interface FarmingRuntimePaths {
  apiPath(path: string): string
}

type ThemeWindow = Window & { FarmingRuntimePaths?: FarmingRuntimePaths }

let currentTheme = 'terminal'

function themeApiPath(path: string) {
  const runtimePaths = (window as ThemeWindow).FarmingRuntimePaths
  return runtimePaths
    ? runtimePaths.apiPath(path)
    : `/api${path}`
}

async function loadTheme(themeId: string): Promise<void> {
  try {
    const response = await fetch(themeApiPath(`/themes/${themeId}`))
    const data = await response.json() as ThemeCssResponse

    if (data.css) {
      document.getElementById('theme-style')?.remove()

      const styleElement = document.createElement('style')
      styleElement.id = 'theme-style'
      styleElement.textContent = data.css
      document.head.appendChild(styleElement)

      currentTheme = themeId
      console.log('Theme loaded:', themeId)
    }
  } catch (error) {
    console.error('Failed to load theme:', error)
  }
}

async function getAllThemes(): Promise<ThemesResponse> {
  try {
    const response = await fetch(themeApiPath('/themes'))
    return await response.json() as ThemesResponse
  } catch (error) {
    console.error('Failed to get themes:', error)
    return { themes: [], current: 'terminal' }
  }
}

async function setTheme(themeId: string): Promise<boolean> {
  try {
    const response = await fetch(themeApiPath(`/themes/${themeId}/set`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    const data = await response.json() as SetThemeResponse

    if (data.success) {
      await loadTheme(themeId)
      return true
    }
  } catch (error) {
    console.error('Failed to set theme:', error)
  }

  return false
}

async function initTheme(): Promise<void> {
  const themesData = await getAllThemes()
  if (themesData.current) await loadTheme(themesData.current)
}

module.exports = {
  getAllThemes,
  initTheme,
  loadTheme,
  setTheme,
  getCurrentTheme: () => currentTheme,
}
