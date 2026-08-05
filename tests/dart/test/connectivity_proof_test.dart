import 'dart:async';

import 'package:opto_sync_client/connectivity.dart';
import 'package:test/test.dart';

int _xorshift32(int value) {
  var state = value & 0xffffffff;
  state ^= (state << 13) & 0xffffffff;
  state ^= state >> 17;
  state ^= (state << 5) & 0xffffffff;
  return state & 0xffffffff;
}

void main() {
  test(
    '5,000 deterministic operations preserve total-offline semantics',
    () async {
      var clock = 0;
      final watcher = ManualOptoSyncConnectivityWatcher(
        now: () => DateTime.fromMillisecondsSinceEpoch(++clock),
      );
      final states = OptoSyncConnectivityState.values;
      var random = 0x0f70c0de;
      var automatic = OptoSyncConnectivityState.unknown;
      var mode = OptoSyncConnectivityMode.automatic;
      var exposed = OptoSyncConnectivityState.unknown;
      var expectedTransitions = 0;
      var deliveredTransitions = 0;

      final subscription = watcher.changes.listen((snapshot) {
        deliveredTransitions += 1;
        expect(snapshot.changedAt.millisecondsSinceEpoch, greaterThan(0));
      });

      for (var index = 0; index < 5000; index += 1) {
        random = _xorshift32(random);
        if (random % 5 == 0) {
          final enabled = random & 8 != 0;
          final nextMode = enabled
              ? OptoSyncConnectivityMode.offline
              : OptoSyncConnectivityMode.automatic;
          if (nextMode != mode) {
            final nextExposed = enabled
                ? OptoSyncConnectivityState.offline
                : automatic;
            if (nextExposed != exposed || nextMode != mode) {
              expectedTransitions += 1;
            }
            mode = nextMode;
            exposed = nextExposed;
          }
          watcher.setTotalOffline(enabled);
        } else {
          final state = states[random % states.length];
          automatic = state;
          if (mode == OptoSyncConnectivityMode.automatic && exposed != state) {
            expectedTransitions += 1;
            exposed = state;
          }
          watcher.publish(
            state,
            source: state == OptoSyncConnectivityState.internet
                ? OptoSyncConnectivitySource.probe
                : OptoSyncConnectivitySource.manual,
          );
        }

        expect(watcher.snapshot.mode, mode, reason: 'operation $index');
        expect(watcher.snapshot.state, exposed, reason: 'operation $index');
      }

      expect(deliveredTransitions, expectedTransitions);
      await subscription.cancel();
      await watcher.close();
    },
  );

  test('post-commit save signals remain immediate and UI-agnostic', () async {
    final watcher = ManualOptoSyncConnectivityWatcher(
      initialState: OptoSyncConnectivityState.internet,
    );
    final events = <OptoSyncLocalSaveEvent>[];
    final onlineEvents = <OptoSyncLocalSaveEvent>[];
    var durable = false;
    var wakes = 0;

    final signals = OptoSyncConnectivitySaveSignals(
      watcher: watcher,
      onSave: (event) async {
        expect(durable, isTrue, reason: 'the durable operation resolved first');
        events.add(event);
        throw StateError('observer failures are isolated');
      },
      onOnlineSave: onlineEvents.add,
      onMutationQueued: () {
        wakes += 1;
      },
    );

    for (var index = 0; index < 50; index += 1) {
      durable = false;
      final queueId = await signals.afterDurableSave<int>(
        save: () async {
          durable = true;
          return index + 1;
        },
        queueId: (value) => value,
        tableName: 'documents',
        recordId: 'online-$index',
        operation: OptoSyncSaveOperation.upsert,
      );
      expect(queueId, index + 1);
    }

    expect(events, hasLength(50));
    expect(onlineEvents, hasLength(50));
    expect(wakes, 50);
    expect(events.first.connectivity.hasVerifiedInternet, isTrue);

    signals.setTotalOffline(true);
    watcher.publish(OptoSyncConnectivityState.internet);
    for (var index = 0; index < 10; index += 1) {
      signals.notifyAfterDurableSave(
        queueId: 100 + index,
        tableName: 'documents',
        recordId: 'offline-$index',
        operation: OptoSyncSaveOperation.delete,
      );
    }
    expect(events, hasLength(60));
    expect(onlineEvents, hasLength(50));
    expect(wakes, 50);
    expect(events.last.connectivity.mode, OptoSyncConnectivityMode.offline);

    signals.setTotalOffline(false);
    expect(wakes, 51, reason: 'verified reconnect wakes once');

    watcher.publish(OptoSyncConnectivityState.offline);
    signals.notifyAfterDurableSave(
      queueId: 200,
      tableName: 'documents',
      recordId: 'detected-offline',
      operation: OptoSyncSaveOperation.upsert,
    );
    expect(wakes, 51);

    watcher.publish(OptoSyncConnectivityState.link);
    signals.notifyAfterDurableSave(
      queueId: 201,
      tableName: 'documents',
      recordId: 'link-only',
      operation: OptoSyncSaveOperation.upsert,
    );
    expect(wakes, 52);
    expect(onlineEvents, hasLength(50));

    watcher.publish(OptoSyncConnectivityState.internet);
    expect(wakes, 53);
    signals.notifyAfterDurableSave(
      queueId: 202,
      tableName: 'documents',
      recordId: 'verified-again',
      operation: OptoSyncSaveOperation.upsert,
    );
    expect(wakes, 54);
    expect(onlineEvents, hasLength(51));

    await signals.dispose();
    await watcher.close();
  });

  test('failed durable operations emit no save signal', () async {
    final watcher = ManualOptoSyncConnectivityWatcher(
      initialState: OptoSyncConnectivityState.internet,
    );
    final signals = OptoSyncConnectivitySaveSignals(watcher: watcher);
    final events = <OptoSyncLocalSaveEvent>[];
    final subscription = signals.saves.listen(events.add);

    await expectLater(
      signals.afterDurableSave<int>(
        save: () async => throw StateError('not committed'),
        queueId: (value) => value,
        tableName: 'documents',
        recordId: 'failed',
        operation: OptoSyncSaveOperation.upsert,
      ),
      throwsStateError,
    );
    expect(events, isEmpty);

    await subscription.cancel();
    await signals.dispose();
    await watcher.close();
  });
}
