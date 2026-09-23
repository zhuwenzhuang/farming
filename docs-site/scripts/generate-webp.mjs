import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const publicRoot = path.join(repositoryRoot, 'docs-site/public')
const generatorModified = (await stat(new URL(import.meta.url))).mtimeMs
const readmeImages = [
  'public/farming-2/app-icon-v2-512.png',
  'docs/products/code/assets/01-code-workspace.png',
  'docs/products/code/assets/02-start-agent-picker.png',
  'docs/products/code/assets/11-code-agent-process.png',
  'docs/products/code/assets/14-code-settings.png',
  'docs/products/crt/assets/01-crt-dashboard.png',
]

async function pngFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await pngFiles(file))
    else if (entry.name.endsWith('.png') && entry.name !== 'farming-favicon.png') files.push(file)
  }
  return files
}

async function isCurrent(source, output) {
  try {
    return (await stat(output)).mtimeMs >= Math.max((await stat(source)).mtimeMs, generatorModified)
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function generate(source) {
  const output = source.replace(/\.png$/, '.webp')
  if (await isCurrent(source, output)) return false
  await sharp(source).webp({ quality: 95, effort: 6, smartSubsample: true }).toFile(output)
  return true
}

const readmeMode = process.argv.includes('--readme')
const sources = readmeMode
  ? readmeImages.map(file => path.join(repositoryRoot, file))
  : await pngFiles(publicRoot)
let generated = 0
for (const source of sources) {
  if (await generate(source)) generated++
}

if (!readmeMode) {
  const icon = path.join(publicRoot, 'farming-icon.png')
  const favicon = path.join(publicRoot, 'farming-favicon.png')
  if (!await isCurrent(icon, favicon)) {
    await sharp(icon).resize(48, 48).png({ compressionLevel: 9 }).toFile(favicon)
    generated++
  }
}

console.log(`Generated ${generated} ${readmeMode ? 'README' : 'site'} display images.`)
