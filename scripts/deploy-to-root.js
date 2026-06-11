// scripts/deploy-to-root.js
// Copies Vite build output to repo root for GitHub Pages
// Preserves ble-client.js, sw.js, and other existing files

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const distDir = path.join(repoRoot, 'dist')

// Files to always preserve (don't overwrite from dist)
const preserve = new Set([
  'ble-client.js',
  'sw.js',
  'Sortable.min.js',
])

if (!fs.existsSync(distDir)) {
  console.error('dist/ not found — run "npm run build" first')
  process.exit(1)
}

const distFiles = fs.readdirSync(distDir)

let copied = 0
for (const file of distFiles) {
  if (file === 'assets') continue // handled separately
  if (preserve.has(file)) {
    console.log(`  preserved: ${file}`)
    continue
  }
  const src = path.join(distDir, file)
  const dest = path.join(repoRoot, file)
  fs.copyFileSync(src, dest)
  console.log(`  copied:   ${file}`)
  copied++
}

// Copy assets directory
const srcAssets = path.join(distDir, 'assets')
const destAssets = path.join(repoRoot, 'assets')
if (fs.existsSync(srcAssets)) {
  if (!fs.existsSync(destAssets)) {
    fs.mkdirSync(destAssets, { recursive: true })
  }
  for (const file of fs.readdirSync(srcAssets)) {
    fs.copyFileSync(path.join(srcAssets, file), path.join(destAssets, file))
    console.log(`  copied:   assets/${file}`)
    copied++
  }
}

console.log(`\nDone — ${copied} files copied to repo root`)
