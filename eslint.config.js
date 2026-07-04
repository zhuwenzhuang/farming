const js = require('@eslint/js');

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
      'no-undef': 'warn',
    }
  },
];
