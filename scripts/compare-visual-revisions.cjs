#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PNG } = require('playwright-core/lib/utilsBundle')
const { compare } = require('playwright-core/lib/server/utils/image_tools/compare')

const projectRoot = path.resolve(__dirname, '..')
const captureSpecPath = path.join(projectRoot, 'tests', 'e2e', 'visual-regression.spec.ts')
const instabilityRatioLimit = 0.001

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--self-test') {
      values.set('selfTest', '1')
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`)
    values.set(argument.slice(2), value)
    index += 1
  }
  return values
}

function requiredArgument(args, name) {
  const value = args.get(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function readScenarioNames(specPath) {
  if (!fs.existsSync(specPath)) return []
  const source = fs.readFileSync(specPath, 'utf8')
  const declaration = source.match(/export const VISUAL_SCENARIOS\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!declaration) throw new Error(`VISUAL_SCENARIOS is missing from ${specPath}`)
  return Array.from(declaration[1].matchAll(/'([^']+)'/g), match => match[1])
}

function ensureEmptyDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })
}

function runProcess(command, arguments_, options) {
  return new Promise(resolve => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      const text = String(chunk)
      output += text
      process.stdout.write(text)
    })
    child.stderr.on('data', chunk => {
      const text = String(chunk)
      output += text
      process.stderr.write(text)
    })
    child.on('error', error => resolve({ code: 1, output: `${output}\n${error.stack || error.message}` }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

async function captureRevision({ label, targetRoot, outputDir, logsDir, chromiumPath, specPath }) {
  const playwrightCli = path.join(targetRoot, 'node_modules', '@playwright', 'test', 'cli.js')
  if (!fs.existsSync(playwrightCli)) {
    return {
      attempts: 0,
      error: `${label} dependencies are missing: ${playwrightCli}`,
    }
  }
  const temporarySpecPath = path.join(
    targetRoot,
    'tests',
    'e2e',
    `.farming-visual-regression-${process.pid}.spec.ts`,
  )
  fs.copyFileSync(specPath, temporarySpecPath)
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      ensureEmptyDirectory(outputDir)
      const result = await runProcess(process.execPath, [
        playwrightCli,
        'test',
        path.relative(targetRoot, temporarySpecPath),
        '--project=chromium',
        '--workers=1',
        '--retries=0',
        '--reporter=line',
      ], {
        cwd: targetRoot,
        env: {
          ...process.env,
          CI: '',
          FARMING_PLAYWRIGHT_CHROME_PATH: chromiumPath,
          FARMING_VISUAL_OUTPUT_DIR: outputDir,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TZ: 'UTC',
        },
      })
      fs.writeFileSync(path.join(logsDir, `${label}-attempt-${attempt}.log`), result.output)
      if (result.code === 0) return { attempts: attempt, error: null }
    }
    return {
      attempts: 2,
      error: `${label} capture failed twice; inspect logs/${label}-attempt-*.log`,
    }
  } finally {
    fs.rmSync(temporarySpecPath, { force: true })
  }
}

function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath))
}

function comparePngFiles(actualPath, expectedPath, diffPath) {
  const actual = readPng(actualPath)
  const expected = readPng(expectedPath)
  if (actual.width !== expected.width || actual.height !== expected.height) {
    return {
      dimensionMismatch: true,
      actual: { width: actual.width, height: actual.height },
      expected: { width: expected.width, height: expected.height },
      changedPixels: null,
      ratio: null,
    }
  }
  const diff = Buffer.alloc(actual.width * actual.height * 4)
  const changedPixels = compare(actual.data, expected.data, diff, actual.width, actual.height, {
    maxColorDeltaE94: 1,
  })
  if (diffPath) {
    const image = new PNG({ width: actual.width, height: actual.height })
    image.data = diff
    fs.writeFileSync(diffPath, PNG.sync.write(image))
  }
  return {
    dimensionMismatch: false,
    actual: { width: actual.width, height: actual.height },
    expected: { width: expected.width, height: expected.height },
    changedPixels,
    ratio: changedPixels / (actual.width * actual.height),
  }
}

function copyFirstCapture(captureDir, reportDir, scenario) {
  const source = path.join(captureDir, `${scenario}.1.png`)
  const target = path.join(reportDir, `${scenario}.png`)
  if (fs.existsSync(source)) fs.copyFileSync(source, target)
  return source
}

function formatRatio(value) {
  return value === null ? 'n/a' : `${(value * 100).toFixed(4)}%`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function buildSummary(manifest) {
  const lines = [
    '# Farming PR visual comparison',
    '',
    `- Result: **${manifest.status === 'passed' ? 'report generated' : 'capture contract failed'}**`,
    `- Base: \`${manifest.baseSha}\``,
    `- Head: \`${manifest.headSha}\``,
    `- Chromium: \`${manifest.chromiumVersion || manifest.chromiumPath}\``,
    `- Changed scenes: **${manifest.scenarios.filter(scene => scene.status === 'changed').length}/${manifest.scenarios.length}**`,
    '',
    '| Scene | Result | Changed pixels | Diff ratio | Base stability | Head stability |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  ]
  for (const scene of manifest.scenarios) {
    lines.push(`| ${scene.name} | ${scene.status} | ${scene.changedPixels ?? 'n/a'} | ${formatRatio(scene.diffRatio)} | ${formatRatio(scene.baseStabilityRatio)} | ${formatRatio(scene.headStabilityRatio)} |`)
  }
  if (manifest.failures.length > 0) {
    lines.push('', '## Blocking capture failures', '')
    manifest.failures.forEach(failure => lines.push(`- ${failure}`))
  }
  lines.push('', 'Pixel changes are evidence only and do not fail this check. Download the visual-diff artifact and open `index.html` for base/head/diff images.')
  return `${lines.join('\n')}\n`
}

