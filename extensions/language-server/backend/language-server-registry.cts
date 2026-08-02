/**
 * Language server discovery adapted from OpenCode.
 *
 * Upstream: https://github.com/anomalyco/opencode
 * Commit: 1882c33827cf0ce5c948b69ab5a87ed8f6790cf8
 * Copyright (c) 2025 OpenCode
 * Licensed under the MIT License.
 */

import fs from 'node:fs';
import path from 'node:path';

interface LanguageServerDefinition {
  id: string;
  extensions: string[];
  command: string[];
  rootMarkers?: string[];
  excludeMarkers?: string[];
  strictRoot?: boolean;
  resolveRoot?: (filePath: string, workspaceRoot: string) => Promise<string | undefined>;
}

function markerPattern(marker: string): RegExp | null {
  if (!marker.includes('*')) return null;
  const escaped = marker.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function directoryHasMarker(directory: string, marker: string): boolean {
  const pattern = markerPattern(marker);
  if (!pattern) return fs.existsSync(path.join(directory, marker));
  try {
    return fs.readdirSync(directory).some(entry => pattern.test(entry));
  } catch {
    return false;
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function findNearestMarkerDirectory(
  filePath: string,
  workspaceRoot: string,
  markers: string[],
): string | undefined {
  let directory = path.dirname(filePath);
  while (isWithinRoot(directory, workspaceRoot)) {
    if (markers.some(marker => directoryHasMarker(directory, marker))) return directory;
    if (directory === workspaceRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function nearestRoot(
  markers: string[],
  options: { exclude?: string[]; strict?: boolean } = {},
): LanguageServerDefinition['resolveRoot'] {
  return async (filePath, workspaceRoot) => {
    if (options.exclude?.length && findNearestMarkerDirectory(filePath, workspaceRoot, options.exclude)) {
      return undefined;
    }
    return findNearestMarkerDirectory(filePath, workspaceRoot, markers)
      || (options.strict ? undefined : workspaceRoot);
  };
}

function mavenModule(pomContent: string, modulePath: string): boolean {
  const normalized = modulePath.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized) return false;
  const blocks = pomContent.match(/<modules>([\s\S]*?)<\/modules>/g) || [];
  return blocks.some(block => {
    const stripped = block.replace(/<!--[\s\S]*?-->/g, '');
    return [...stripped.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].some(match => (
      match[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') === normalized
    ));
  });
}

async function javaRoot(filePath: string, workspaceRoot: string): Promise<string | undefined> {
  const settingsMarkers = ['settings.gradle', 'settings.gradle.kts'];
  const settingsRoot = findNearestMarkerDirectory(filePath, workspaceRoot, settingsMarkers);
  const wrapperRoot = settingsRoot
    ? undefined
    : findNearestMarkerDirectory(filePath, workspaceRoot, ['gradlew', 'gradlew.bat']);
  if (wrapperRoot) return wrapperRoot;
  if (settingsRoot) return settingsRoot;

  const buildRoot = findNearestMarkerDirectory(filePath, workspaceRoot, ['build.gradle', 'build.gradle.kts']);
  if (buildRoot) return buildRoot;

  const pomDirectories: string[] = [];
  let directory = path.dirname(filePath);
  while (isWithinRoot(directory, workspaceRoot)) {
    if (fs.existsSync(path.join(directory, 'pom.xml'))) pomDirectories.push(directory);
    if (directory === workspaceRoot) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (pomDirectories.length > 0) {
    let root = pomDirectories[0];
    for (const parent of pomDirectories.slice(1)) {
      const content = await fs.promises.readFile(path.join(parent, 'pom.xml'), 'utf8').catch(() => '');
      if (!content || !mavenModule(content, path.relative(parent, root))) break;
      root = parent;
    }
    return root;
  }
  return findNearestMarkerDirectory(filePath, workspaceRoot, ['.project', '.classpath']);
}

const LANGUAGE_SERVERS: LanguageServerDefinition[] = [
  {
    id: 'deno',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs'],
    command: ['deno', 'lsp'],
    resolveRoot: nearestRoot(['deno.json', 'deno.jsonc'], { strict: true }),
  },
  {
    id: 'typescript',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    command: ['typescript-language-server', '--stdio'],
    resolveRoot: nearestRoot(
      ['package-lock.json', 'bun.lockb', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'],
      { exclude: ['deno.json', 'deno.jsonc'] },
    ),
  },
  { id: 'vue', extensions: ['.vue'], command: ['vue-language-server', '--stdio'], rootMarkers: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] },
  { id: 'gopls', extensions: ['.go'], command: ['gopls'], rootMarkers: ['go.work', 'go.mod', 'go.sum'] },
  { id: 'ruby-lsp', extensions: ['.rb', '.rake', '.gemspec', '.ru'], command: ['rubocop', '--lsp'], rootMarkers: ['Gemfile'] },
  { id: 'pyright', extensions: ['.py', '.pyi'], command: ['pyright-langserver', '--stdio'], rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'pyrightconfig.json'] },
  { id: 'elixir-ls', extensions: ['.ex', '.exs'], command: ['elixir-ls'], rootMarkers: ['mix.exs', 'mix.lock'] },
  { id: 'zls', extensions: ['.zig', '.zon'], command: ['zls'], rootMarkers: ['build.zig'] },
  { id: 'csharp', extensions: ['.cs', '.csx'], command: ['roslyn-language-server', '--stdio', '--autoLoadProjects'], rootMarkers: ['*.slnx', '*.sln', '*.csproj', 'global.json'] },
  { id: 'fsharp', extensions: ['.fs', '.fsi', '.fsx', '.fsscript'], command: ['fsautocomplete'], rootMarkers: ['*.slnx', '*.sln', '*.fsproj', 'global.json'] },
  { id: 'sourcekit-lsp', extensions: ['.swift', '.m', '.mm'], command: ['sourcekit-lsp'], rootMarkers: ['Package.swift', '*.xcodeproj', '*.xcworkspace'] },
  { id: 'rust-analyzer', extensions: ['.rs'], command: ['rust-analyzer'], rootMarkers: ['Cargo.toml', 'Cargo.lock'] },
  { id: 'clangd', extensions: ['.c', '.cpp', '.cc', '.cxx', '.c++', '.h', '.hpp', '.hh', '.hxx', '.h++'], command: ['clangd', '--background-index', '--clang-tidy'], rootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd'] },
  { id: 'svelte', extensions: ['.svelte'], command: ['svelteserver', '--stdio'], rootMarkers: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] },
  { id: 'astro', extensions: ['.astro'], command: ['astro-ls', '--stdio'], rootMarkers: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] },
  { id: 'jdtls', extensions: ['.java'], command: ['jdtls'], resolveRoot: javaRoot, strictRoot: true },
  { id: 'kotlin-lsp', extensions: ['.kt', '.kts'], command: ['kotlin-lsp', '--stdio'], rootMarkers: ['settings.gradle.kts', 'settings.gradle', 'gradlew', 'gradlew.bat', 'build.gradle.kts', 'build.gradle', 'pom.xml'] },
  { id: 'yaml-language-server', extensions: ['.yaml', '.yml'], command: ['yaml-language-server', '--stdio'] },
  { id: 'lua-language-server', extensions: ['.lua'], command: ['lua-language-server'], rootMarkers: ['.luarc.json', '.luarc.jsonc', '.luacheckrc', '.stylua.toml', 'stylua.toml'] },
  { id: 'intelephense', extensions: ['.php'], command: ['intelephense', '--stdio'], rootMarkers: ['composer.json', 'composer.lock', '.php-version'] },
  { id: 'prisma', extensions: ['.prisma'], command: ['prisma', 'language-server'], rootMarkers: ['schema.prisma'] },
  { id: 'dart', extensions: ['.dart'], command: ['dart', 'language-server', '--lsp'], rootMarkers: ['pubspec.yaml', 'analysis_options.yaml'] },
  { id: 'ocamllsp', extensions: ['.ml', '.mli'], command: ['ocamllsp'], rootMarkers: ['dune-project', 'dune-workspace', '.merlin', 'opam'] },
  { id: 'bash-language-server', extensions: ['.sh', '.bash', '.zsh', '.ksh'], command: ['bash-language-server', 'start'] },
  { id: 'terraform-ls', extensions: ['.tf', '.tfvars'], command: ['terraform-ls', 'serve'], rootMarkers: ['.terraform.lock.hcl', 'terraform.tfstate', '*.tf'] },
  { id: 'texlab', extensions: ['.tex', '.bib'], command: ['texlab'], rootMarkers: ['.latexmkrc', 'latexmkrc', '.texlabroot', 'texlabroot'] },
  { id: 'docker-langserver', extensions: ['.dockerfile'], command: ['docker-langserver', '--stdio'] },
  { id: 'gleam', extensions: ['.gleam'], command: ['gleam', 'lsp'], rootMarkers: ['gleam.toml'] },
  { id: 'clojure-lsp', extensions: ['.clj', '.cljs', '.cljc', '.edn'], command: ['clojure-lsp', 'listen'], rootMarkers: ['deps.edn', 'project.clj', 'shadow-cljs.edn', 'bb.edn', 'build.boot'] },
  { id: 'nixd', extensions: ['.nix'], command: ['nixd'], rootMarkers: ['flake.nix'] },
  { id: 'tinymist', extensions: ['.typ', '.typc'], command: ['tinymist'], rootMarkers: ['typst.toml'] },
  { id: 'haskell-language-server', extensions: ['.hs', '.lhs'], command: ['haskell-language-server-wrapper', '--lsp'], rootMarkers: ['stack.yaml', 'cabal.project', 'hie.yaml', '*.cabal'] },
  { id: 'julials', extensions: ['.jl'], command: ['julia', '--startup-file=no', '--history-file=no', '-e', 'using LanguageServer; runserver()'], rootMarkers: ['Project.toml', 'Manifest.toml', '*.jl'] },
];

async function resolveLanguageServer(
  filePath: string,
  workspaceRoot: string,
  definitions: LanguageServerDefinition[] = LANGUAGE_SERVERS,
): Promise<{ definition: LanguageServerDefinition; root: string } | undefined> {
  const basename = path.basename(filePath);
  const extension = basename === 'Dockerfile' ? '.dockerfile' : path.extname(filePath).toLowerCase();
  for (const definition of definitions) {
    if (!definition.extensions.includes(extension)) continue;
    const root = definition.resolveRoot
      ? await definition.resolveRoot(filePath, workspaceRoot)
      : findNearestMarkerDirectory(filePath, workspaceRoot, definition.rootMarkers || [])
        || (definition.strictRoot ? undefined : workspaceRoot);
    if (root) return { definition, root };
  }
  return undefined;
}

export {
  LANGUAGE_SERVERS,
  findNearestMarkerDirectory,
  resolveLanguageServer,
  type LanguageServerDefinition,
};
