'use strict';

const { Collection } = require('@discordjs/collection');
require('../src');
const MessageManager = require('../src/managers/MessageManager');

function fixture() {
  const client = {
    options: { makeCache: () => new Collection(), partials: [], allowedMentions: {} },
    channels: { cache: new Collection() },
    guilds: { cache: new Collection() },
    emojis: { cache: new Collection() },
    user: { id: '100000000000000001' },
    users: { _add: user => user, cache: new Collection() },
    actions: {},
    emit() {},
  };
  const channel = { id: '100000000000000002', client };
  client.channels.cache.set(channel.id, channel);
  channel.messages = new MessageManager(channel);
  const raw = {
    id: '100000000000000003',
    channel_id: channel.id,
    type: 0,
    content: 'original',
    author: client.user,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  return { client, channel, raw };
}

module.exports = { fixture };
