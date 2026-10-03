'use strict';

const js = require('@eslint/js');

module.exports = [
  {
    ignores: ['node_modules/**', 'uploads/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    // CommonJS backend + UMD frontend helper.
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly', module: 'writable', exports: 'writable',
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', fetch: 'readonly', URL: 'readonly',
        URLSearchParams: 'readonly', FormData: 'readonly', crypto: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_|^next$|^res$|^cb$',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-return-await': 'error',
      'require-await': 'off',
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      curly: ['error', 'multi-line'],
    },
  },
  {
    // The browser bundle uses globals that are not in the CommonJS set.
    files: ['../vorth-frontend/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly', document: 'readonly', self: 'readonly',
        localStorage: 'readonly', location: 'readonly', fetch: 'readonly',
        FormData: 'readonly', FileReader: 'readonly', setTimeout: 'readonly',
        clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        MouseEvent: 'readonly', Event: 'readonly', Node: 'readonly',
      },
    },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^_' }] },
  },
  {
    files: ['test/browser/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly',
        // These functions are serialised and evaluated inside the page.
        window: 'readonly',
      },
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: { describe: 'readonly', it: 'readonly' },
    },
    rules: { 'no-unused-expressions': 'off' },
  },
  {
    /*
     * page.evaluate() bodies are serialised and evaluated *inside* the browser,
     * so they legitimately reference window, document and the page's own globals.
     * Declaring them only for the end-to-end file keeps them out of the rest of
     * the suite, where referring to window would be a real mistake - a test
     * quietly asserting nothing because it read an undefined global.
     */
    files: ['test/e2e.test.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        getComputedStyle: 'readonly',
        // The frontend bundle's globals, as index.html loads them.
        VorthSafe: 'readonly',
        VorthClaims: 'readonly',
      },
    },
  },
];