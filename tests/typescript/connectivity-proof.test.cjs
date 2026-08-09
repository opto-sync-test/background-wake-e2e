'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const sourceRoot = process.env.OPTO_SYNC_SOURCE;
assert.ok(sourceRoot, 'OPTO_SYNC_SOURCE must point at the pinned source checkout');

require(path.join(sourceRoot, 'clients/ts/node_modules/fake-indexeddb/auto'));

const {
  ManualConnectivityWatcher,
} = require(path.join(sourceRoot, 'clients/ts/dist/connectivity.js'));
const {
  ConnectivityAwareOptoSyncClient,
} = require(path.join(sourceRoot, 'clients/ts/dist/connected-client.js'));

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

test('5,000 deterministic connectivity operations preserve the total-offline model', () => {
  let clock = 0;
  const watcher = new ManualConnectivityWatcher({
    initialState: 'unknown',
    now: () => ++clock,
  });
  const random = xorshift32(0x0f70c0de);
  const states = ['unknown', 'offline', 'link', 'internet'];

  let automatic = 'unknown';
  let mode = 'automatic';
  let exposed = 'unknown';
  let expectedTransitions = 0;
  let deliveredTransitions = 0;

  watcher.subscribe(
    (next, previous) => {
      deliveredTransitions += 1;
      assert.ok(
        next.state !== previous.state || next.mode !== previous.mode,
        'listeners receive semantic transitions only',
      );
    },
    { emitCurrent: false },
  );

  for (let index = 0; index < 5_000; index += 1) {
    const value = random();
    if (value % 5 === 0) {
      const enabled = (value & 8) !== 0;
      const nextMode = enabled ? 'offline' : 'automatic';
      if (nextMode !== mode) {
        const nextExposed = enabled ? 'offline' : automatic;
        if (nextExposed !== exposed || nextMode !== mode) expectedTransitions += 1;
        mode = nextMode;
        exposed = nextExposed;
      }
      watcher.setTotalOffline(enabled);
    } else {
      const state = states[value % states.length];
      automatic = state;
      if (mode === 'automatic' && exposed !== state) {
        expectedTransitions += 1;
        exposed = state;
      }
      watcher.publish(state, state === 'internet' ? 'probe' : 'manual');
    }

    const snapshot = watcher.snapshot();
    assert.equal(snapshot.mode, mode, `mode mismatch at operation ${index}`);
    assert.equal(snapshot.state, exposed, `state mismatch at operation ${index}`);
    assert.equal(
      snapshot.hasVerifiedInternet,
      undefined,
      'the public value remains data-only rather than inventing UI helpers',
    );
  }

  assert.equal(deliveredTransitions, expectedTransitions);
});

test('durable save signals are immediate, metadata-only, and isolated from observer failures', async () => {
  const databaseName = `opto-sync-test-node-${process.pid}-${Date.now()}`;
  const watcher = new ManualConnectivityWatcher({ initialState: 'internet' });
  const saves = [];
  const onlineSaves = [];
  const durabilityChecks = [];
  let wakeups = 0;
  let client;

  client = new ConnectivityAwareOptoSyncClient({
    databaseName,
    stampUpdatedAt: false,
    connectivity: watcher,
    onMutationQueued: () => {
      wakeups += 1;
    },
    onSave: (event) => {
      saves.push(event);
      durabilityChecks.push(client.db.localMutations.get(event.queueId));
    },
    onOnlineSave: (event) => {
      onlineSaves.push(event);
    },
  });

  client.subscribeSave(() => {
    throw new Error('synchronous observer failure');
  });
  client.subscribeSave(async () => {
    throw new Error('asynchronous observer failure');
  });

  for (let index = 0; index < 25; index += 1) {
    const queueId = await client.queueMutation('documents', `online-${index}`, {
      value: index,
      secret: 'TOP_SECRET_PAYLOAD',
    });
    assert.ok(queueId > 0);
  }

  assert.equal(saves.length, 25);
  assert.equal(onlineSaves.length, 25);
  assert.equal(wakeups, 25);
  assert.ok((await Promise.all(durabilityChecks)).every(Boolean));

  for (const event of saves) {
    assert.deepEqual(Object.keys(event).sort(), [
      'connectivity',
      'operation',
      'queueId',
      'recordId',
      'savedAt',
      'tableName',
    ]);
    assert.equal(JSON.stringify(event).includes('TOP_SECRET_PAYLOAD'), false);
    assert.equal(event.connectivity.state, 'internet');
    assert.equal(event.connectivity.mode, 'automatic');
  }

  client.setTotalOffline(true);
  watcher.publish('internet', 'probe');
  for (let index = 0; index < 10; index += 1) {
    await client.queueDelete('documents', `offline-${index}`);
  }
  assert.equal(saves.length, 35);
  assert.equal(onlineSaves.length, 25);
  assert.equal(wakeups, 25, 'total-offline saves cannot schedule network work');
  assert.equal(client.connectivitySnapshot().mode, 'offline');

  client.setTotalOffline(false);
  assert.equal(client.connectivitySnapshot().state, 'internet');
  assert.equal(wakeups, 26, 'restoring verified internet wakes the existing loop once');

  watcher.publish('offline', 'manual');
  await client.queueMutation('documents', 'detected-offline', { value: 1 });
  assert.equal(wakeups, 26);
  assert.equal(onlineSaves.length, 25);

  watcher.publish('link', 'manual');
  await client.queueMutation('documents', 'link-only', { value: 2 });
  assert.equal(wakeups, 27, 'a link save may wake the existing loop as a hint');
  assert.equal(onlineSaves.length, 25, 'link is not verified internet');

  watcher.publish('internet', 'probe');
  assert.equal(wakeups, 28, 'link-to-internet transition wakes once');
  await client.queueMutation('documents', 'verified-again', { value: 3 });
  assert.equal(wakeups, 29);
  assert.equal(onlineSaves.length, 26);

  const pending = await client.pendingMutations();
  assert.equal(pending.length, 38);
  assert.equal(saves.length, 38);

  client.dispose();
  await client.db.delete();
});

test('a rejected durable queue operation emits no save event', async () => {
  const watcher = new ManualConnectivityWatcher({ initialState: 'internet' });
  let saves = 0;
  const client = new ConnectivityAwareOptoSyncClient({
    databaseName: `opto-sync-test-quota-${process.pid}-${Date.now()}`,
    stampUpdatedAt: false,
    maxPendingMutations: 1,
    connectivity: watcher,
    onSave: () => {
      saves += 1;
    },
  });

  await client.queueMutation('documents', 'first', { value: 1 });
  await assert.rejects(
    client.queueMutation('documents', 'second', { value: 2 }),
    /pending queue|QUEUE_FULL|limit/i,
  );
  assert.equal(saves, 1);
  assert.equal((await client.pendingMutations()).length, 1);

  client.dispose();
  await client.db.delete();
});
