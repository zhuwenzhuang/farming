declare global {
  interface Window {
    farmingDesktop?: import('../../shared/desktop-contract').FarmingDesktopBridge
  }
}

export {}
