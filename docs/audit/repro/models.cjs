'use strict';

// Offline audit only. All API objects below are stubs; no login or network calls.
const { Collection } = require('@discordjs/collection');
const exportsObject = require('../../../src');
const { Message } = require('../../../src/structures/Message');
const MessageManager = require('../../../src/managers/MessageManager');
const MessagePayload = require('../../../src/structures/MessagePayload');
const ContainerComponent = require('../../../src/structures/ContainerComponent');
const FileComponent = require('../../../src/structures/FileComponent');
const User = require('../../../src/structures/User');
const { GuildMember } = require('../../../src/structures/GuildMember');
const ClientUserSettingManager = require('../../../src/managers/ClientUserSettingManager');
const MessageReaction = require('../../../src/structures/MessageReaction');

const results = [];
const record = (name, observed) => results.push({ name, observed });
const client = {
  options: { makeCache: () => new Collection(), partials: [], allowedMentions: {} },
  channels: { cache: new Collection() },
  guilds: { cache: new Collection() },
  emojis: { cache: new Collection() },
  user: { id: '100000000000000001' },
  users: { _add: x => x, cache: new Collection() },
  actions: {},
  emit: () => {},
};
const channelId = '100000000000000002';
const messageId = '100000000000000003';
const channel = { id: channelId, client };
client.channels.cache.set(channelId, channel);
channel.messages = new MessageManager(channel);
const rawMessage = {
  id: messageId, channel_id: channelId, type: 0,
  content: 'live original', author: client.user, timestamp: '2026-01-01T00:00:00.000Z',
};

(async () => {
  record('v2 classes missing public exports', ['ContainerComponent', 'FileComponent', 'SectionComponent',
    'TextDisplayComponent', 'ThumbnailComponent', 'MediaGalleryComponent', 'MediaGalleryItem',
    'UnfurledMediaItem', 'SeparatorComponent'].map(name => ({ name, type: typeof exportsObject[name] })));
  const container = new ContainerComponent({ accent_color: 0x123456, components: [] });
  record('container accent_color disappears', { color: container.accentColor, json: container.toJSON() });
  const file = new FileComponent({ file: { url: 'attachment://readme.txt' } });
  record('file component mandatory file disappears', { file: file.file.url, json: file.toJSON() });

  try {
    await channel.messages.fetchPollAnswerVoters({ messageId, answerId: 1 });
  } catch (error) {
    record('poll voters throw before any request', error.message);
  }

  let editedData;
  client.api = {
    channels: { [channelId]: { messages: { [messageId]: { patch: async ({ data }) => {
      editedData = data;
      return rawMessage;
    } } } } },
  };
  const editPayload = new MessagePayload(channel, { content: 'edit only' });
  editPayload.data = { content: 'edit only', attachments: [{ id: '100000000000000004' }] };
  editPayload.files = [];
  await channel.messages.edit(messageId, editPayload);
  record('message edit overrides retained attachments', editedData);
  await channel.messages.edit(messageId, { content: 'plain content-only edit' });
  record('plain content-only edit sends empty attachments', editedData);
  channel.messages.cache.clear();

  client.api.channels[channelId].messages.pins = { get: async () => ({
    items: [
      { pinned_at: '2026-01-01T00:00:00Z', message: rawMessage },
      { pinned_at: '2025-01-01T00:00:00Z', message: { ...rawMessage, id: '100000000000000004' } },
    ], has_more: false,
  }) };
  const pins = await channel.messages.fetchPinned();
  record('pins unwrap failure', { size: pins.size, keys: [...pins.keys()],
    keyTypes: [...pins.keys()].map(x => typeof x), contents: [...pins.values()].map(x => x.content) });
  channel.messages.cache.clear();

  const original = channel.messages._add(rawMessage);
  const fetchResult = channel.messages.fetch(messageId);
  record('cached fetch is not a Promise', { then: typeof fetchResult.then, resultIsCachedMessage: fetchResult === original });
  const forwarded = new Message(client, {
    ...rawMessage, id: '100000000000000005', content: '',
    message_reference: { type: 1, message_id: messageId, channel_id: channelId },
    message_snapshots: [{ message: { content: 'past snapshot', timestamp: '2025-01-01T00:00:00Z', type: 0 } }],
  });
  record('forwarded snapshot mutates original cache and shares live object', {
    originalContentAfterForward: original.content,
    sameObject: forwarded.messageSnapshots.get(messageId) === original,
  });
  original._patch({ id: messageId, content: 'new edit' });
  record('forwarded immutable snapshot changes with original', forwarded.messageSnapshots.get(messageId).content);

  const menuMessage = new Message(client, { ...rawMessage, components: [{
    type: 1, components: [{ type: 3, custom_id: 'menu1', min_values: 1, max_values: 1,
      options: [{ label: 'A', value: 'a' }] }],
  }] });
  try { menuMessage.selectMenu('menu1', ['a']); } catch (error) {
    record('selectMenu digit custom ID misdetected as index', error.message);
  }

  const settings = new ClientUserSettingManager(client);
  settings._patch({ restricted_guilds: [channelId] });
  try { settings.addRestrictedGuild(messageId); } catch (error) {
    record('addRestrictedGuild wrong property', error.message);
  }
  try { settings.setCustomStatus(null); } catch (error) {
    record('setCustomStatus null throws', error.message);
  }

  const user = new User(client, { id: messageId, avatar_decoration_data: { asset: 'asset', sku_id: 'sku' } });
  user._patch({ avatar_decoration_data: null });
  record('user removed avatar decoration remains cached', user.avatarDecorationData);
  const member = new GuildMember(client, { user: client.user, pending: true,
    avatar_decoration_data: { asset: 'asset', sku_id: 'sku' } }, {});
  member._patch({ nick: 'new nickname' });
  record('partial member patch silently removes unrelated fields', { pending: member.pending, decoration: member.avatarDecorationData });

  const reactionMessage = { client, reactions: { cache: new Collection() } };
  const reaction = new MessageReaction(client, { emoji: { name: '👍', id: null }, count: 5,
    me: true, count_details: { burst: 0, normal: 5 } }, reactionMessage);
  reaction._remove(client.user, false);
  record('own reaction remove fails to decrement', { count: reaction.count, normal: reaction.countDetails.normal, me: reaction.me });
  reaction._patch({ count: 2, count_details: { burst: 0, normal: 2 } });
  record('reaction refresh retains stale count', { count: reaction.count, normal: reaction.countDetails.normal });

  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
