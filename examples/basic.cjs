'use strict';

const process = require('node:process');
const { Client } = require('../src');

if (!process.env.DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in your environment or .env file');
const client = new Client();
client.once('ready', () => console.log(`Connected as ${client.user.username}`));
client.on('error', error => console.error(error));
client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error(error);
  client.destroy();
  process.exitCode = 1;
});
