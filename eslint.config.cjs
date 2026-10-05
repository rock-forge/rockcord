'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const imports = require('eslint-plugin-import-x');
const prettier = require('eslint-plugin-prettier/recommended');

module.exports = [
  { ignores: ['node_modules/**', '.tmp/**', 'output/**', 'examples/**', 'src/util/Voice.js'] },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: globals.node },
    plugins: { 'import-x': imports },
    rules: {
      ...js.configs.recommended.rules,
      ...{
        'import-x/order': [
          'error',
          {
            groups: ['builtin', 'external', 'internal', 'index', 'sibling', 'parent'],
            alphabetize: {
              order: 'asc',
            },
          },
        ],
        strict: ['error', 'global'],
        'no-compare-neg-zero': 'error',
        'no-template-curly-in-string': 'error',
        'no-unsafe-negation': 'error',
        'accessor-pairs': 'warn',
        'array-callback-return': 'error',
        'consistent-return': 'error',
        curly: ['error', 'multi-line', 'consistent'],
        'dot-notation': 'error',
        eqeqeq: 'off',
        'no-implied-eval': 'error',
        'no-invalid-this': 'error',
        'no-lone-blocks': 'error',
        'no-new-func': 'error',
        'no-new-wrappers': 'error',
        'no-new': 'error',
        'no-octal-escape': 'error',
        'no-return-assign': 'error',
        'no-self-compare': 'error',
        'no-sequences': 'error',
        'no-throw-literal': 'error',
        'no-unmodified-loop-condition': 'error',
        'no-unused-expressions': 'error',
        'no-useless-call': 'error',
        'no-useless-concat': 'error',
        'no-useless-escape': 'error',
        'no-useless-return': 'error',
        'no-void': 'error',
        'prefer-promise-reject-errors': 'error',
        'require-await': 'off',
        yoda: 'error',
        'no-label-var': 'error',
        'no-undef-init': 'error',
        'getter-return': 'off',
        'capitalized-comments': [
          'error',
          'always',
          {
            ignoreConsecutiveComments: true,
          },
        ],
        'consistent-this': ['error', '$this'],
        'func-names': 'error',
        'func-name-matching': 'error',
        'func-style': [
          'error',
          'declaration',
          {
            allowArrowFunctions: true,
          },
        ],
        'max-depth': 'error',
        'max-nested-callbacks': [
          'error',
          {
            max: 4,
          },
        ],
        'new-cap': 'off',
        'no-array-constructor': 'error',
        'no-inline-comments': 'off',
        'no-lonely-if': 'error',
        'no-unneeded-ternary': 'error',
        'operator-assignment': 'error',
        'unicode-bom': 'error',
        'arrow-body-style': 'error',
        'no-duplicate-imports': 'error',
        'no-useless-computed-key': 'error',
        'no-useless-constructor': 'error',
        'prefer-arrow-callback': 'error',
        'prefer-numeric-literals': 'error',
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
        'prefer-template': 'error',
        'no-restricted-globals': [
          'error',
          {
            name: 'Buffer',
            message: 'Import Buffer from `node:buffer` instead',
          },
          {
            name: 'process',
            message: 'Import process from `node:process` instead',
          },
          {
            name: 'setTimeout',
            message: 'Import setTimeout from `node:timers` instead',
          },
          {
            name: 'setInterval',
            message: 'Import setInterval from `node:timers` instead',
          },
          {
            name: 'setImmediate',
            message: 'Import setImmediate from `node:timers` instead',
          },
        ],
      },
    },
  },
  prettier,
];
