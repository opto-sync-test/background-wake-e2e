use opto_sync_connectivity::{
    ConnectivityMode, ConnectivitySource, ConnectivityState, ConnectivityWatcher, SaveMetadata,
    SaveOperation, SaveSignals,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

fn xorshift32(mut value: u32) -> u32 {
    value ^= value << 13;
    value ^= value >> 17;
    value ^= value << 5;
    value
}

#[test]
fn deterministic_chaos_preserves_total_offline_semantics() {
    let watcher = ConnectivityWatcher::default();
    let delivered = Arc::new(AtomicUsize::new(0));
    let delivered_from_callback = delivered.clone();
    let _subscription = watcher.subscribe(false, move |next, previous| {
        assert!(next.state != previous.state || next.mode != previous.mode);
        delivered_from_callback.fetch_add(1, Ordering::AcqRel);
    });

    let states = [
        ConnectivityState::Unknown,
        ConnectivityState::Offline,
        ConnectivityState::Link,
        ConnectivityState::Internet,
    ];
    let mut random = 0x0f70_c0de_u32;
    let mut automatic = ConnectivityState::Unknown;
    let mut mode = ConnectivityMode::Automatic;
    let mut exposed = ConnectivityState::Unknown;
    let mut expected_transitions = 0_usize;

    for operation in 0..5_000 {
        random = xorshift32(random);
        if random.is_multiple_of(5) {
            let enabled = random & 8 != 0;
            let next_mode = if enabled {
                ConnectivityMode::Offline
            } else {
                ConnectivityMode::Automatic
            };
            if next_mode != mode {
                let next_exposed = if enabled {
                    ConnectivityState::Offline
                } else {
                    automatic
                };
                if next_exposed != exposed || next_mode != mode {
                    expected_transitions += 1;
                }
                mode = next_mode;
                exposed = next_exposed;
            }
            watcher.set_total_offline(enabled);
        } else {
            let state = states[(random as usize) % states.len()];
            automatic = state;
            if mode == ConnectivityMode::Automatic && exposed != state {
                expected_transitions += 1;
                exposed = state;
            }
            watcher.publish(
                state,
                if state == ConnectivityState::Internet {
                    ConnectivitySource::Probe
                } else {
                    ConnectivitySource::Manual
                },
            );
        }

        let snapshot = watcher.snapshot();
        assert_eq!(
            snapshot.mode, mode,
            "mode mismatch at operation {operation}"
        );
        assert_eq!(
            snapshot.state, exposed,
            "state mismatch at operation {operation}"
        );
    }

    assert_eq!(delivered.load(Ordering::Acquire), expected_transitions);
}

#[test]
fn concurrent_consumers_receive_every_post_commit_signal() {
    let watcher = ConnectivityWatcher::new(ConnectivityState::Internet);
    let signals = SaveSignals::new(watcher);
    let save_count = Arc::new(AtomicUsize::new(0));
    let online_count = Arc::new(AtomicUsize::new(0));
    let wake_count = Arc::new(AtomicUsize::new(0));

    let saves = save_count.clone();
    let _save_subscription = signals.on_save(move |event| {
        assert!(event.connectivity.has_verified_internet());
        assert!(!event.table_name.is_empty());
        saves.fetch_add(1, Ordering::AcqRel);
    });
    let online = online_count.clone();
    let _online_subscription = signals.on_online_save(move |_| {
        online.fetch_add(1, Ordering::AcqRel);
    });
    let wakes = wake_count.clone();
    signals.set_wake_hint(Some(move || {
        wakes.fetch_add(1, Ordering::AcqRel);
    }));

    let mut threads = Vec::new();
    for worker in 0..8 {
        let signals = signals.clone();
        threads.push(thread::spawn(move || {
            for index in 0..250 {
                signals.notify_after_durable_save(
                    format!("{worker}-{index}"),
                    SaveMetadata::new(
                        "documents",
                        format!("record-{worker}-{index}"),
                        SaveOperation::Upsert,
                    ),
                );
            }
        }));
    }
    for worker in threads {
        worker.join().expect("consumer worker must complete");
    }

    assert_eq!(save_count.load(Ordering::Acquire), 2_000);
    assert_eq!(online_count.load(Ordering::Acquire), 2_000);
    assert_eq!(wake_count.load(Ordering::Acquire), 2_000);
}

#[test]
fn save_and_wake_contract_survives_panics_and_offline_transitions() {
    let watcher = ConnectivityWatcher::new(ConnectivityState::Internet);
    let signals = SaveSignals::new(watcher.clone());
    let events = Arc::new(Mutex::new(Vec::new()));
    let online_events = Arc::new(AtomicUsize::new(0));
    let wake_count = Arc::new(AtomicUsize::new(0));

    let observed = events.clone();
    let _save_subscription = signals.on_save(move |event| {
        observed.lock().unwrap().push(event);
        panic!("observer panic must remain isolated");
    });
    let online = online_events.clone();
    let _online_subscription = signals.on_online_save(move |_| {
        online.fetch_add(1, Ordering::AcqRel);
    });
    let wakes = wake_count.clone();
    signals.set_wake_hint(Some(move || {
        wakes.fetch_add(1, Ordering::AcqRel);
    }));

    let committed: Result<u64, &'static str> = signals.after_durable_save_sync(
        SaveMetadata::new("documents", "online", SaveOperation::Upsert),
        || Ok(42),
        |value| value.to_string(),
    );
    assert_eq!(committed, Ok(42));
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(online_events.load(Ordering::Acquire), 1);
    assert_eq!(wake_count.load(Ordering::Acquire), 1);

    signals.set_total_offline(true);
    watcher.publish_verified_internet();
    signals.notify_after_durable_save(
        "43",
        SaveMetadata::new("documents", "forced-offline", SaveOperation::Delete),
    );
    assert_eq!(events.lock().unwrap().len(), 2);
    assert_eq!(online_events.load(Ordering::Acquire), 1);
    assert_eq!(wake_count.load(Ordering::Acquire), 1);

    signals.set_total_offline(false);
    assert_eq!(wake_count.load(Ordering::Acquire), 2);

    watcher.publish(ConnectivityState::Offline, ConnectivitySource::Platform);
    signals.notify_after_durable_save(
        "44",
        SaveMetadata::new("documents", "detected-offline", SaveOperation::Upsert),
    );
    assert_eq!(wake_count.load(Ordering::Acquire), 2);

    watcher.publish(ConnectivityState::Link, ConnectivitySource::Platform);
    signals.notify_after_durable_save(
        "45",
        SaveMetadata::new("documents", "link-only", SaveOperation::Upsert),
    );
    assert_eq!(wake_count.load(Ordering::Acquire), 3);
    assert_eq!(online_events.load(Ordering::Acquire), 1);

    watcher.publish_verified_internet();
    assert_eq!(wake_count.load(Ordering::Acquire), 4);
    signals.notify_after_durable_save(
        "46",
        SaveMetadata::new("documents", "verified-again", SaveOperation::Upsert),
    );
    assert_eq!(wake_count.load(Ordering::Acquire), 5);
    assert_eq!(online_events.load(Ordering::Acquire), 2);
}

#[test]
fn failed_durable_operation_emits_nothing() {
    let watcher = ConnectivityWatcher::new(ConnectivityState::Internet);
    let signals = SaveSignals::new(watcher);
    let count = Arc::new(AtomicUsize::new(0));
    let observed = count.clone();
    let _subscription = signals.on_save(move |_| {
        observed.fetch_add(1, Ordering::AcqRel);
    });

    let result: Result<(), &'static str> = signals.after_durable_save_sync(
        SaveMetadata::new("documents", "failed", SaveOperation::Upsert),
        || Err("not committed"),
        |_| "unused".to_owned(),
    );

    assert_eq!(result, Err("not committed"));
    assert_eq!(count.load(Ordering::Acquire), 0);
}
