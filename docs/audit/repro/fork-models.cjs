'use strict';

// Fork source audit. Every guild and network-facing object below is a local stub.
// No guilds are modified and no quest operation or external request is made.
const { Collection } = require('@discordjs/collection');
require('../../../src');
const OriginalMenu = require('../../../src/structures/MessageSelectMenu');
const ForkMenu = require('../../../.tmp/reference-youtsuho/src/structures/MessageSelectMenu');
const OriginalMentions = require('../../../src/structures/MessageMentions');
const ForkMentions = require('../../../.tmp/reference-youtsuho/src/structures/MessageMentions');
const backup = require('../../../.tmp/reference-youtsuho/src/managers/backup');
const backupCreate = require('../../../.tmp/reference-youtsuho/src/managers/backup/create');
const backupUtil = require('../../../.tmp/reference-youtsuho/src/managers/backup/util');
const backupLoad = require('../../../.tmp/reference-youtsuho/src/managers/backup/load');
const ForkUser = require('../../../.tmp/reference-youtsuho/src/structures/User');

const observations = [];
const record = (name, observed) => observations.push({ name, observed });
const empty = () => new Collection();

(async () => {
  const channelMenu = { type: 8, custom_id: 'channel-choice', min_values: 1, max_values: 1, channel_types: [0] };
  record('fork scopes select fields by type', {
    original: new OriginalMenu(channelMenu).toJSON(),
    fork: new ForkMenu(channelMenu).toJSON(),
  });

  const fakeMessage = { content: null, guild: null, client: {
    channels: { cache: empty() }, users: { cache: empty() },
  } };
  record('original partial message mention getters', {
    channels: new OriginalMentions(fakeMessage).channels.size,
    users: new OriginalMentions(fakeMessage).parsedUsers.size,
  });
  for (const property of ['channels', 'parsedUsers']) {
    try { new ForkMentions(fakeMessage)[property]; } catch (error) {
      record(`fork partial message mentions ${property} regression`, error.message);
    }
  }

  try {
    await new ForkUser(fakeMessage.client, { id: '100000000000000001' }).simulateTyping('hello');
  } catch (error) {
    record('fork User simulateTyping lacks sendTyping', error.message);
  }

  const typeGuild = { id: '100000000000000001', roles: { cache: empty() },
    channels: { cache: new Collection([
      ['forum', { name: 'forum', type: 'GUILD_FORUM', position: 0, parent: null }],
      ['stage', { name: 'stage', type: 'GUILD_STAGE_VOICE', position: 1, parent: null }],
    ]) },
  };
  record('backup rewrites channel types', (await backupCreate.getChannels(typeGuild, {})).others);

  let deleteFinished = false;
  let finishDelete;
  let emojiDeleted = false;
  let bansRemoved = 0;
  const delayedDelete = new Promise(resolve => { finishDelete = () => { deleteFinished = true; resolve(); }; });
  const guild = {
    id: '100000000000000001', name: 'fixture', features: [],
    iconURL: () => null, splashURL: () => null, bannerURL: () => null,
    roles: { cache: new Collection([['role', { id: 'role', editable: true, managed: false,
      position: 1, name: 'Role', permissions: { bitfield: 0n }, delete: () => delayedDelete }]]) },
    channels: { cache: empty() },
    emojis: { cache: new Collection([['emoji', { delete: async () => { emojiDeleted = true; } }]]) },
    members: { unban: async () => { bansRemoved++; } },
    bans: { fetch: async () => new Collection([['banned', { user: { id: 'banned' } }]]) },
    fetchWebhooks: async () => empty(),
  };
  for (const method of ['setAFKChannel', 'setAFKTimeout', 'setIcon', 'setBanner', 'setSplash',
    'setDefaultMessageNotifications', 'setWidgetSettings', 'setExplicitContentFilter',
    'setVerificationLevel', 'setSystemChannel', 'setSystemChannelFlags']) {
    guild[method] = async () => {};
  }
  const createdBackup = await backup.create(guild);
  record('default backup excludes emoji and bans', { emojis: createdBackup.emojis, bans: createdBackup.bans });
  await backupUtil.clearGuild(guild);
  record('clearGuild returns while role deletion is pending and clears excluded resources', {
    deleteFinished, emojiDeleted, bansRemoved,
  });
  finishDelete();

  let threadOptions;
  const createdChannel = {
    permissionOverwrites: { set: async () => {} },
    threads: { create: async options => { threadOptions = options; return {}; } },
  };
  const threadGuild = { premiumTier: 'NONE', features: [], roles: { cache: empty() },
    channels: { create: async () => createdChannel },
  };
  await backupUtil.loadChannel({ type: 'GUILD_TEXT', name: 'private-parent', permissions: [], messages: [],
    threads: [{ type: 'GUILD_PRIVATE_THREAD', name: 'confidential', archived: true, locked: true,
      autoArchiveDuration: 1440, rateLimitPerUser: 60, messages: [] }],
  }, threadGuild, null, { maxMessagesPerChannel: 10 });
  record('backup omits private thread type and state during restore', threadOptions);

  const settingWrites = [];
  const settingsGuild = { features: ['COMMUNITY'] };
  for (const method of ['setVerificationLevel', 'setDefaultMessageNotifications', 'setExplicitContentFilter']) {
    settingsGuild[method] = async value => { settingWrites.push({ method, value }); };
  }
  await backupLoad.loadConfig(settingsGuild, {
    verificationLevel: 0, defaultMessageNotifications: 0, explicitContentFilter: 0,
  });
  record('backup silently skips valid zero settings', settingWrites);

  console.log(JSON.stringify(observations, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
