'use strict';

const path = require('node:path');
const process = require('node:process');
const docgen = require('@discordjs/docgen/dist/index.cjs');
const jsdoc = require('jsdoc-to-markdown');

const parse = jsdoc.getTemplateDataSync.bind(jsdoc);
jsdoc.getTemplateDataSync = options =>
  parse({ ...options, 'no-cache': true, configure: path.join(__dirname, 'jsdoc.json') });
docgen.build({
  input: ['src/**/*.js'],
  custom: 'docs/index.json',
  root: '.',
  output: process.argv.includes('--output') ? 'docs/main.json' : undefined,
});
