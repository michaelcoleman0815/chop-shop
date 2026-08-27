import type { ChopApi } from './index'

declare global {
  interface Window {
    chop: ChopApi
  }
}

export {}
