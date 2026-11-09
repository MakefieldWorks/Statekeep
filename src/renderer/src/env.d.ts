/// <reference types="svelte" />

import type { StatekeepAPI } from '../../shared/ipc'

declare global {
  interface Window {
    api: StatekeepAPI
  }
}

export {}