function buildHtml(manifest) {
  const imageFigure = (scene, side, label) => scene[`has${side}`]
    ? `<figure><figcaption>${label}</figcaption><img src="${side.toLowerCase()}/${encodeURIComponent(scene.name)}.png" alt="${escapeHtml(scene.name)} ${label.toLowerCase()}"></figure>`
    : `<figure class="missing"><figcaption>${label}</figcaption><p>Not present at this revision.</p></figure>`
  const cards = manifest.scenarios.map(scene => `
    <section class="scene ${escapeHtml(scene.status)}">
      <header>
        <h2>${escapeHtml(scene.name)}</h2>
        <p>${escapeHtml(scene.status)} · ${escapeHtml(formatRatio(scene.diffRatio))} changed</p>
      </header>
      <div class="images">
        ${imageFigure(scene, 'Base', 'Base')}
        ${imageFigure(scene, 'Head', 'Head')}
        ${imageFigure(scene, 'Diff', 'Diff')}
      </div>
    </section>
  `).join('\n')
  const failures = manifest.failures.length > 0
    ? `<section class="failures"><h2>Capture contract failures</h2><ul>${manifest.failures.map(failure => `<li>${escapeHtml(failure)}</li>`).join('')}</ul></section>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Farming visual comparison</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: #11151b; color: #eef2f7; }
    main { max-width: 1800px; margin: 0 auto; }
    code { color: #a9c7ff; }
    .meta, .scene, .failures { background: #1a2029; border: 1px solid #343d4a; border-radius: 12px; margin: 0 0 20px; padding: 16px; }
    .scene header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .scene h2, .scene p { margin: 0 0 12px; }
    .changed header p { color: #ffd479; }
    .unchanged header p { color: #86d993; }
    .failed header p, .failures { color: #ff9e9e; }
    .images { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    figure { margin: 0; min-width: 0; }
    figcaption { margin-bottom: 6px; color: #bdc7d6; }
    img { display: block; width: 100%; height: auto; background: #fff; border: 1px solid #46515f; border-radius: 6px; }
    figure.missing p { display: grid; min-height: 160px; margin: 0; place-items: center; border: 1px dashed #46515f; border-radius: 6px; color: #98a4b5; }
    @media (max-width: 900px) { .images { grid-template-columns: 1fr; } }
  </style>
</head>
<body><main>
  <section class="meta">
    <h1>Farming PR visual comparison</h1>
    <p>Base <code>${escapeHtml(manifest.baseSha)}</code> · Head <code>${escapeHtml(manifest.headSha)}</code></p>
    <p>Pixel changes are reported for review and do not fail CI. Missing, deleted, dimension-mismatched, or visibly unstable captures do fail.</p>
  </section>
  ${failures}
  ${cards}
</main></body>
</html>`
}

