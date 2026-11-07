// Renders an SVG to a square PNG with its transparency intact, using the
// Chromium that Playwright installs for the E2E tests. Quick Look
// (qlmanage) composites onto opaque white, which breaks the icon's
// transparent margins.
// Usage: node scripts/render_svg_png.mjs <input.svg> <output.png> <size>
// Set CHROMIUM_PATH to use a Chromium other than Playwright's own download.
import { readFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const [input, output, sizeArg] = process.argv.slice(2)
const size = Number(sizeArg)
if (!input || !output || !Number.isInteger(size) || size <= 0) {
  console.error('Usage: node scripts/render_svg_png.mjs <input.svg> <output.png> <size>')
  process.exit(1)
}

const svg = readFileSync(input, 'utf8')
let browser
try {
  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
  )
} catch (error) {
  // The E2E tests drive Electron, so a normal `bun install` doesn't download
  // Playwright's Chromium. Say how to get it instead of printing a stack trace.
  console.error(
    'Could not start Chromium to render the icon.\n' +
      'Install the browser Playwright expects with `bunx playwright install chromium`,\n' +
      'or set CHROMIUM_PATH to an existing Chromium or Chrome executable.\n\n' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error))
  )
  process.exit(1)
}
try {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 })
  await page.setContent(
    '<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' + svg
  )
  await page.screenshot({ path: output, omitBackground: true })
} finally {
  await browser.close()
}
