'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const process = require('node:process');
const start = performance.now();
const { Client, Constants } = require('../src');
const imported = performance.now();
const client = new Client();
const created = performance.now();
const update = require('../src/client/websocket/handlers/RELATIONSHIP_UPDATE');
let count = 0;
client.on(Constants.Events.RELATIONSHIP_UPDATE, () => {
  count++;
});
const iterations = 20000;
for (let i = 0; i < iterations; i++) {
  update(client, { d: { id: String(i % 1000), nickname: i % 2 ? 'friend' : null } });
}
const handled = performance.now();
assert.equal(count, iterations);
assert.equal(client.relationships.friendNicknames.size, 1000);
client.destroy();
global.gc?.();
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      importMs: imported - start,
      clientCreateMs: created - imported,
      fixtureEvents: iterations,
      eventProcessingMs: handled - created,
      eventsDelivered: count,
      heapUsedBytes: process.memoryUsage().heapUsed,
      activeResourcesAfterDestroy: process.getActiveResourcesInfo(),
    },
    null,
    2,
  ),
);