function chromiumVersion(chromiumPath) {
  const result = spawnSync(chromiumPath, ['--version'], { encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout).trim() : ''
}

function writeReport({ reportRoot, scenarios, baseScenarios, headScenarios, baseCaptureDir, headCaptureDir, baseSha, headSha, chromiumPath, captureResults, initialFailures }) {
  const baseReportDir = path.join(reportRoot, 'base')
  const headReportDir = path.join(reportRoot, 'head')
  const diffReportDir = path.join(reportRoot, 'diff')
  ;[baseReportDir, headReportDir, diffReportDir].forEach(directory => fs.mkdirSync(directory, { recursive: true }))
  const failures = [...initialFailures]
  const results = []

  for (const scenario of scenarios) {
    const expectedAtBase = baseScenarios.includes(scenario)
    const expectedAtHead = headScenarios.includes(scenario)
    const baseFirst = copyFirstCapture(baseCaptureDir, baseReportDir, scenario)
    const headFirst = copyFirstCapture(headCaptureDir, headReportDir, scenario)
    const baseSecond = path.join(baseCaptureDir, `${scenario}.2.png`)
    const headSecond = path.join(headCaptureDir, `${scenario}.2.png`)
    const requiredFiles = [
      ...(expectedAtBase ? [baseFirst, baseSecond] : []),
      ...(expectedAtHead ? [headFirst, headSecond] : []),
    ]
    const missingFiles = requiredFiles.filter(filePath => !fs.existsSync(filePath))
    if (missingFiles.length > 0) {
      failures.push(`${scenario}: missing ${missingFiles.map(filePath => path.basename(filePath)).join(', ')}`)
      results.push({
        name: scenario,
        status: 'failed',
        changedPixels: null,
        diffRatio: null,
        baseStabilityRatio: null,
        headStabilityRatio: null,
        hasBase: fs.existsSync(baseFirst),
        hasHead: fs.existsSync(headFirst),
        hasDiff: false,
      })
      continue
    }

    const baseStability = expectedAtBase ? comparePngFiles(baseSecond, baseFirst, null) : null
    const headStability = expectedAtHead ? comparePngFiles(headSecond, headFirst, null) : null
    if (baseStability?.dimensionMismatch || headStability?.dimensionMismatch) {
      failures.push(`${scenario}: consecutive captures changed dimensions`)
    }
    if (baseStability && (baseStability.ratio ?? 1) > instabilityRatioLimit) {
      failures.push(`${scenario}: base capture instability ${formatRatio(baseStability.ratio)} exceeds ${formatRatio(instabilityRatioLimit)}`)
    }
    if (headStability && (headStability.ratio ?? 1) > instabilityRatioLimit) {
      failures.push(`${scenario}: head capture instability ${formatRatio(headStability.ratio)} exceeds ${formatRatio(instabilityRatioLimit)}`)
    }

    if (!expectedAtBase || !expectedAtHead) {
      results.push({
        name: scenario,
        status: expectedAtHead ? 'added' : 'failed',
        changedPixels: null,
        diffRatio: null,
        baseStabilityRatio: baseStability?.ratio ?? null,
        headStabilityRatio: headStability?.ratio ?? null,
        hasBase: expectedAtBase,
        hasHead: expectedAtHead,
        hasDiff: false,
      })
      continue
    }

    const revisionDiff = comparePngFiles(headFirst, baseFirst, path.join(diffReportDir, `${scenario}.png`))
    if (revisionDiff.dimensionMismatch) failures.push(`${scenario}: base is ${revisionDiff.expected.width}x${revisionDiff.expected.height}, head is ${revisionDiff.actual.width}x${revisionDiff.actual.height}`)
    results.push({
      name: scenario,
      status: revisionDiff.dimensionMismatch
        ? 'failed'
        : (revisionDiff.changedPixels > 0 ? 'changed' : 'unchanged'),
      changedPixels: revisionDiff.changedPixels,
      diffRatio: revisionDiff.ratio,
      baseStabilityRatio: baseStability.ratio,
      headStabilityRatio: headStability.ratio,
      width: revisionDiff.actual.width,
      height: revisionDiff.actual.height,
      hasBase: true,
      hasHead: true,
      hasDiff: !revisionDiff.dimensionMismatch,
    })
  }

  const manifest = {
    version: 1,
    status: failures.length > 0 ? 'failed' : 'passed',
    baseSha,
    headSha,
    chromiumPath,
    chromiumVersion: chromiumVersion(chromiumPath),
    instabilityRatioLimit,
    captures: captureResults,
    failures,
    scenarios: results,
  }
  fs.writeFileSync(path.join(reportRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  fs.writeFileSync(path.join(reportRoot, 'summary.md'), buildSummary(manifest))
  fs.writeFileSync(path.join(reportRoot, 'index.html'), buildHtml(manifest))
  return manifest
}

function runSelfTest() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-visual-self-test-'))
  try {
    const basePath = path.join(directory, 'base.png')
    const headPath = path.join(directory, 'head.png')
    const diffPath = path.join(directory, 'diff.png')
    const base = new PNG({ width: 64, height: 64 })
    const head = new PNG({ width: 64, height: 64 })
    base.data.fill(255)
    head.data.fill(255)
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const offset = (y * 64 + x) * 4
        head.data[offset] = 0
        head.data[offset + 1] = 0
        head.data[offset + 2] = 0
      }
    }
    fs.writeFileSync(basePath, PNG.sync.write(base))
    fs.writeFileSync(headPath, PNG.sync.write(head))
    const result = comparePngFiles(headPath, basePath, diffPath)
    if (result.dimensionMismatch || result.changedPixels < 200 || !fs.existsSync(diffPath)) {
      throw new Error(`Unexpected self-test result: ${JSON.stringify(result)}`)
    }
    const scenarios = readScenarioNames(captureSpecPath)
    if (scenarios.length < 4 || new Set(scenarios).size !== scenarios.length) {
      throw new Error(`Invalid visual scenario manifest: ${JSON.stringify(scenarios)}`)
    }
    const baseCaptureDir = path.join(directory, 'captures', 'base')
    const headCaptureDir = path.join(directory, 'captures', 'head')
    const reportRoot = path.join(directory, 'report')
    fs.mkdirSync(baseCaptureDir, { recursive: true })
    fs.mkdirSync(headCaptureDir, { recursive: true })
    for (const suffix of ['1', '2']) {
      fs.copyFileSync(basePath, path.join(baseCaptureDir, `common.${suffix}.png`))
      fs.copyFileSync(headPath, path.join(headCaptureDir, `common.${suffix}.png`))
      fs.copyFileSync(headPath, path.join(headCaptureDir, `added.${suffix}.png`))
    }
    const manifest = writeReport({
      reportRoot,
      scenarios: ['common', 'added'],
      baseScenarios: ['common'],
      headScenarios: ['common', 'added'],
      baseCaptureDir,
      headCaptureDir,
      baseSha: 'base-self-test',
      headSha: 'head-self-test',
      chromiumPath: process.execPath,
      captureResults: {},
      initialFailures: [],
    })
    if (manifest.status !== 'passed' || manifest.scenarios.find(scene => scene.name === 'added')?.status !== 'added') {
      throw new Error(`Added-scene report self-test failed: ${JSON.stringify(manifest)}`)
    }
    console.log(`Visual comparison self-test passed (${scenarios.length} scenarios).`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.get('selfTest') === '1') {
    runSelfTest()
    return
  }

  const baseRoot = path.resolve(requiredArgument(args, 'base-root'))
  const headRoot = path.resolve(requiredArgument(args, 'head-root'))
  const reportRoot = path.resolve(requiredArgument(args, 'output'))
  const baseSha = requiredArgument(args, 'base-sha')
  const headSha = requiredArgument(args, 'head-sha')
  const chromiumPath = path.resolve(requiredArgument(args, 'chromium-path'))
  ensureEmptyDirectory(reportRoot)
  const logsDir = path.join(reportRoot, 'logs')
  const capturesDir = path.join(reportRoot, '.captures')
  const baseCaptureDir = path.join(capturesDir, 'base')
  const headCaptureDir = path.join(capturesDir, 'head')
  fs.mkdirSync(logsDir, { recursive: true })

  const currentScenarios = readScenarioNames(captureSpecPath)
  if (currentScenarios.length === 0) throw new Error('The current visual scenario manifest is empty')
  const baseSpecPath = path.join(baseRoot, 'tests', 'e2e', 'visual-regression.spec.ts')
  const previousScenarios = readScenarioNames(baseSpecPath)
  const deletedScenarios = previousScenarios.filter(scenario => !currentScenarios.includes(scenario))
  const failures = deletedScenarios.map(scenario => `${scenario}: scenario existed at base SHA but was deleted at head SHA`)
  const baseCaptureSpecPath = previousScenarios.length > 0 ? baseSpecPath : captureSpecPath
  const baseCaptureScenarios = previousScenarios.length > 0 ? previousScenarios : currentScenarios
  const allScenarios = [
    ...baseCaptureScenarios,
    ...currentScenarios.filter(scenario => !baseCaptureScenarios.includes(scenario)),
  ]

  const baseCapture = await captureRevision({
    label: 'base',
    targetRoot: baseRoot,
    outputDir: baseCaptureDir,
    logsDir,
    chromiumPath,
    specPath: baseCaptureSpecPath,
  })
  if (baseCapture.error) failures.push(baseCapture.error)
  const headCapture = await captureRevision({
    label: 'head',
    targetRoot: headRoot,
    outputDir: headCaptureDir,
    logsDir,
    chromiumPath,
    specPath: captureSpecPath,
  })
  if (headCapture.error) failures.push(headCapture.error)

  const manifest = writeReport({
    reportRoot,
    scenarios: allScenarios,
    baseScenarios: baseCaptureScenarios,
    headScenarios: currentScenarios,
    baseCaptureDir,
    headCaptureDir,
    baseSha,
    headSha,
    chromiumPath,
    captureResults: {
      base: baseCapture,
      head: headCapture,
    },
    initialFailures: failures,
  })
  fs.rmSync(capturesDir, { recursive: true, force: true })
  if (manifest.status !== 'passed') process.exitCode = 1
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exitCode = 1
})
