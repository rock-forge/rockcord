'use strict';

const path = require('node:path');
const process = require('node:process');

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
if (process.env.FFMPEG_PATH) process.env.PATH = path.dirname(path.resolve(ffmpeg)) + path.delimiter + process.env.PATH;
module.exports = { ffmpeg };
