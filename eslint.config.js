const js = require('@eslint/js');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');

// Every TypeScript source below is already checked by a strict tsc project, which
// owns undeclared identifiers, redeclaration, and unused symbols, so only those
// duplicate core rules are disabled.
const typescriptOwnedCoreRules = {
  'no-undef': 'off',
  'no-redeclare': 'off',
  'no-unused-vars': 'off',
};

// Only the non-type-aware recommended set: type-aware rules would require
// projectService/program construction, which this lint gate deliberately avoids.
const browserTypescriptRules = {
  ...typescriptPlugin.configs.recommended.rules,
  ...typescriptOwnedCoreRules,
  '@typescript-eslint/no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
};

module.exports = [
  {
    ignores: [
      'frontend/vendor/**',
      'frontend/themes/**',
      'reference/**',
      'node_modules/**',
      'archive/**',
    ]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        global: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        Element: 'readonly',
        // Browser (for frontend/)
        window: 'readonly',
        document: 'readonly',
        WebSocket: 'readonly',
        HTMLElement: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        MutationObserver: 'readonly',
        ResizeObserver: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        CustomEvent: 'readonly',
        getComputedStyle: 'readonly',
        localStorage: 'readonly',
        CSS: 'readonly',
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-constant-condition': 'warn',
      'no-debugger': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'warn',
      'no-extra-semi': 'warn',
      'no-unreachable': 'warn',
      'no-control-regex': 'off',
      'no-useless-assignment': 'off',
      'eqeqeq': ['warn', 'smart'],
    }
  },
  // Frontend ES modules
  {
    files: ['frontend/ghostty-loader.js'],
    languageOptions: {
      sourceType: 'module',
    }
  },
  {
    files: ['bin/farming'],
    languageOptions: {
      sourceType: 'commonjs',
    }
  },
  // Backend tests remain CommonJS-shaped at runtime, but use real TypeScript
  // fixture models and narrowing while running through tsx.
  {
    files: ['backend/tests/test-*.ts'],
    plugins: {
      '@typescript-eslint': typescriptPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'commonjs',
    },
    rules: {
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  // Browser TypeScript is already checked with strict TypeScript settings
  // (noUnusedLocals / noUnusedParameters / no-undef equivalents), so ESLint
  // adds the non-type-aware recommended TypeScript rules on top of that.
  {
    files: ['src/**/*.ts', 'extensions/*/frontend/**/*.ts'],
    plugins: {
      '@typescript-eslint': typescriptPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'module',
    },
    rules: browserTypescriptRules,
  },
  // JSX parsing must stay scoped to .tsx: with ecmaFeatures.jsx enabled the
  // parser reads .ts generic angle brackets (e.g. closest<HTMLElement>) as JSX.
  {
    files: ['src/**/*.tsx', 'extensions/*/frontend/**/*.tsx'],
    plugins: {
      '@typescript-eslint': typescriptPlugin,
    },
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: browserTypescriptRules,
  },
  // Backend and Extension backend runtime sources are CommonJS TypeScript
  // checked by tsconfig.backend-runtime.json, so ESLint adds only
  // syntax/control-flow checks on top of the recommended set.
  {
    files: ['backend/**/*.cts', 'extensions/*/backend/**/*.cts'],
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'commonjs',
    },
    rules: typescriptOwnedCoreRules,
  },
  // Build/tooling scripts and the shared protocol sources are ES modules.
  {
    files: ['scripts/**/*.ts', 'shared/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'module',
    },
    rules: typescriptOwnedCoreRules,
  },
  // Classic browser TypeScript compiles to global scripts rather than modules,
  // so it must be parsed as a script instead of an ES module.
  {
    files: ['frontend/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      parser: typescriptParser,
      sourceType: 'script',
    },
    rules: typescriptOwnedCoreRules,
  },
  // Test-specific globals
  {
    files: ['backend/tests/**'],
    languageOptions: {
      globals: {
        CompositionEvent: 'readonly',
        ClipboardEvent: 'readonly',
        DataTransfer: 'readonly',
      }
    },
    rules: {
      'no-undef': 'off',
    }
  },
];
