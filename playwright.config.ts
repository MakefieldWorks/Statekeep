import { defineConfig } from '@playwright/test'

// Each E2E test launches Electron. On macOS, keep its native windows out of the
// foreground by default; set STATEKEEP_E2E_VISIBLE=1 to watch a run. Windows and
// Linux render never-shown windows so slowly that UI tests hit their timeouts
// (on Windows, snapshot tests took 30s+ hidden vs ~4s visible), so they default
// to visible windows. STATEKEEP_E2E_BACKGROUND=1 still forces hidden mode.
process.env['STATEKEEP_E2E_BACKGROUND'] = process.env['STATEKEEP_E2E_VISIBLE'] === '1'
  ? '0'
  : (process.env['STATEKEEP_E2E_BACKGROUND'] ?? (process.platform === 'darwin' ? '1' : '0'))

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  // Windows CI runners can be much slower when Electron, SQLite, and the UI
  // share a busy host. Keep local and macOS failures fast while allowing the
  // Windows pilot run enough time for real UI work to complete.
  timeout: process.env['CI'] && process.platform === 'win32' ? 90_000 : 30_000,
  expect: {
    timeout: process.env['CI'] && process.platform === 'win32' ? 15_000 : 5_000,
  },
  forbidOnly: !!process.env['CI'],
  reporter: 'list',
  outputDir: '.playwright-artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
})
