import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Reading a `const`/`let` above its declaration is a runtime
      // ReferenceError (temporal dead zone), not a style issue. A hook call
      // placed above the useState it read shipped a black screen to a phone
      // while the build and the whole test suite passed — this is the check
      // that catches that class of bug. Functions are hoisted, so they are
      // exempt; variables are not.
      'no-use-before-define': ['error', { variables: true, functions: false, classes: false }],
    },
  },
])
