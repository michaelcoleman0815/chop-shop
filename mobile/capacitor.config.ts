/// <reference types="@capacitor/keyboard" />
import type { CapacitorConfig } from '@capacitor/cli'
import { KeyboardResize } from '@capacitor/keyboard'

/**
 * Cutalong on iPhone and Android. The page is the same React app as the
 * Mac's, built from src/renderer/src/cutalong by vite.config.ts into dist.
 * The desktop app keeps its own id (social.brewed.chopshop).
 */
const config: CapacitorConfig = {
  appId: 'social.brewed.cutalong',
  appName: 'Cutalong',
  webDir: 'dist',
  ios: {
    // The page keeps clear of the notch and the home indicator itself, with env(safe-area-inset-*).
    contentInset: 'never'
  },
  plugins: {
    Keyboard: {
      // The page shrinks to the space above the keyboard, so the composer is never under it.
      resize: KeyboardResize.Native,
      resizeOnFullScreen: true
    },
    SystemBars: {
      // Edge to edge, with the insets in env() and in --safe-area-inset-* where env() has none.
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover'
    }
  }
}

export default config
