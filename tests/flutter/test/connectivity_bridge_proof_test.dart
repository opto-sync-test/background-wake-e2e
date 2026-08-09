import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:opto_sync_flutter_background/opto_sync_connectivity.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(OptoSyncFlutterConnectivity.methods, null);
  });

  test(
    'total-offline state changes synchronously before the native call',
    () async {
      final calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(OptoSyncFlutterConnectivity.methods, (
            call,
          ) async {
            calls.add(call);
            return null;
          });

      final connectivity = OptoSyncFlutterConnectivity();
      connectivity.setTotalOffline(true);

      expect(connectivity.snapshot.mode, OptoSyncConnectivityMode.offline);
      expect(connectivity.snapshot.state, OptoSyncConnectivityState.offline);
      await Future<void>.delayed(Duration.zero);
      expect(calls, hasLength(1));
      expect(calls.single.method, 'setConnectivityOffline');
      expect((calls.single.arguments as Map)['enabled'], isTrue);

      await connectivity.dispose();
    },
  );

  test('custom Flutter hosts can publish link and verified internet', () async {
    final connectivity = OptoSyncFlutterConnectivity();
    final states = <OptoSyncConnectivitySnapshot>[];
    final subscription = connectivity.changes.listen(states.add);

    connectivity.publish(OptoSyncConnectivityState.link);
    connectivity.publish(OptoSyncConnectivityState.link);
    connectivity.publish(OptoSyncConnectivityState.link, verified: true);

    expect(states, hasLength(2));
    expect(states.first.state, OptoSyncConnectivityState.link);
    expect(states.last.state, OptoSyncConnectivityState.internet);
    expect(states.last.hasVerifiedInternet, isTrue);

    await subscription.cancel();
    await connectivity.dispose();
  });

  test('probe configuration rejects credential-bearing endpoints', () {
    expect(
      () => OptoSyncFlutterConnectivity(
        probeUrl: Uri.parse('https://user:password@example.test/health'),
      ),
      throwsArgumentError,
    );
  });
}
