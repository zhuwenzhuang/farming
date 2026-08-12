import fs from 'node:fs'
import path from 'node:path'

const siteRoot = path.resolve(import.meta.dirname, '..')
const sourceRoots = ['cn', 'en'].map(locale => path.join(siteRoot, locale))
const publicRoot = path.join(siteRoot, 'public')
const outputRoot = path.join(siteRoot, '.vitepress', 'dist')
const baseMarker = `/${String(process.env.FARMING_DOCS_BASE || '/farming/').replace(/^\/+|\/+$/g, '')}/`
const failures = []

function walk(directory, predicate) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(absolute, predicate)
    return predicate(absolute) ? [absolute] : []
  })
}

for (const sourceRoot of sourceRoots) {
  for (const file of walk(sourceRoot, file => file.endsWith('.md'))) {
    const source = fs.readFileSync(file, 'utf8')
    if (/\.\.\/assets\//.test(source)) {
      failures.push(`${path.relative(siteRoot, file)} uses a relative screenshot path; use the locale's /<locale>/assets/... path`)
    }
    const references = Array.from(source.matchAll(/(?:\]\(|(?:src|light|dark|paper)=['"])(\/[a-z-]+\/assets\/[^)'"\s>]+)/g), match => match[1])
    for (const reference of references) {
      const target = path.join(publicRoot, reference.slice(1))
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(`${path.relative(siteRoot, file)} references missing ${reference}`)
      }
    }
    for (const match of source.matchAll(/<ThemeImage\b[\s\S]*?\/>/g)) {
      for (const appearance of ['light', 'dark', 'paper']) {
        if (!new RegExp(`\\b${appearance}=['"][^'"]+['"]`).test(match[0])) {
          failures.push(`${path.relative(siteRoot, file)} has a ThemeImage without ${appearance}`)
        }
      }
    }
  }
}

for (const sourceRoot of sourceRoots) {
  if (fs.existsSync(path.join(sourceRoot, 'assets'))) {
    failures.push(`${path.basename(sourceRoot)}/assets exists outside public/; screenshots there are omitted from the production build`)
  }
}

if (!fs.existsSync(outputRoot) || !fs.statSync(outputRoot).isDirectory()) {
  failures.push('production output is missing; run npm run build before verify:images')
} else {
  for (const file of walk(outputRoot, file => file.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8')
    for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
      const reference = match[1]
      if (!reference.startsWith(baseMarker)) continue
      const target = path.join(outputRoot, reference.slice(baseMarker.length))
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(`${path.relative(outputRoot, file)} renders missing ${reference}`)
      }
    }
  }
}

if (failures.length) {
  console.error(`Documentation image verification failed (${failures.length}):`)
  failures.forEach(failure => console.error(`- ${failure}`))
  process.exit(1)
}

console.log('Documentation images verified: all source references and rendered assets exist.')
