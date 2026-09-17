import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Export the existing vector brand mark, preserving its shape and transparent background.
const publicDir = new URL('../public/', import.meta.url)
const outputDir = new URL('brand/', publicDir)
const source = await readFile(new URL('favicon.svg', publicDir), 'utf8')
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  for (const [variant, color] of [['black', '#000000'], ['white', '#ffffff']]) {
    const svg = source
      .replace(/<style>[\s\S]*?<\/style>/, '')
      .replace('viewBox="0 0 64 64"', 'width="1024" height="1024" viewBox="-8 -8 80 80"')
      .replaceAll('currentColor', color)
    const basename = `rabbit-hole-icon-${variant}`
    await writeFile(new URL(`${basename}.svg`, outputDir), svg)
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`)
    await page.screenshot({ path: fileURLToPath(new URL(`${basename}.png`, outputDir)), omitBackground: true })
  }
} finally {
  await browser.close()
}
