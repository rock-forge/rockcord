'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./helpers.cjs');
const api = require('../src');
const Settings = require('../src/managers/ClientUserSettingManager');
const MessagePayload = require('../src/structures/MessagePayload');

test('content edits preserve attachments; explicit [] removes them', async () => {
  const { client, channel, raw } = fixture();
  const bodies = [];
  client.api = {
    channels: {
      [channel.id]: {
        messages: {
          [raw.id]: {
            patch: async ({ data }) => {
              bodies.push(data);
              return raw;
            },
          },
        },
      },
    },
  };
  await channel.messages.edit(raw.id, { content: 'updated' });
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(bodies[0])), 'attachments'), false);
  await channel.messages.edit(raw.id, { attachments: [] });
  assert.deepEqual(bodies[1].attachments, []);
  const payload = new MessagePayload(channel, {});
  payload.data = { attachments: [{ id: '100000000000000004' }] };
  payload.files = [];
  await channel.messages.edit(raw.id, payload);
  assert.deepEqual(bodies[2].attachments, payload.data.attachments);
  assert.equal(bodies[2].attachments.length, 1);
});

test('pins hydrate wrapped messages, and cached fetch always returns a Promise', async () => {
  const { client, channel, raw } = fixture();
  client.api = {
    channels: {
      [channel.id]: {
        messages: {
          pins: {
            get: async () => ({ items: [{ pinned_at: raw.timestamp, message: raw }], has_more: false }),
          },
        },
      },
    },
  };
  const pins = await channel.messages.fetchPinned();
  assert.equal(pins.get(raw.id).content, 'original');
  const fetched = channel.messages.fetch(raw.id);
  assert.equal(typeof fetched.then, 'function');
  assert.equal(await fetched, pins.get(raw.id));
});

test('pins fetch every page using pinned_at and reject non-advancing cursors', async () => {
  const { client, channel, raw } = fixture();
  const queries = [];
  client.api = {
    channels: {
      [channel.id]: {
        messages: {
          pins: {
            get: async ({ query }) => {
              queries.push(query);
              return queries.length === 1
                ? { items: [{ message: raw, pinned_at: '2026-10-03T12:00:00.000Z' }], has_more: true }
                : {
                    items: [{ message: { ...raw, id: '100000000000000006' }, pinned_at: '2026-10-02T12:00:00.000Z' }],
                    has_more: false,
                  };
            },
          },
        },
      },
    },
  };
  assert.equal((await channel.messages.fetchPinned(false)).size, 2);
  assert.deepEqual(queries, [{ limit: 50 }, { limit: 50, before: '2026-10-03T12:00:00.000Z' }]);
  assert.equal(channel.messages.cache.size, 0);
  client.api.channels[channel.id].messages.pins.get = async () => ({
    items: [{ message: raw, pinned_at: raw.timestamp }],
    has_more: true,
  });
  await assert.rejects(channel.messages.fetchPinned(), /did not advance/);
});

test('forward snapshots do not mutate or share cached source messages', () => {
  const { client, channel, raw } = fixture();
  const original = channel.messages._add(raw);
  const forwarded = new api.Message(client, {
    ...raw,
    id: '100000000000000005',
    content: '',
    message_reference: { type: 1, message_id: raw.id, channel_id: channel.id },
    message_snapshots: [{ message: { content: 'historical', timestamp: raw.timestamp, type: 0 } }],
  });
  const snapshot = forwarded.messageSnapshots.get(raw.id);
  assert.notEqual(snapshot, original);
  assert.equal(original.content, 'original');
  original._patch({ content: 'edited later' });
  assert.equal(snapshot.content, 'historical');
});

test('poll voters use the REST router', async () => {
  const { client, channel, raw } = fixture();
  client.api = {
    channels: id => {
      assert.equal(id, channel.id);
      return {
        polls: message => {
          assert.equal(message, raw.id);
          return {
            answers: answer => {
              assert.equal(answer, 2);
              return { get: async () => ({ users: [client.user] }) };
            },
          };
        },
      };
    },
  };
  const voters = await channel.messages.fetchPollAnswerVoters({ messageId: raw.id, answerId: 2 });
  assert.equal(voters.get(client.user.id), client.user);
});

test('Components V2 are exported and round-trip mutable media and accent colors', () => {
  for (const name of [
    'ContainerComponent',
    'FileComponent',
    'SectionComponent',
    'TextDisplayComponent',
    'ThumbnailComponent',
    'MediaGalleryComponent',
    'MediaGalleryItem',
    'UnfurledMediaItem',
    'SeparatorComponent',
  ]) {
    assert.equal(typeof api[name], 'function', name);
  }
  const container = new api.ContainerComponent({ accent_color: 0x123456, components: [] });
  assert.equal(new api.ContainerComponent(container).toJSON().accent_color, 0x123456);
  const file = new api.FileComponent({ file: { url: 'attachment://old.txt' } });
  file.file.url = 'attachment://new.txt';
  assert.equal(file.toJSON().file.url, 'attachment://new.txt');
});

test('partial member updates preserve state; explicit null clears decoration', () => {
  const { client } = fixture();
  const decoration = { asset: 'asset', sku_id: 'sku' };
  const user = new api.User(client, { id: client.user.id, avatar_decoration_data: decoration });
  user._patch({ avatar_decoration_data: null });
  assert.equal(user.avatarDecorationData, null);
  const member = new api.GuildMember(
    client,
    { user: client.user, pending: true, avatar_decoration_data: decoration },
    {},
  );
  member._patch({ nick: 'new nickname' });
  assert.equal(member.pending, true);
  assert.equal(member.avatarDecorationData.asset, 'asset');
  member._patch({ avatar_decoration_data: null, pending: false });
  assert.equal(member.avatarDecorationData, null);
  assert.equal(member.pending, false);
});

test('reaction counts track normal/burst independently and accept authoritative refreshes', () => {
  const { client, channel } = fixture();
  const reaction = new api.MessageReaction(
    client,
    {
      emoji: { name: '👍', id: null },
      count: 5,
      me: true,
      count_details: { normal: 5, burst: 0 },
    },
    { client, reactions: channel.messages },
  );
  reaction._add(client.user, true);
  assert.equal(reaction.count, 6);
  assert.equal(reaction.countDetails.burst, 1);
  reaction._remove(client.user, false);
  assert.equal(reaction.count, 5);
  assert.equal(reaction.countDetails.normal, 4);
  reaction._remove(client.user, false);
  assert.equal(reaction.count, 5);
  reaction._patch({ count: 2, count_details: { normal: 1, burst: 1 } });
  assert.equal(reaction.count, 2);
});

test('restricted guild edits are transactional, and null status clears', async () => {
  const { client, channel, raw } = fixture();
  const settings = new Settings(client);
  settings._patch({ restricted_guilds: [channel.id] });
  settings.edit = async data => {
    assert.deepEqual(data.restricted_guilds, []);
    throw new Error('offline');
  };
  await assert.rejects(settings.removeRestrictedGuild(channel.id), /offline/);
  assert.equal(settings.disableDMfromGuilds.has(channel.id), true);
  settings.edit = async data => data;
  assert.deepEqual(await settings.addRestrictedGuild(raw.id), { restricted_guilds: [channel.id, raw.id] });
  assert.deepEqual(await settings.setCustomStatus(null), { custom_status: null });
});
