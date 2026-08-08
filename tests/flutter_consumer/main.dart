import 'package:flutter/widgets.dart';
import 'package:opto_sync_flutter_background/opto_sync_flutter_background.dart';

@pragma('vm:entry-point')
Future<bool> backgroundDrain() async => true;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await OptoSyncBackground.initialize(backgroundDrain);

  final connectivity = OptoSyncFlutterConnectivity(
    probeUrl: Uri.parse('https://example.test/health'),
  )..start();
  connectivity.setTotalOffline(true);
  connectivity.setTotalOffline(false);

  final signals = OptoSyncConnectivitySaveSignals(
    watcher: connectivity,
    onSave: (event) {
      debugPrint('saved ${event.recordId}');
    },
    onOnlineSave: (event) {
      debugPrint('saved online ${event.recordId}');
    },
    onMutationQueued: OptoSyncBackground.scheduleExpedited,
  );
  signals.notifyAfterDurableSave(
    queueId: 'compile-proof',
    tableName: 'documents',
    recordId: 'document-1',
    operation: OptoSyncSaveOperation.upsert,
  );

  runApp(const SizedBox.shrink());
}
