'use strict';

const { createRequire } = require('node:module');
const path = require('node:path');
const process = require('node:process');
const docgen = require('@discordjs/docgen/dist/index.cjs');
const jsdocModule = require('jsdoc-to-markdown');
const jsdoc = jsdocModule.default ?? jsdocModule;

async function main() {
  const data = await jsdoc.getTemplateData({
    files: ['src/**/*.js'],
    'no-cache': true,
    configure: path.join(__dirname, 'jsdoc.json'),
  });
  // Docgen still consumes synchronous template data; parse once with the current API.
  const docgenRequire = createRequire(require.resolve('@discordjs/docgen/dist/index.cjs'));
  const parser = docgenRequire('jsdoc-to-markdown');
  (parser.default ?? parser).getTemplateDataSync = () => data;
  docgen.build({
    input: ['src/**/*.js'],
    custom: 'docs/index.json',
    root: '.',
    output: process.argv.includes('--output') ? 'docs/main.json' : undefined,
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
