import { BrowserConnectivityWatcher } from '../../source/clients/ts/src/connectivity.ts';
import { ConnectivityAwareOptoSyncClient } from '../../source/clients/ts/src/connected-client.ts';

declare global {
  interface Window {
    __proof?: Record<string, unknown>;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

async function probeCount(): Promise<number> {
  const response = await fetch('/probe-count', { cache: 'no-store' });
  return Number(await response.text());
}

async function run(): Promise<void> {
  const watcher = new BrowserConnectivityWatcher({
    probeUrl: '/health',
    probeMethod: 'HEAD',
    probeTimeoutMs: 2_000,
    probeIntervalMs: 0,
  });
  watcher.start();
  await watcher.refresh();

  const saves: Array<Record<string, unknown>> = [];
  const onlineSaves: Array<Record<string, unknown>> = [];
  let wakeups = 0;
  const client = new ConnectivityAwareOptoSyncClient({
    databaseName: `opto-sync-test-browser-${Date.now()}`,
    stampUpdatedAt: false,
    connectivity: watcher,
    onSave: (event) => saves.push(event as unknown as Record<string, unknown>),
    onOnlineSave: (event) =>
      onlineSaves.push(event as unknown as Record<string, unknown>),
    onMutationQueued: () => {
      wakeups += 1;
    },
  });

  if (watcher.snapshot().state !== 'internet') {
    throw new Error(`expected verified internet, got ${watcher.snapshot().state}`);
  }

  await client.queueMutation('documents', 'online', {
    value: 1,
    secret: 'BROWSER_SECRET_PAYLOAD',
  });
  const probesBeforeOffline = await probeCount();

  client.setTotalOffline(true);
  await watcher.refresh();
  window.dispatchEvent(new Event('online'));
  await tick();
  await watcher.refresh();
  const probesAfterOffline = await probeCount();

  await client.queueMutation('documents', 'forced-offline', { value: 2 });
  const wakeupsBeforeRestore = wakeups;
  client.setTotalOffline(false);
  await watcher.refresh();
  await tick();
  const restoreWakeDelta = wakeups - wakeupsBeforeRestore;

  window.dispatchEvent(new Event('offline'));
  await tick();
  const detectedOffline = watcher.snapshot().state;
  await client.queueMutation('documents', 'detected-offline', { value: 3 });

  window.dispatchEvent(new Event('online'));
  await watcher.refresh();
  await tick();
  const stateAfterReconnect = watcher.snapshot().state;

  watcher.stop();
  window.dispatchEvent(new Event('offline'));
  await tick();
  const stateAfterStop = watcher.snapshot().state;

  const pending = await client.pendingMutations();
  client.dispose();
  await client.db.delete();

  window.__proof = {
    initialSaveCount: saves.length,
    onlineSaveCount: onlineSaves.length,
    wakeups,
    restoreWakeDelta,
    forcedOfflineProbeDelta: probesAfterOffline - probesBeforeOffline,
    detectedOffline,
    stateAfterReconnect,
    stateAfterStop,
    pendingCount: pending.length,
    payloadLeaked: JSON.stringify(saves).includes('BROWSER_SECRET_PAYLOAD'),
  };
}

void run().catch((error: unknown) => {
  const value = error instanceof Error ? error : new Error(String(error));
  window.__proof = { error: value.message, stack: value.stack ?? '' };
});
