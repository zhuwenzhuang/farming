import { installNativeBrowserFileSelectionGuard } from './native-browser-file-selection'

if (typeof document !== 'undefined') {
  installNativeBrowserFileSelectionGuard(document)
}
