/**
 * Puffco BLE Web Controller — Frontend Application
 * Manages WebSocket communication, UI state, color controls,
 * profile cards, and real-time device status updates.
 */

const app = (() => {
  // ---- State ----
  let ws = null;
  let connected = false;
  let deviceState = null;
  let lanternOn = false;
  let stealthOn = false;
  let reconnectTimer = null;
  let bridgeConnectInFlight = false;
  let connectPending = false;
  let scanPending = false;
  let editingProfileIndex = null;
  let editingLocalProfileId = null;
  let pendingProfileReload = null;
  let profileSaveInFlight = null;
  let pendingAutoCloseIndex = null;
  let heatCommandPending = null;
  let renderTimer = null;
  let lastDeviceSnapshot = null;
  let lastBackendMessage = null;
  let lastConnectionStatus = null;
  let bridgeUrl = null;
  let suppressSocketReconnect = false;
  let transportMode = 'browser_ble';
  let browserBle = null;
  let browserBlePoll = null;
  let browserBleStatusInFlight = false;
  let browserBleDisconnectHandled = false;
  let optimisticProfileIndex = null;
  let bleCapabilityExpanded = false;
  let localMoodPresets = [];
  let voiceRecognition = null;
  let voiceListening = false;
  // voiceIntentRunning reflects user intent ("they asked voice to be on").
  // voiceListening reflects the recognition engine state. Keeping them separate
  // avoids the restart-loop race where stop() is called but onend immediately
  // restarts because voiceListening is still true.
  let voiceIntentRunning = false;
  let voicePermissionGranted = false;
  let lastVoiceCommandText = '';
  let lastVoiceCommandAt = 0;
  // Minimum confidence we trust for an interim (not yet final) result before
  // firing a command. Final results bypass this gate.
  const VOICE_INTERIM_CONFIDENCE = 0.6;
  const VOICE_DEDUPE_MS = 1800;
  const VOICE_RESTART_DELAY_MS = 250;
  const VOICE_RESTART_DELAY_HIDDEN_MS = 1000;
  const VOICE_MIC_RESTART_DELAY_HIDDEN_MS = 150;
  // Voice command prefix (a.k.a. wake word). When non-empty, transcripts
  // only fire a command if the wake word is detected — the wake word is
  // stripped and the remainder is sent to the matcher. When empty, the
  // current "fire on any matching command" behavior is preserved so users
  // who don't want a prefix don't have to set one. Persisted in
  // localStorage so a returning user lands in the same mode they left.
  //   localStorage key: 'puffco:voice-prefix'
  //   localStorage key: 'puffco:voice-intent'  ('1' = user wants voice on)
  const VOICE_PREFIX_KEY = 'puffco:voice-prefix';
  const VOICE_INTENT_KEY = 'puffco:voice-intent';
  const VOICE_DEFAULT_PREFIX = 'puffco';
  let voicePrefix = loadVoicePrefix();
  // lastHeardAt records when the wake word was last detected, used to
  // surface a brief "Puffco:" flash in the UI when the user speaks
  // the wake word but no command follows (or the command is not yet
  // matched).
  let voiceWakeFiredAt = 0;
  // Last executed voice action — surfaced in the UI as a fading chip.
  let voiceLastAction = null;
  let voiceLastActionFrame = null;
  let voiceStream = null;
  let voiceAudioContext = null;
  let voiceAnalyser = null;
  let voiceMeterFrame = null;
  let voiceBluetoothPending = false;

  // ============================================================
  // Dab Scoring
  // ============================================================
  //
  // The scorer is gated on the device state. The original implementation
  // kicked into the countdown as soon as the airflow sensor crossed the
  // threshold, but the device sends airflow readings during preheat and
  // even when the user is not drawing, so a single 6% noise sample was
  // enough to trigger a fake "dab" that was really a heater pulse.
  //
  // The scorer now arms on the device's own state machine: when a heat
  // cycle starts it auto-shows the preheat view (one consistent M:SS
  // countdown, matching the status card), and scoring starts the
  // instant the chamber finishes preheating and enters HEAT_CYCLE_ACTIVE
  // -- no 3-2-1, the session begins right as the preheat ends. Using the
  // PREHEAT -> ACTIVE transition as the trigger is what kills the old
  // preheat-noise false positives: a noisy reading during PREHEAT can no
  // longer start a dab because PREHEAT is not the drawing state.
  //
  // The N-consecutive-above-threshold debounce is kept only as a
  // fallback for the case where scoring is enabled mid-cycle while the
  // device is already ACTIVE (so no transition edge is observed).

  // Difficulty target flows (sum of airflow samples needed for max flow score)
  const DAB_TARGET_FLOW = { casual: 15, standard: 30, beast: 50 };
  const DAB_IDEAL_MIN = 0.45;   // ideal airflow range lower bound (normalized 0-1)
  const DAB_IDEAL_MAX = 0.75;   // ideal airflow range upper bound (normalized 0-1)
  // (drop timeout is user-tunable now — see dabDropTimeoutMs below)
  const DAB_MAX_VARIANCE = 0.25;    // std dev that gives consistency score of 0
  // Number of consecutive above-threshold 1Hz samples required to leave
  // the 'idle' / 'preheating' gate and start the 3-2-1 countdown. The
  // original single-sample gate produced false positives on preheat
  // pulses and on single-tick airflow noise. Three samples is ~3 seconds
  // of sustained draw, which matches the user's actual inhale.
  const DAB_DEBOUNCE_SAMPLES = 3;
  // Minimum samples before calcDabFullScore returns a real score. A
  // session with fewer than this gets zeros + an insufficient flag so
  // the UI can show "Need at least 1 second of drawing to score" instead
  // of a misleading number.
  const DAB_MIN_SAMPLES_FOR_SCORE = 5;
  // ---- Adaptive draw calibration ----
  // Different chambers/hardware top out at very different raw sensor
  // values — some users max out near 60 raw, which made it "impossible
  // to pass 60%" no matter how hard they pulled. The app now LEARNS
  // the device's true maximum: any raw reading above the current
  // learned max raises it instantly (mid-draw), and the value persists
  // across sessions with a gentle decay so a one-off glitch can't pin
  // it forever. Every percent the UI shows is normalized to this max,
  // so the user's hardest pull reads ~100%.
  const DAB_DRAW_MAX_KEY = 'puffco:dab_draw_max_v1';
  // Two-tap calibration: keep BOTH an "all-time max" (which grows
  // immediately when a new record is set) AND a "rolling recent peak"
  // window (the max of the last 5 sessions). The reported learned
  // max is the larger of the two, so the user gets fast response on
  // a new hard pull but the bar still calibrates to reality over
  // the next few sessions instead of pinning to a single lucky hit.
  // The previous single-bucket scheme would pin at 90 (the default)
  // forever even when the user's hardest pull was 45 — the
  // normalized value then maxed out at 50% and stayed there.
  const DAB_PEAK_HISTORY_KEY = 'puffco:dab_peak_history_v1';
  const DAB_PEAK_WINDOW = 5;
  let dabLearnedMaxPct = (() => {
    try {
      const v = Number(localStorage.getItem(DAB_DRAW_MAX_KEY));
      return Number.isFinite(v) && v >= 20 && v <= 150 ? v : 60;
    } catch { return 60; }
  })();

  function readPeakHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(DAB_PEAK_HISTORY_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter((n) => Number.isFinite(Number(n)) && n > 0).map(Number).slice(0, DAB_PEAK_WINDOW);
    } catch { return []; }
  }
  function writePeakHistory(history) {
    try { localStorage.setItem(DAB_PEAK_HISTORY_KEY, JSON.stringify(history.slice(0, DAB_PEAK_WINDOW))); }
    catch { /* ignore */ }
  }
  function recordSessionPeak(peak) {
    if (!Number.isFinite(peak) || peak <= 0) return;
    const next = [peak, ...readPeakHistory()].slice(0, DAB_PEAK_WINDOW);
    writePeakHistory(next);
  }
  function rollingRecentPeak() {
    const hist = readPeakHistory();
    if (!hist.length) return null;
    return Math.max(...hist);
  }

  function dabPersistLearnedMax() {
    try { localStorage.setItem(DAB_DRAW_MAX_KEY, String(Math.round(dabLearnedMaxPct * 10) / 10)); }
    catch { /* ignore */ }
  }

  // Raw sensor percent -> normalized percent where 100 = the hardest
  // pull this device has ever produced. Grows the learned max live so
  // the very sample that sets a new record still reads ~100.
  // When the persisted learned max still equals the original default
  // (60) the user hasn't built a real calibration yet, so the very
  // first non-trivial reading (>=20 %) snaps the max to that sample.
  // That fixes the "I pull hard and the bar stops at 50 %" symptom on
  // the first dab after install / reset, without throwing away a
  // calibrated value once one exists.
  function dabNormalizePercent(rawSensorPct) {
    const raw = Number(rawSensorPct) || 0;
    const isUncalibrated = dabLearnedMaxPct === 60; // default — no real data yet
    if (isUncalibrated && raw >= 20) {
      // Snap to the first real reading: a one-shot calibration that
      // gives the right answer on the very first pull, no waiting for
      // the decay loop to catch up.
      dabLearnedMaxPct = Math.min(150, raw);
      dabPersistLearnedMax();
    } else if (raw > dabLearnedMaxPct) {
      dabLearnedMaxPct = Math.min(150, raw);
      dabPersistLearnedMax();
    }
    return Math.max(0, Math.min(150, (raw / dabLearnedMaxPct) * 100));
  }

  // After each session, refresh the rolling window and shrink the
  // learned max if the rolling max is well below it. The previous
  // implementation decayed 4 % per session with a 75 % threshold, but
  // users with a real max of 45 raw would see only 50 % on the
  // bar for many sessions before the decay caught up. The new rule
  // snaps the learned max to the rolling max within 1-2 sessions
  // when there's a clear gap, so a fresh chamber or new device gets
  // calibrated on the next pull instead of the next pull after that.
  function dabDecayLearnedMax(sessionPeakRaw) {
    if (!Number.isFinite(sessionPeakRaw) || sessionPeakRaw <= 0) return;
    recordSessionPeak(sessionPeakRaw);
    const recent = rollingRecentPeak();
    if (recent == null) return;
    // If the recent sessions are clearly below the current learned
    // max, snap to the recent max (clamped so a single tiny reading
    // never drops us below 30 raw — that's the hardware floor).
    if (recent < dabLearnedMaxPct * 0.85) {
      dabLearnedMaxPct = Math.max(30, recent);
      dabPersistLearnedMax();
    }
  }
  // ---- User-tunable dab settings (Settings > Dab) ----
  // Each has a shipped default; applyDabTuning() folds in the user's
  // saved overrides at boot and whenever a setting changes.
  // UI ceiling for raw airflow (charts + readouts).
  let DAB_UI_AIRFLOW_MAX = 150;
  // Fast sampling interval while a session is live (browser BLE only).
  let DAB_FAST_SAMPLE_MS = 150;
  // Idle (no scoring session) bar poll — also reads the pinned
  // /p/app/htr/inh characteristic but at a slower rate so the bar
  // feels alive between dabs without burning the radio. 100ms
  // matches the 1Hz snapshot's human-eye latency (~150ms reaction
  // threshold) so an inhale registers before the user notices the
  // delay, and is cheap enough on the radio to leave running.
  let DAB_IDLE_BAR_SAMPLE_MS = 100;
  // Whether the fast sampler runs at all.
  let dabFastSamplerEnabled = true;
  // How long airflow must stay below threshold before the dab ends.
  let dabDropTimeoutMs = 1200;
  // Hard cap on session length.
  let dabMaxDurationMs = 90000;
  // Auto-open the preheat view when a heat cycle starts.
  let dabAutoArm = true;

  function applyDabTuning(all) {
    const num = (v, d, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
    };
    DAB_UI_AIRFLOW_MAX = num(all.dabUiAirflowMax, 150, 100, 200);
    DAB_FAST_SAMPLE_MS = num(all.dabFastSampleMs, 150, 100, 1000);
    // Idle-bar poll: settings range 50–400ms so power users can tighten
    // it further (lower bound keeps the radio at <=20Hz which is safe
    // for browser BLE notify budgets).
    DAB_IDLE_BAR_SAMPLE_MS = num(all.dabIdleBarSampleMs, 100, 50, 400);
    dabFastSamplerEnabled = all.dabFastSampler !== false;
    dabDropTimeoutMs = num(all.dabDropTimeoutMs, 1200, 500, 5000);
    dabMaxDurationMs = num(all.dabMaxDurationS, 90, 30, 300) * 1000;
    dabAutoArm = all.dabAutoArm !== false;
  }
  // Length of the in-app "Run sensor diagnostic" capture window.
  const DAB_DIAGNOSTIC_DURATION_MS = 30000;
  // Sensor poll interval used by the diagnostic — every 100ms is much
  // finer than the regular 1Hz status poll, which is the whole point of
  // running the diagnostic.
  const DAB_DIAGNOSTIC_POLL_MS = 100;

  const DAB_HISTORY_KEY = 'puffco:dab_history_v1';

  function getDabHistory() {
    try { return JSON.parse(localStorage.getItem(DAB_HISTORY_KEY) || '[]'); } catch { return []; }
  }
  function saveDabHistory(history) {
    try { localStorage.setItem(DAB_HISTORY_KEY, JSON.stringify(history)); } catch { /* ignore */ }
  }

  // dabState: 'idle' | 'preheating' | 'active' | 'results' | 'diagnostic'
  let dabState = 'idle';
  let dabEnabled = false;
  let dabDifficulty = 'standard';
  let dabThreshold = 12;         // airflow percent — was 6, raised to keep noise out
  let dabSamples = [];           // [{ts, airflow}] normalized 0-1
  let dabDroppedBelowAt = null;  // timestamp when airflow last dropped below threshold
  let dabCanvasCtx = null;
  let dabAnimationFrame = null;
  let dabStartTime = null;
  // Number of consecutive above-threshold samples seen while waiting in
  // 'idle' or 'preheating'. Reset to 0 the moment a sample falls below
  // the threshold. Compared against DAB_DEBOUNCE_SAMPLES.
  let dabDebounceCount = 0;
  // The most recent state the device reported to the dab gate. Used to
  // detect PREHEAT -> ACTIVE transitions and to keep the preheat
  // countdown ticking even when the airflow stays at zero.
  let dabLastStateKey = '';
  // Diagnostic-run state (populated only while the diagnostic view is
  // active; cleared when the user closes the panel).
  let dabDiag = null;

  // Track the strongest raw sensor reading of the current session so
  // endDabSession can drift the learned max back down when the user's
  // hardware stops reaching it (see dabDecayLearnedMax).
  let dabSessionPeakRaw = 0;

  function dabCalibrate(percent) {
    // `percent` is already normalized (100 = device max), so scoring
    // airflow is simply normalized/100, capped at 1.0. Overshoot above
    // the learned max still shows in the charts via the raw field.
    return Math.min(1, percent / 100);
  }

  // True only when the device is in the part of the heat cycle the
  // user can actually draw from. PREHEAT, FADE, and IDLE all fail this
  // gate even if the airflow sensor reports a noisy reading.
  function dabIsDrawingState(data) {
    if (!isHeatActive(data)) return false;
    return normalizeStateKey(data?.state) === 'HEAT_CYCLE_ACTIVE';
  }

  function dabOnStatus(data) {
    if (!dabEnabled || !connected) return;
    const rawSensor = Number(data.draw_strength_percent || 0);
    if (dabState === 'active' && rawSensor > dabSessionPeakRaw) dabSessionPeakRaw = rawSensor;
    const percent = dabNormalizePercent(rawSensor);
    const now = Date.now();
    const stateKey = normalizeStateKey(data?.state);
    const prevStateKey = dabLastStateKey;
    const stateChanged = stateKey !== prevStateKey;
    dabLastStateKey = stateKey;
    // True on exactly the poll where the chamber finishes preheating and
    // becomes drawable (any non-active state -> HEAT_CYCLE_ACTIVE). This
    // is the "preheat just ended" edge the scorer arms on, so scoring
    // starts the instant the device is ready to draw rather than waiting
    // for several sustained airflow samples.
    const preheatJustEnded = stateKey === 'HEAT_CYCLE_ACTIVE' && prevStateKey !== 'HEAT_CYCLE_ACTIVE';

    // The diagnostic view is the only thing that runs while the user
    // explicitly asked the panel to capture data. Don't compete with it
    // for the airflow readings.
    if (dabState === 'diagnostic') return;

    // Keep the live session strip (state / temp / timer / draw) in sync
    // on every poll. It self-hides outside preheat/countdown/active.
    dabRenderSessionStrip(data);

    // Keep the preheat countdown ticking in the UI even when the user
    // isn't inhaling (sensor is at 0). Also detect the transition that
    // arms the scoring gate.
    if (dabState === 'preheating') {
      dabRenderPreheatView(data);
      if (stateKey === 'HEAT_CYCLE_ACTIVE') {
        // Preheat ended — scoring starts immediately, no 3-2-1. Feed
        // the observed transition into the preheat-timer calibration
        // first so the next cycle's countdown is more accurate.
        dabCalibratePreheatOffset();
        dabDebounceCount = 0;
        startDabSession();
        return;
      }
      if (stateKey === 'IDLE' || stateKey === 'MASTER_OFF' || stateKey === 'TEMP_SELECT') {
        // User backed out of the heat cycle (or the device did). Treat
        // the preheat as cancelled — no score, just kick back to idle.
        dabCancelPreheating();
        return;
      }
      return;
    }

    if (dabState === 'idle') {
      // Auto-arm the preheat view the moment the device begins a heat
      // cycle, even if the user never tapped "Start Dab". This gives one
      // consistent M:SS countdown and guarantees the scorer is primed to
      // fire the instant the chamber becomes drawable. Respect the
      // "auto-open on heat" setting — when off, only arm if the panel
      // is already open.
      if (dabState === 'idle' && stateKey === 'HEAT_CYCLE_PREHEAT') {
        const panelOpen = document.getElementById('dab-panel')?.classList.contains('visible');
        if (dabAutoArm || panelOpen) {
          dabShowPreheatView(data);
        }
        return;
      }
      // Preheat just ended -> the chamber is ready to draw, so start
      // scoring immediately (no countdown) instead of waiting for the
      // airflow debounce. This is the "scoring starts right as preheat
      // ends" behavior. The state transition itself is the trigger,
      // which also sidesteps the preheat-noise false positives the
      // debounce guarded against (a noisy reading during PREHEAT can no
      // longer start a dab because PREHEAT never satisfies this edge).
      if (dabState === 'idle' && preheatJustEnded) {
        dabCalibratePreheatOffset();
        dabDebounceCount = 0;
        showDabPanel();
        startDabSession();
        return;
      }
      // Hard gate: never start scoring while the device is preheating,
      // fading, or just sitting at idle. A 12% reading on a chamber
      // that hasn't finished ramping up is noise. Reached when scoring
      // was enabled mid-cycle and no preheat->active edge was observed,
      // in which case we fall back to the sustained-draw debounce below.
      if (!dabIsDrawingState(data)) {
        dabDebounceCount = 0;
        return;
      }
      if (percent >= dabThreshold) {
        dabDebounceCount++;
        if (dabDebounceCount >= DAB_DEBOUNCE_SAMPLES && dabState === 'idle') {
          showDabPanel();
          startDabSession();
        }
      } else {
        dabDebounceCount = 0;
      }
      return;
    }

    if (dabState === 'active') {
      // Even inside an active session, double-check the device is still
      // in HEAT_CYCLE_ACTIVE. If something flipped it back to PREHEAT
      // mid-dab (rare but observed when a profile finishes early), keep
      // sampling — the existing airflow-based end detection is
      // sufficient to terminate the session.
      dabRecordActiveSample(percent, now);
    }
    // No-op for 'results' — the panel is in its final state until the
    // user either dismisses it or taps "Again".
  }

  // Record one airflow sample into the live session and run the
  // end-of-dab detection. Shared by the 1Hz status poll and the 250ms
  // fast sampler so both feeds obey identical rules. Samples carry the
  // calibrated 0-1 airflow (scoring) AND the raw percent (UI).
  function dabRecordActiveSample(percent, now = Date.now()) {
    if (dabState !== 'active') return;
    const af = dabCalibrate(percent);
    dabSamples.push({ ts: now, airflow: af, raw: percent });

    // Check for dab end: airflow below threshold for too long
    if (percent < dabThreshold) {
      if (!dabDroppedBelowAt) dabDroppedBelowAt = now;
      if (now - dabDroppedBelowAt > dabDropTimeoutMs) {
        endDabSession();
        return;
      }
    } else {
      dabDroppedBelowAt = null;
    }

    // Force-end if running longer than the configured cap
    if (now - dabStartTime > dabMaxDurationMs) {
      endDabSession();
    }
  }

  // ---- Fast sampler ----
  // While a session is live on browser BLE, read just the pinned
  // draw-strength characteristic every DAB_FAST_SAMPLE_MS. A single
  // characteristic read is cheap compared to the full status snapshot,
  // so the chart, live score, and session strip update at ~4Hz instead
  // of riding the 1Hz poll. Falls back silently to 1Hz sampling on the
  // bridge transport or when no source is pinned yet.
  let dabFastTimer = null;
  let dabFastInFlight = false;

  function dabStartFastSampler() {
    if (dabFastTimer) return;
    if (!dabFastSamplerEnabled) return;
    dabFastTimer = setInterval(async () => {
      // Runs during BOTH preheat and the live session. During preheat
      // it watches the state register directly, so the scoring session
      // starts within one fast tick (~150ms) of the chamber becoming
      // drawable instead of waiting for the next 1Hz status poll.
      if (dabState !== 'active' && dabState !== 'preheating') {
        dabStopFastSampler();
        return;
      }
      if (dabFastInFlight) return;
      if (transportMode !== 'browser_ble') return;
      let client = null;
      try { client = getBrowserBle(); } catch { return; }
      if (!client?.connected) return;
      dabFastInFlight = true;
      try {
        if (dabState === 'preheating') {
          // 8 === HEAT_CYCLE_ACTIVE in the firmware state machine.
          const stateId = await client.readUint8('/p/app/stat/id');
          if (Number(stateId) === 8 && dabState === 'preheating') {
            dabCalibratePreheatOffset();
            dabDebounceCount = 0;
            startDabSession();
            return;
          }
        } else {
          const src = client.drawStrengthSource;
          if (!src?.path) return;
          const reading = await client.readDrawStrengthPath(src.path, src.mode);
          if (reading && dabState === 'active') {
            if (reading.percent > dabSessionPeakRaw) dabSessionPeakRaw = reading.percent;
            const norm = dabNormalizePercent(reading.percent);
            dabRecordActiveSample(norm);
            dabApplyFastReadingToUi(norm);
          }
        }
      } catch { /* next tick retries */ }
      finally { dabFastInFlight = false; }
    }, DAB_FAST_SAMPLE_MS);
  }

  function dabStopFastSampler() {
    if (dabFastTimer) {
      clearInterval(dabFastTimer);
      dabFastTimer = null;
    }
    dabFastInFlight = false;
  }

  // ---- Idle bar poll ----
  // The 1Hz status snapshot is the only feed the inhale panel got
  // before a scoring session started, so the bar could lag a full
  // second behind the user's actual inhale. The idle poll reads the
  // pinned /p/app/htr/inh characteristic at ~10Hz and feeds it to
  // the bar / readout so the bar feels live between sessions too.
  // Stops automatically when the user is disconnected, when there's
  // no source pinned yet (the bar falls back to the 1Hz snapshot
  // until the redetect resolver picks one), and when a fast sampler
  // is already running (the two would just collide on the radio).
  let dabIdleBarTimer = null;
  let dabIdleBarInFlight = false;
  function dabStartIdleBarPoll() {
    if (dabIdleBarTimer) return;
    if (transportMode !== 'browser_ble') return;
    let client = null;
    try { client = getBrowserBle(); } catch { return; }
    if (!client?.connected) return;
    dabIdleBarTimer = setInterval(async () => {
      if (dabIdleBarInFlight) return;
      if (!drawBarState.connected) { dabStopIdleBarPoll(); return; }
      // Don't fight the scoring-session sampler for the radio.
      if (dabFastTimer) return;
      let c = null;
      try { c = getBrowserBle(); } catch { return; }
      if (!c?.connected) { dabStopIdleBarPoll(); return; }
      const src = c.drawStrengthSource;
      if (!src?.path) return; // wait for the resolver to pick a path
      dabIdleBarInFlight = true;
      try {
        const reading = await c.readDrawStrengthPath(src.path, src.mode);
        if (reading && Number.isFinite(reading.percent)) {
          const norm = dabNormalizePercent(reading.percent);
          dabApplyFastReadingToUi(norm);
        }
      } catch { /* next tick retries */ }
      finally { dabIdleBarInFlight = false; }
    }, DAB_IDLE_BAR_SAMPLE_MS);
  }
  function dabStopIdleBarPoll() {
    if (dabIdleBarTimer) {
      clearInterval(dabIdleBarTimer);
      dabIdleBarTimer = null;
    }
    dabIdleBarInFlight = false;
  }

  // Push a fast sample into the visible readouts between status polls:
  // the inhale panel bar/number, the session strip Draw cell, and
  // (during preheat + active) the preheat view's live airflow bar so
  // the user can see their draw strength while the chamber is still
  // warming. The full updateDrawStrengthUI pass still runs on each
  // 1Hz snapshot.
  function dabApplyFastReadingToUi(percent) {
    const p = Math.max(0, Math.min(DAB_UI_AIRFLOW_MAX, Math.round(Number(percent) || 0)));
    drawBarState.target = Math.min(100, p);
    if (drawBarState.connected) startDrawBarLoop();
    const readout = document.getElementById('draw-strength-readout');
    if (readout && drawBarState.lastReadoutPct !== p) {
      readout.textContent = `${p}%`;
      drawBarState.lastReadoutPct = p;
    }
    const strip = document.getElementById('dab-session-strip');
    const drawEl = document.getElementById('dab-session-draw');
    if (strip && drawEl && !strip.classList.contains('hidden')) {
      drawEl.textContent = `${p}%`;
      strip.classList.toggle('drawing', p >= dabThreshold);
    }
    // Preheat / active airflow row — only write when the preheat
    // view is actually visible so we don't churn the DOM on the
    // 10Hz idle poll while the user is in another tab.
    const preheatPanel = document.getElementById('dab-preheat-view');
    if (preheatPanel && !preheatPanel.classList.contains('hidden')) {
      const fill = document.getElementById('dab-preheat-airflow-fill');
      const out = document.getElementById('dab-preheat-airflow-readout');
      if (fill) fill.style.width = `${Math.min(100, p)}%`;
      if (out) out.textContent = `${p}%`;
    }
  }

  function startDabSession() {
    if (dabState === 'active') return; // never restart a live session
    dabState = 'active';
    dabSamples = [];
    dabSessionPeakRaw = 0;
    dabDroppedBelowAt = null;
    dabDebounceCount = 0;
    dabStartTime = Date.now();
    cancelPreheatIntro();
    dabShowView('dab-active-view');
    dabRenderSessionStrip(deviceState);
    document.getElementById('dab-live-score').textContent = '—';
    document.getElementById('dab-peak-display').textContent = '—';
    document.getElementById('dab-time-display').textContent = '0.0s';
    document.getElementById('dab-zone-display').textContent = '—';

    const canvas = document.getElementById('dab-canvas');
    dabCanvasCtx = canvas.getContext('2d');
    dabStartFastSampler();
    drawDabLiveFrame();
  }

  function drawDabLiveFrame() {
    if (dabState !== 'active') return;
    const ctx = dabCanvasCtx;
    const canvas = ctx.canvas;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // The chart's vertical scale is raw percent 0..DAB_UI_AIRFLOW_MAX
    // so hard pulls above 100% stay visible instead of flat-lining at
    // the top. Helper maps a sample to that scale (older samples
    // without .raw reconstruct it from the calibrated airflow).
    const rawOf = (s) => (Number.isFinite(s.raw) ? s.raw : s.airflow * 100);
    const yOf = (s) => H * (1 - Math.min(1, rawOf(s) / DAB_UI_AIRFLOW_MAX));

    // Ideal zone band, converted from scoring units (0-1 of device
    // max) to the normalized percent scale.
    const zoneTopRaw = DAB_IDEAL_MAX * 100;
    const zoneBotRaw = DAB_IDEAL_MIN * 100;
    const yMin = H * (1 - zoneTopRaw / DAB_UI_AIRFLOW_MAX);
    const yMax = H * (1 - zoneBotRaw / DAB_UI_AIRFLOW_MAX);
    ctx.fillStyle = 'rgba(192, 132, 252, 0.08)';
    ctx.fillRect(0, yMin, W, yMax - yMin);
    // 100% reference line so overshoot reads clearly.
    const y100 = H * (1 - 100 / DAB_UI_AIRFLOW_MAX);
    ctx.strokeStyle = 'rgba(233, 213, 255, 0.18)';
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y100);
    ctx.lineTo(W, y100);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw samples as a line
    if (dabSamples.length < 2) {
      dabAnimationFrame = requestAnimationFrame(drawDabLiveFrame);
      return;
    }

    // Rolling window: show the last ~15 seconds of samples (the fast
    // sampler produces ~4 per second).
    const recent = dabSamples.slice(-Math.ceil(15000 / DAB_FAST_SAMPLE_MS));
    const minTs = recent[0].ts;
    const maxTs = Date.now();
    const span = Math.max(1, maxTs - minTs || 1);
    const pts = recent.map((s) => ({
      x: W * ((s.ts - minTs) / span),
      y: yOf(s),
    }));

    // Smoothed path through quadratic midpoints so the line reads as
    // one continuous draw instead of 1Hz segments.
    const traceLine = () => {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i += 1) {
        const xc = (pts[i].x + pts[i + 1].x) / 2;
        const yc = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    };

    // Soft gradient fill under the curve.
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(192, 132, 252, 0.30)');
    grad.addColorStop(1, 'rgba(192, 132, 252, 0.02)');
    ctx.beginPath();
    traceLine();
    ctx.lineTo(pts[pts.length - 1].x, H);
    ctx.lineTo(pts[0].x, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Glowing accent stroke on top.
    ctx.beginPath();
    traceLine();
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(192, 132, 252, 0.55)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Live dot on the newest sample.
    const tip = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e9d5ff';
    ctx.shadowColor = 'rgba(192, 132, 252, 0.9)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Current values. Peak is shown in RAW sensor percent so it
    // matches the inhale panel and can exceed 100% on a hard pull.
    const peakRaw = Math.max(...dabSamples.map(rawOf));
    const duration = ((Date.now() - dabStartTime) / 1000).toFixed(1);
    const inZone = dabSamples.filter(s => s.airflow >= DAB_IDEAL_MIN && s.airflow <= DAB_IDEAL_MAX).length;
    const zonePct = Math.round((inZone / dabSamples.length) * 100);
    const liveScore = calcDabScore(dabSamples);

    document.getElementById('dab-live-score').textContent = liveScore.toFixed(0);
    document.getElementById('dab-peak-display').textContent = Math.round(peakRaw) + '%';
    document.getElementById('dab-time-display').textContent = duration + 's';
    document.getElementById('dab-zone-display').textContent = zonePct + '%';

    dabAnimationFrame = requestAnimationFrame(drawDabLiveFrame);
  }

  function endDabSession() {
    dabState = 'results';
    dabStopFastSampler();
    dabDecayLearnedMax(dabSessionPeakRaw);
    if (dabAnimationFrame) cancelAnimationFrame(dabAnimationFrame);
    dabDebounceCount = 0;
    dabRenderSessionStrip(deviceState);

    const result = calcDabFullScore(dabSamples);
    showDabResults(result);

    // Don't save obviously-bogus sessions: fewer than 5 samples (less
    // than ~1 second of drawing) means the user closed the panel or the
    // device dropped out before the score meant anything. The
    // 'insufficient' marker also tells the results view to show the
    // friendly empty state.
    if (result.samples >= DAB_MIN_SAMPLES_FOR_SCORE) {
      const history = getDabHistory();
      history.unshift({ ...result, ts: Date.now() });
      if (history.length > 100) history.length = 100;
      saveDabHistory(history);
      // Bump the cleaning-reminder counter when this dab is long
      // enough to count (>5s). Cleaning cycles never reach this
      // branch, so they're correctly excluded.
      bumpCleaningCounter();
    }
    updateDabHistorySummary();
    updateCleaningReminder();
  }

  function calcDabScore(samples) {
    if (!samples || samples.length < DAB_MIN_SAMPLES_FOR_SCORE) return 0;
    return calcDabScoreInternal(samples);
  }

  function calcDabFullScore(samples) {
    if (!samples || samples.length < DAB_MIN_SAMPLES_FOR_SCORE) {
      return {
        total: 0, flow: 0, consistency: 0, target: 0, stability: 0,
        finish: 0, style: 0, peak: 0, duration: 0, samples: samples?.length || 0,
        insufficient: true,
      };
    }
    const r = calcDabFullScoreInternal(samples);
    r.insufficient = false;
    return r;
  }

  // Split out the original scoring math so calcDabScore and
  // calcDabFullScore can share it. The pre-guard is enforced in the
  // public wrappers above.
  function calcDabScoreInternal(samples) {
    const target = DAB_TARGET_FLOW[dabDifficulty] || 30;
    const totalFlow = samples.reduce((sum, s, i) => {
      const dt = i > 0 ? (s.ts - samples[i-1].ts) / 1000 : 0.016;
      return sum + s.airflow * dt;
    }, 0);
    const mean = samples.reduce((s, x) => s + x.airflow, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + Math.pow(x.airflow - mean, 2), 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const consistency = Math.max(0, 1 - stdDev / DAB_MAX_VARIANCE);
    const inZone = samples.filter(s => s.airflow >= DAB_IDEAL_MIN && s.airflow <= DAB_IDEAL_MAX).length;
    const targetZone = inZone / samples.length;
    const duration = ((samples[samples.length-1].ts - samples[0].ts) / 1000) || 1;
    const targetDuration = { casual: 15, standard: 30, beast: 45 }[dabDifficulty] || 30;
    const finishBonus = Math.min(1, duration / targetDuration);
    const jumps = samples.slice(1).reduce((sum, s, i) => sum + Math.abs(s.airflow - samples[i].airflow), 0);
    const stability = Math.max(0, 1 - jumps / (samples.length * 0.5));
    const rawScore = (
      (Math.min(totalFlow / target, 1) * 0.25) +
      (consistency * 0.30) +
      (targetZone * 0.20) +
      (stability * 0.10) +
      (finishBonus * 0.10)
    ) * 10000;
    return Math.max(0, Math.min(10000, rawScore));
  }

  function calcDabFullScoreInternal(samples) {
    const target = DAB_TARGET_FLOW[dabDifficulty] || 30;
    const totalFlow = samples.reduce((sum, s, i) => {
      const dt = i > 0 ? (s.ts - samples[i-1].ts) / 1000 : 0.016;
      return sum + s.airflow * dt;
    }, 0);
    const mean = samples.reduce((s, x) => s + x.airflow, 0) / samples.length;
    const variance = samples.reduce((s, x) => s + Math.pow(x.airflow - mean, 2), 0) / samples.length;
    const stdDev = Math.sqrt(variance);
    const consistency = Math.max(0, 1 - stdDev / DAB_MAX_VARIANCE);
    const inZone = samples.filter(s => s.airflow >= DAB_IDEAL_MIN && s.airflow <= DAB_IDEAL_MAX).length;
    const targetZone = inZone / samples.length;
    const duration = ((samples[samples.length-1].ts - samples[0].ts) / 1000) || 1;
    const targetDuration = { casual: 15, standard: 30, beast: 45 }[dabDifficulty] || 30;
    const finishBonus = Math.min(1, duration / targetDuration);
    const jumps = samples.slice(1).reduce((sum, s, i) => sum + Math.abs(s.airflow - samples[i].airflow), 0);
    const stability = Math.max(0, 1 - jumps / (samples.length * 0.5));

    // Style: check ramp-up / plateau / cooldown shape
    const n = samples.length;
    const earlyThird = samples.slice(0, Math.max(1, Math.floor(n / 3)));
    const lateThird = samples.slice(Math.floor(2 * n / 3));
    const earlyMean = earlyThird.reduce((s, x) => s + x.airflow, 0) / earlyThird.length;
    const lateMean = lateThird.reduce((s, x) => s + x.airflow, 0) / lateThird.length;
    const rampUp = earlyMean < mean + 0.05 ? 1 : 0;
    const rampDown = lateMean < mean + 0.05 ? 1 : 0;
    const style = ((rampUp + rampDown) / 2) * consistency;

    const rawTotal = (
      (Math.min(totalFlow / target, 1) * 0.25) +
      (consistency * 0.30) +
      (targetZone * 0.20) +
      (stability * 0.10) +
      (finishBonus * 0.10) +
      (style * 0.05)
    ) * 10000;

    return {
      total: Math.max(0, Math.min(10000, rawTotal)),
      flow: Math.min(totalFlow / target, 1) * 2500,
      consistency: consistency * 3000,
      target: targetZone * 2000,
      stability: stability * 1000,
      finish: finishBonus * 1000,
      style: style * 500,
      // Peak in RAW sensor percent (can exceed 100 on a hard pull) so
      // results match the live chart and the inhale panel.
      peak: Math.max(...samples.map((s) => (Number.isFinite(s.raw) ? s.raw : s.airflow * 100))),
      duration: parseFloat(duration.toFixed(1)),
      samples: samples.length,
    };
  }

  // Eased count-up for the big result numbers. Falls back to an
  // instant write when the user prefers reduced motion.
  function dabAnimateCountUp(el, target, durationMs = 900) {
    if (!el) return;
    const final = Math.round(Number(target) || 0);
    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || final <= 0) {
      el.textContent = final;
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      el.textContent = Math.round(final * eased);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function showDabResults(r) {
    document.getElementById('dab-active-view').classList.add('hidden');
    document.getElementById('dab-results-view').classList.remove('hidden');
    const emptyEl = document.getElementById('dab-results-empty');
    const numbersEl = document.getElementById('dab-results-numbers');
    const insufficient = r.insufficient === true || r.samples < DAB_MIN_SAMPLES_FOR_SCORE;

    if (insufficient) {
      if (emptyEl) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = 'Need at least 1 second of drawing to score.';
      }
      if (numbersEl) numbersEl.classList.add('hidden');
      document.getElementById('dab-final-score').textContent = '—';
      document.getElementById('dab-score-flow').textContent = '—';
      document.getElementById('dab-score-consistency').textContent = '—';
      document.getElementById('dab-score-target').textContent = '—';
      document.getElementById('dab-score-stability').textContent = '—';
      document.getElementById('dab-score-finish').textContent = '—';
      document.getElementById('dab-score-style').textContent = '—';
      document.getElementById('dab-result-peak').textContent = '—';
      document.getElementById('dab-result-duration').textContent = '—';
      document.getElementById('dab-result-samples').textContent = r.samples || 0;
      // Empty result chart — no useful curve to draw
      const canvas = document.getElementById('dab-result-canvas');
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');
    if (numbersEl) numbersEl.classList.remove('hidden');
    // The headline total counts up in sync with its pop-in animation;
    // the component scores cascade in via the staggered row entrance
    // (see dabRowIn in style.css) with shorter count-ups of their own.
    dabAnimateCountUp(document.getElementById('dab-final-score'), r.total, 900);
    dabAnimateCountUp(document.getElementById('dab-score-flow'), r.flow, 600);
    dabAnimateCountUp(document.getElementById('dab-score-consistency'), r.consistency, 600);
    dabAnimateCountUp(document.getElementById('dab-score-target'), r.target, 600);
    dabAnimateCountUp(document.getElementById('dab-score-stability'), r.stability, 600);
    dabAnimateCountUp(document.getElementById('dab-score-finish'), r.finish, 600);
    dabAnimateCountUp(document.getElementById('dab-score-style'), r.style, 600);
    document.getElementById('dab-result-peak').textContent = Math.round(r.peak) + '%';
    document.getElementById('dab-result-duration').textContent = r.duration + 's';
    document.getElementById('dab-result-samples').textContent = r.samples;

    // Draw result chart — same raw-percent scale, smoothed curve, and
    // gradient fill as the live chart so the recap reads identically.
    const canvas = document.getElementById('dab-result-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const rawOf = (s) => (Number.isFinite(s.raw) ? s.raw : s.airflow * 100);
    const yMin = H * (1 - (DAB_IDEAL_MAX * 100) / DAB_UI_AIRFLOW_MAX);
    const yMax = H * (1 - (DAB_IDEAL_MIN * 100) / DAB_UI_AIRFLOW_MAX);
    ctx.fillStyle = 'rgba(192, 132, 252, 0.08)';
    ctx.fillRect(0, yMin, W, yMax - yMin);
    if (dabSamples.length > 1) {
      const minTs = dabSamples[0].ts;
      const maxTs = dabSamples[dabSamples.length - 1].ts;
      const range = Math.max(1, maxTs - minTs);
      const pts = dabSamples.map((s) => ({
        x: W * ((s.ts - minTs) / range),
        y: H * (1 - Math.min(1, rawOf(s) / DAB_UI_AIRFLOW_MAX)),
      }));
      const traceLine = () => {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i += 1) {
          const xc = (pts[i].x + pts[i + 1].x) / 2;
          const yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      };
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, 'rgba(192, 132, 252, 0.26)');
      grad.addColorStop(1, 'rgba(192, 132, 252, 0.02)');
      ctx.beginPath();
      traceLine();
      ctx.lineTo(pts[pts.length - 1].x, H);
      ctx.lineTo(pts[0].x, H);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.beginPath();
      traceLine();
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  // Show exactly one of the dab panel's view sub-panels, hide the rest.
  // Centralized so the new preheat and diagnostic views don't have to
  // memorize every other view id.
  const DAB_VIEW_IDS = [
    'dab-idle-view',
    'dab-preheat-view',
    'dab-diagnostic-view',
    'dab-active-view',
    'dab-results-view',
  ];
  function dabShowView(activeId) {
    for (const id of DAB_VIEW_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (id === activeId) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  }

  // Show the "Get ready" intro overlay for `seconds` with a 3-2-1
  // countdown, then fade it out. The fast-sampler-driven live
  // airflow bar keeps ticking underneath the intro the whole time,
  // so the user can see their draw respond to their inhale.
  let dabPreheatIntroTimer = null;
  function showPreheatIntro(seconds = 3) {
    const intro = document.getElementById('dab-preheat-intro');
    const num = document.getElementById('dab-preheat-intro-countdown');
    if (!intro || !num) return;
    intro.classList.remove('dab-preheat-intro-hidden');
    if (dabPreheatIntroTimer) { clearInterval(dabPreheatIntroTimer); dabPreheatIntroTimer = null; }
    let n = Math.max(0, Math.ceil(seconds));
    num.textContent = String(n);
    dabPreheatIntroTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        num.textContent = String(n);
        // Re-render the steady timer (subtitle) as we tick so the
        // "scoring will start" line is already showing by the time
        // the intro fades.
        dabRenderPreheatView(deviceState);
      } else {
        clearInterval(dabPreheatIntroTimer);
        dabPreheatIntroTimer = null;
        intro.classList.add('dab-preheat-intro-hidden');
        // One more render after the fade to flip the subtitle back on.
        dabRenderPreheatView(deviceState);
      }
    }, 1000);
  }
  function cancelPreheatIntro() {
    if (dabPreheatIntroTimer) {
      clearInterval(dabPreheatIntroTimer);
      dabPreheatIntroTimer = null;
    }
    const intro = document.getElementById('dab-preheat-intro');
    if (intro) intro.classList.add('dab-preheat-intro-hidden');
  }

  // The firmware's preheat elapsed/total pair consistently runs a few
  // seconds short of the real PREHEAT -> ACTIVE transition (~2-3.5s on
  // the hardware tested), so a raw countdown hits 0:00 while the
  // chamber is still ramping. Learn the per-device offset: anchor the
  // first firmware sample of each preheat, compare its predicted end
  // with the observed transition, and keep an EMA persisted across
  // sessions. The offset is added to the displayed countdown only
  // while the device is actually in HEAT_CYCLE_PREHEAT.
  const DAB_PREHEAT_OFFSET_KEY = 'puffco:dab_preheat_offset_v1';
  const DAB_PREHEAT_OFFSET_MIN = -5;
  const DAB_PREHEAT_OFFSET_MAX = 15;
  let dabPreheatOffset = (() => {
    try {
      const v = Number(localStorage.getItem(DAB_PREHEAT_OFFSET_KEY));
      return Number.isFinite(v)
        ? Math.max(DAB_PREHEAT_OFFSET_MIN, Math.min(DAB_PREHEAT_OFFSET_MAX, v))
        : 0;
    } catch { return 0; }
  })();
  // First firmware-backed sample of the current preheat: { raw, at }.
  // Cleared on the PREHEAT -> ACTIVE edge (after calibration), on
  // cancel, and on panel close.
  let dabPreheatTrack = null;

  // Called on the observed PREHEAT -> ACTIVE transition. Compares how
  // long the preheat actually took from the anchored sample against
  // what the firmware timer predicted, and folds the error into the
  // learned offset (50/50 EMA so one weird cycle can't wreck it).
  function dabCalibratePreheatOffset() {
    const track = dabPreheatTrack;
    dabPreheatTrack = null;
    if (!track || !Number.isFinite(track.raw)) return;
    const actual = (Date.now() - track.at) / 1000;
    const error = actual - track.raw;
    // Ignore nonsense (user cancelled + restarted, clock jumps, etc.)
    if (!Number.isFinite(error) || error < -10 || error > 20) return;
    dabPreheatOffset = Math.max(
      DAB_PREHEAT_OFFSET_MIN,
      Math.min(DAB_PREHEAT_OFFSET_MAX, dabPreheatOffset * 0.5 + error * 0.5),
    );
    try {
      localStorage.setItem(DAB_PREHEAT_OFFSET_KEY, String(Math.round(dabPreheatOffset * 100) / 100));
    } catch { /* ignore */ }
  }

  // Render the M:SS countdown the same way the status card's "Timer"
  // row does. Falls back to the firmware elapsed/total pair when the
  // helper doesn't have a high-confidence remaining value, so the user
  // sees a number even on the very first poll after entering preheat.
  // During preheat, firmware-backed values get the learned offset
  // added, and once the firmware timer pins at zero the countdown
  // keeps ticking from the anchored prediction instead of freezing at
  // 0:00 for the last few seconds.
  function dabComputePreheatRemaining(data) {
    const report = getHeatReport(data);
    const preheating = normalizeStateKey(data?.state) === 'HEAT_CYCLE_PREHEAT';
    let raw = null;
    let source = 'none';
    const dynamic = getDynamicRemainingSeconds(report);
    if (dynamic != null) {
      raw = dynamic;
      source = 'firmware';
    } else {
      const elapsed = Number(report?.firmware_elapsed_s);
      const total = Number(report?.firmware_total_s);
      if (Number.isFinite(elapsed) && Number.isFinite(total) && total > 0) {
        raw = Math.max(0, total - elapsed);
        source = 'firmware_total_minus_elapsed';
      } else {
        // Worst case: just show the profile duration so the panel
        // doesn't read "0:00" while we wait for the first firmware
        // sample.
        const selectedProfile = getSelectedProfile(data);
        const profileTime = Number(selectedProfile?.time_s);
        if (Number.isFinite(profileTime) && profileTime > 0) {
          raw = profileTime;
          source = 'profile_duration';
        }
      }
    }
    if (raw == null) return { seconds: null, source };
    if (!preheating || !source.startsWith('firmware')) {
      return { seconds: raw, source };
    }
    // Anchor the calibration on the first firmware-backed sample of
    // this preheat.
    if (!dabPreheatTrack) dabPreheatTrack = { raw, at: Date.now() };
    if (raw <= 0.5) {
      // Firmware timer pinned at zero but the chamber isn't ready yet:
      // tick down the remainder of the anchored prediction.
      const predicted = (dabPreheatTrack.at + (dabPreheatTrack.raw + dabPreheatOffset) * 1000 - Date.now()) / 1000;
      return { seconds: Math.max(0, predicted), source: `${source}+learned_offset` };
    }
    return { seconds: Math.max(0, raw + dabPreheatOffset), source: `${source}+learned_offset` };
  }

  // Live session strip shared by the preheat, countdown, and active
  // views: device state, current -> target temp, heat-cycle remaining
  // timer, and the live draw %. Hidden in idle/results/diagnostic so
  // those views keep their existing layout.
  const DAB_SESSION_STRIP_STATES = ['preheating', 'active'];
  function dabRenderSessionStrip(data) {
    const strip = document.getElementById('dab-session-strip');
    if (!strip) return;
    const show = DAB_SESSION_STRIP_STATES.includes(dabState) && Boolean(data?.connected);
    strip.classList.toggle('hidden', !show);
    if (!show) return;
    const stateEl = document.getElementById('dab-session-state');
    const tempEl = document.getElementById('dab-session-temp');
    const targetEl = document.getElementById('dab-session-target');
    const timerEl = document.getElementById('dab-session-timer');
    const drawEl = document.getElementById('dab-session-draw');
    if (stateEl) stateEl.textContent = formatDeviceState(data?.state) || '—';
    if (tempEl) {
      const temp = Number(data?.current_temperature_f);
      tempEl.textContent = Number.isFinite(temp) ? `${Math.round(temp)}°` : '—';
    }
    if (targetEl) {
      const target = Number(data?.target_temperature_f);
      targetEl.textContent = Number.isFinite(target) && target > 0 ? `→${Math.round(target)}°` : '';
    }
    if (timerEl) {
      // Same remaining-seconds resolution the preheat view and the
      // status card use, so all three timers always agree.
      const { seconds } = dabComputePreheatRemaining(data);
      timerEl.textContent = seconds == null ? '—' : formatSecondsClock(seconds);
    }
    if (drawEl) {
      const percent = Math.max(0, Math.min(DAB_UI_AIRFLOW_MAX, Math.round(dabNormalizePercent(Number(data?.draw_strength_percent) || 0))));
      drawEl.textContent = `${percent}%`;
      // Glow the Draw cell while the sensor is above the scoring
      // threshold (smooth color transition lives in style.css).
      strip.classList.toggle('drawing', percent >= dabThreshold);
    }
  }

  function dabRenderPreheatView(data) {
    const timerEl = document.getElementById('dab-preheat-timer');
    const stateEl = document.getElementById('dab-preheat-state');
    const subEl = document.getElementById('dab-preheat-subtitle');
    if (stateEl) stateEl.textContent = formatDeviceState(data?.state) || 'Preheating';
    const { seconds, source } = dabComputePreheatRemaining(data);
    if (timerEl) {
      if (seconds == null) {
        timerEl.textContent = '—';
        timerEl.setAttribute('data-source', source);
      } else {
        timerEl.textContent = formatSecondsClock(seconds);
        timerEl.setAttribute('data-source', source);
      }
    }
    // While the "Get ready" intro is up, hide the steady-state
    // subtitle so the two don't compete. After the intro fades, the
    // subtitle comes back to clarify that scoring is about to start.
    const introEl = document.getElementById('dab-preheat-intro');
    const introHidden = introEl?.classList.contains('dab-preheat-intro-hidden');
    if (subEl) {
      subEl.textContent = introHidden
        ? 'Scoring will start when the chamber is ready to draw.'
        : '';
      subEl.style.visibility = introHidden ? 'visible' : 'hidden';
    }
  }

  // Pop the panel into the preheat view. Called from startDab() when
  // the device is already mid-preheat, or from dabOnStatus() when the
  // device transitions to preheat while the panel is open. The
  // "Get ready" intro is shown for the first ~3 seconds so the user
  // can prepare their inhale and see their draw strength before
  // scoring locks in.
  function dabShowPreheatView(data) {
    dabState = 'preheating';
    dabDebounceCount = 0;
    showDabPanel();
    dabShowView('dab-preheat-view');
    dabRenderPreheatView(data || deviceState);
    dabRenderSessionStrip(data || deviceState);
    // Kick the "Get ready" intro: visible now, then a 3-2-1 number,
    // then fade. 3s is enough to draw breath + position the device
    // without making the steady timer feel late. Respects prefers-
    // reduced-motion (the CSS transition collapses to instant).
    showPreheatIntro(3);
    // Watch the state register at fast-sample rate so scoring starts
    // the moment the chamber is ready — no 1Hz poll lag.
    dabStartFastSampler();
  }

  // User hit "Cancel" on the preheat view, or the device dropped out
  // of the heat cycle before scoring could start. Treat it as
  // discarded — no history entry, no score.
  function dabCancelPreheating() {
    dabState = 'idle';
    dabDebounceCount = 0;
    dabSamples = [];
    dabPreheatTrack = null;
    dabStopFastSampler();
    cancelPreheatIntro();
    dabShowView('dab-idle-view');
    dabRenderSessionStrip(deviceState);
  }

  function showDabPanel() {
    const panel = document.getElementById('dab-panel');
    if (!panel) return;
    panel.classList.add('visible');
    // One-time outside-click handler: dismisses the panel when the
    // user taps anywhere outside the inner card. Bound on show, torn
    // down on close so a stale handler can't fire after the panel
    // is gone.
    if (!panel._outsideHandler) {
      panel._outsideHandler = (event) => {
        if (!panel.classList.contains('visible')) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (panel.contains(target)) return;
        // Don't dismiss if the click opened us — e.g. a button that
        // also calls startDab() shouldn't immediately close on itself.
        if (target.closest('[data-dab-open-trigger]')) return;
        closeDabPanel();
      };
      document.addEventListener('mousedown', panel._outsideHandler);
      document.addEventListener('touchstart', panel._outsideHandler, { passive: true });
    }
  }

  function closeDabPanel() {
    if (dabAnimationFrame) cancelAnimationFrame(dabAnimationFrame);
    dabStopFastSampler();
    dabStopDiagnostic();
    cancelPreheatIntro();
    dabState = 'idle';
    dabSamples = [];
    dabDebounceCount = 0;
    dabLastStateKey = '';
    dabPreheatTrack = null;
    dabRenderSessionStrip(deviceState);
    const panel = document.getElementById('dab-panel');
    if (panel) {
      panel.classList.remove('visible');
      if (panel._outsideHandler) {
        document.removeEventListener('mousedown', panel._outsideHandler);
        document.removeEventListener('touchstart', panel._outsideHandler);
        panel._outsideHandler = null;
      }
    }
  }

  function startDab() {
    const all = getAllSettings();
    dabEnabled = Boolean(all.dabEnabled);
    if (!dabEnabled) {
      toast('Enable dab scoring in Settings > Dab first', 'warning');
      return;
    }
    if (!connected) {
      toast('Connect to a device to use dab scoring', 'warning');
      return;
    }
    dabDifficulty = all.dabDifficulty || 'standard';
    dabThreshold = Number(all.dabThreshold || 12);
    dabSamples = [];
    dabDebounceCount = 0;
    showDabPanel();
    // Re-render the IDLE labels with the current settings.
    document.getElementById('dab-idle-difficulty').textContent =
      { casual: 'Casual', standard: 'Standard', beast: 'Beast' }[dabDifficulty] || 'Standard';
    document.getElementById('dab-idle-threshold').textContent = dabThreshold + '%';
    // Show / hide the diagnostic button based on connection.
    const diagBtn = document.getElementById('btn-dab-diagnostic');
    if (diagBtn) {
      const canRun = dabEnabled && connected;
      diagBtn.classList.toggle('hidden', !canRun);
    }

    // Route straight to the preheat view if the device is already
    // heating. The 3-2-1 countdown is for users who tap "Start Dab"
    // when the device is idle, then the heat cycle starts and we have
    // no idea when the chamber will be ready.
    const ds = deviceState;
    if (ds && isHeatActive(ds) && normalizeStateKey(ds.state) === 'HEAT_CYCLE_PREHEAT') {
      dabShowPreheatView(ds);
      return;
    }
    if (ds && isHeatActive(ds) && normalizeStateKey(ds.state) === 'HEAT_CYCLE_ACTIVE') {
      // Device is already in the drawing state — skip the preheat view.
      // The sustained-draw debounce in dabOnStatus starts the session
      // as soon as a real draw is detected.
      dabState = 'idle';
      dabDebounceCount = 0;
      dabShowView('dab-idle-view');
      return;
    }
    dabState = 'idle';
    dabShowView('dab-idle-view');
  }

  function stopDab() {
    if (dabState === 'active') endDabSession();
  }

  function saveDabScore() {
    toast('Score saved to history', 'success');
  }

  function updateDabHistorySummary() {
    const history = getDabHistory();
    const el = document.getElementById('dab-score-history-summary');
    if (!el) return;
    if (history.length === 0) {
      el.textContent = 'No dabs recorded yet.';
    } else {
      // Filter out any insufficient entries a previous version of the
      // scorer may have written — the new gate only saves real ones.
      const realScores = history.filter(h => h && h.insufficient !== true && (h.samples || 0) >= DAB_MIN_SAMPLES_FOR_SCORE);
      if (realScores.length === 0) {
        el.textContent = 'No dabs recorded yet.';
      } else {
        const best = Math.max(...realScores.map(h => h.total));
        el.textContent = `${realScores.length} dab${realScores.length === 1 ? '' : 's'} recorded · best: ${Math.round(best)}`;
      }
    }
  }

  // Cleaning reminder counter — the status card mirrors a
  // "current / threshold" pair that the user sets in Settings. A dab
  // only counts when its scored duration is > 5 s (below that, the
  // user didn't really take a real draw — it was a click-and-bail or
  // a preheat-only session). Cleaning cycles never increment the
  // counter (they don't go through the scoring pipeline at all).
  // The counter lives in its own localStorage key rather than in the
  // score history, so wiping the score history doesn't reset the
  // cleaning progress (and vice versa). The user can also reset it
  // manually from the settings page or the status card.
  const CLEANING_COUNTER_KEY = 'puffco:dab_cleaning_counter_v1';
  const CLEANING_COUNTER_RESET_KEY = 'puffco:dab_cleaning_counter_reset_v1';
  const CLEANING_DAB_MIN_SECONDS = 5;

  function getCleaningCounter() {
    try {
      const v = Number(localStorage.getItem(CLEANING_COUNTER_KEY));
      return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
    } catch { return 0; }
  }
  function setCleaningCounter(n) {
    try { localStorage.setItem(CLEANING_COUNTER_KEY, String(Math.max(0, Math.floor(n)))); }
    catch { /* ignore */ }
  }
  function getCleaningCounterReset() {
    try {
      const v = Number(localStorage.getItem(CLEANING_COUNTER_RESET_KEY));
      return Number.isFinite(v) ? v : 0;
    } catch { return 0; }
  }
  function setCleaningCounterReset(ts) {
    try { localStorage.setItem(CLEANING_COUNTER_RESET_KEY, String(ts)); }
    catch { /* ignore */ }
  }

  // Called by endDabSession after a successful score save. We rebuild
  // the counter from the persisted score history so the count is
  // always in sync with what's actually on disk — no risk of two
  // writers (e.g. import + manual save) drifting the counter. A user
  // wiping the score history also wipes the cleaning counter, which
  // is the right semantic: "I just cleaned everything" = start fresh.
  function rebuildCleaningCounterFromHistory() {
    const threshold = Number(getAllSettings().cleaningThreshold) || 0;
    if (threshold <= 0) {
      setCleaningCounter(0);
      return;
    }
    const history = getDabHistory();
    // Recompute the time of the most recent reset = the most recent
    // user-initiated reset, or the timestamp of the most recent
    // cleaning cycle. The cleaning cycle resets the counter to 0 by
    // definition, so all dabs scored before the LAST cleaning-cycle
    // reset don't count.
    const lastReset = getCleaningCounterReset();
    const qualifying = history.filter((h) => {
      if (!h || h.insufficient === true) return false;
      if ((h.samples || 0) < DAB_MIN_SAMPLES_FOR_SCORE) return false;
      if (Number(h.duration || 0) < CLEANING_DAB_MIN_SECONDS) return false;
      if (lastReset && Number(h.ts || 0) <= lastReset) return false;
      return true;
    });
    setCleaningCounter(qualifying.length);
  }

  function bumpCleaningCounter() {
    const threshold = Number(getAllSettings().cleaningThreshold) || 0;
    if (threshold <= 0) return; // reminder disabled
    const cur = getCleaningCounter();
    if (cur >= threshold) return; // already at cap; show "Cleaning"
    setCleaningCounter(cur + 1);
  }

  function resetCleaningCounter() {
    setCleaningCounter(0);
    setCleaningCounterReset(Date.now());
  }

  function updateCleaningReminder() {
    const counterEl = document.getElementById('stat-cleaning-counter');
    const trendEl = document.getElementById('stat-cleaning-trend');
    const cardEl = document.getElementById('cleaning-reminder-card');
    if (!counterEl || !trendEl) return;
    const threshold = Number(getAllSettings().cleaningThreshold) || 0;
    if (threshold <= 0) {
      counterEl.textContent = '—';
      trendEl.textContent = 'set in Settings';
      cardEl?.classList.remove('cleaning-due');
      return;
    }
    const count = getCleaningCounter();
    if (count >= threshold) {
      // Cleaning is due: emphasize the card and prompt the user.
      counterEl.textContent = 'Cleaning';
      trendEl.textContent = `run a burn-off (${threshold} dabs reached)`;
      cardEl?.classList.add('cleaning-due');
    } else {
      const remaining = threshold - count;
      counterEl.textContent = `${count}/${threshold}`;
      trendEl.textContent = `${remaining} more dab${remaining === 1 ? '' : 's'} to cleaning`;
      cardEl?.classList.remove('cleaning-due');
    }
  }

  // Reset the cleaning counter to zero and stamp the reset time so
  // the next dab starts a fresh cycle. Wired into startCleaningMode.
  function markCleaningCycleCompleted() {
    resetCleaningCounter();
    updateCleaningReminder();
  }

  // ============================================================
  // Sensor diagnostic (Run sensor diagnostic)
  // ============================================================
  //
  // Captures 30 seconds of 100ms-cadence status samples so the user
  // (and a developer) can see exactly what the BLE layer reports
  // while the device is doing its thing. The whole point is to take
  // the "I think the threshold is wrong" guesswork out of the loop:
  // the chart shows the raw airflow, the table shows the state, and
  // the JSON dump has every value to grep later.
  function dabStartDiagnostic() {
    if (dabState === 'diagnostic') return;
    dabStopDiagnostic();
    if (!dabEnabled) {
      toast('Enable dab scoring first', 'warning');
      return;
    }
    if (!connected) {
      toast('Connect to a device first', 'warning');
      return;
    }
    const startedAt = Date.now();
    dabDiag = {
      startedAt,
      samples: [],
      stateTransitions: [],
      lastState: normalizeStateKey(deviceState?.state),
      pollTimer: null,
      ended: false,
      synthetic: false,
    };
    dabState = 'diagnostic';
    showDabPanel();
    dabShowView('dab-diagnostic-view');
    dabRenderDiagnosticMeta();
    const drawBtn = document.getElementById('btn-dab-diag-save');
    if (drawBtn) drawBtn.classList.add('hidden');
    dabDiag.pollTimer = setInterval(() => {
      // Stop the diagnostic at the configured wall-clock cutoff.
      if (!dabDiag) return;
      if (Date.now() - dabDiag.startedAt >= DAB_DIAGNOSTIC_DURATION_MS) {
        dabFinishDiagnostic();
        return;
      }
      dabCaptureDiagSample();
    }, DAB_DIAGNOSTIC_POLL_MS);
    // First sample taken right away so the chart isn't empty for 100ms.
    dabCaptureDiagSample();
    // Render an empty chart shell so the canvas is visible immediately.
    dabDrawDiagChart();
  }

  // Pulls a sample out of the most recent device snapshot. When the
  // device isn't reachable we still record a "no-data" row so the
  // chart shows the gap rather than freezing.
  function dabCaptureDiagSample() {
    if (!dabDiag) return;
    const data = deviceState || {};
    const stateKey = normalizeStateKey(data.state);
    if (stateKey !== dabDiag.lastState) {
      dabDiag.stateTransitions.push({
        ts: Date.now(),
        from: dabDiag.lastState || null,
        to: stateKey,
      });
      dabDiag.lastState = stateKey;
    }
    dabDiag.samples.push({
      ts: Date.now(),
      state: data.state ?? null,
      state_elapsed_time_s: Number(data.state_elapsed_time_s) || 0,
      state_total_time_s: Number(data.state_total_time_s) || 0,
      draw_strength_percent: Number(data.draw_strength_percent) || 0,
      draw_strength_source: data.draw_strength_source ?? null,
      draw_strength_mode: data.draw_strength_mode ?? null,
      draw_strength_value: Number(data.draw_strength_value) || 0,
      current_temperature_f: Number(data.current_temperature_f) || 0,
      target_temperature_f: Number(data.target_temperature_f) || 0,
      heat: data.heat ?? null,
      connected: data.connected === true,
      t_offset_ms: Date.now() - dabDiag.startedAt,
    });
    dabRenderDiagnosticMeta();
    dabDrawDiagChart();
  }

  // Compute summary stats for the captured airflow signal. Kept on the
  // dab object so the JSON download can include it without re-walking
  // the samples twice.
  function dabSummarizeSamples(samples) {
    if (!samples || !samples.length) {
      return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, above_threshold: 0 };
    }
    const values = samples.map(s => s.draw_strength_percent).filter(v => Number.isFinite(v));
    values.sort((a, b) => a - b);
    const pick = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0;
    const min = values[0] || 0;
    const max = values[values.length - 1] || 0;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = values.length ? sum / values.length : 0;
    const p50 = pick(0.5);
    const p95 = pick(0.95);
    const above = values.filter(v => v >= dabThreshold).length;
    return {
      count: values.length,
      min: Math.round(min * 10) / 10,
      max: Math.round(max * 10) / 10,
      mean: Math.round(mean * 10) / 10,
      p50: Math.round(p50 * 10) / 10,
      p95: Math.round(p95 * 10) / 10,
      above_threshold: above,
      threshold_percent: dabThreshold,
    };
  }

  function dabRenderDiagnosticMeta() {
    const el = document.getElementById('dab-diag-meta');
    if (!el || !dabDiag) return;
    const elapsed = Math.min(DAB_DIAGNOSTIC_DURATION_MS, Date.now() - dabDiag.startedAt);
    const remaining = Math.max(0, DAB_DIAGNOSTIC_DURATION_MS - elapsed);
    const last = dabDiag.samples[dabDiag.samples.length - 1];
    const stateText = last ? formatDeviceState(last.state) : (dabDiag.synthetic ? 'Simulated' : 'Waiting…');
    const percent = last ? Math.round(Number(last.draw_strength_percent) || 0) + '%' : '—';
    const tempF = last && Number.isFinite(last.current_temperature_f) && last.current_temperature_f > 0
      ? Math.round(last.current_temperature_f) + '°F' : '—';
    el.textContent =
      `${stateText} · ${percent} · ${tempF} · ${dabDiag.samples.length} samples · ` +
      `t-${formatSecondsClock(remaining / 1000)} left`;
  }

  function dabDrawDiagChart() {
    const canvas = document.getElementById('dab-diag-canvas');
    if (!canvas || !dabDiag) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Y-axis grid lines at 25 / 50 / 75 / 100 %
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (const p of [0.25, 0.5, 0.75]) {
      const y = H * (1 - p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    // Threshold reference line
    const yTh = H * (1 - Math.min(1, dabThreshold / 100));
    ctx.strokeStyle = 'rgba(192, 132, 252, 0.5)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yTh);
    ctx.lineTo(W, yTh);
    ctx.stroke();
    ctx.setLineDash([]);
    // Sample line
    const samples = dabDiag.samples;
    if (samples.length < 2) return;
    const minTs = samples[0].ts;
    const maxTs = samples[samples.length - 1].ts;
    const range = Math.max(1, maxTs - minTs);
    ctx.beginPath();
    ctx.strokeStyle = '#c084fc';
    ctx.lineWidth = 2;
    let first = true;
    for (const s of samples) {
      const x = W * ((s.ts - minTs) / range);
      const y = H * (1 - Math.min(1, s.draw_strength_percent / 100));
      if (first) { ctx.moveTo(x, y); first = false; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    // Vertical lines for state transitions
    for (const tr of dabDiag.stateTransitions) {
      const x = W * ((tr.ts - minTs) / range);
      ctx.strokeStyle = 'rgba(255, 196, 0, 0.7)';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

  function dabFinishDiagnostic() {
    if (!dabDiag || dabDiag.ended) return;
    dabDiag.ended = true;
    if (dabDiag.pollTimer) {
      clearInterval(dabDiag.pollTimer);
      dabDiag.pollTimer = null;
    }
    // Final chart pass to ensure the last few points are drawn.
    dabDrawDiagChart();
    dabRenderDiagnosticMeta();
    const saveBtn = document.getElementById('btn-dab-diag-save');
    if (saveBtn) saveBtn.classList.remove('hidden');
  }

  function dabStopDiagnostic() {
    if (!dabDiag) return;
    if (dabDiag.pollTimer) clearInterval(dabDiag.pollTimer);
    dabDiag = null;
  }

  // Public-facing: build the JSON payload and trigger the download.
  function dabDownloadDiagnosticLog() {
    if (!dabDiag || !dabDiag.samples.length) {
      toast('Run the diagnostic first', 'warning');
      return;
    }
    const summary = dabSummarizeSamples(dabDiag.samples);
    const transitions = dabDiag.stateTransitions.map(t => ({
      ...t,
      t_offset_ms: t.ts - dabDiag.startedAt,
    }));
    const payload = {
      generated_at: new Date().toISOString(),
      transport: transportMode,
      threshold_percent: dabThreshold,
      duration_ms: DAB_DIAGNOSTIC_DURATION_MS,
      synthetic: !!dabDiag.synthetic,
      summary: {
        airflow: summary,
        state_transitions: transitions,
        transition_count: transitions.length,
      },
      samples: dabDiag.samples,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `puffco-dab-diag-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const dabSession = {
    setEnabled(v) { dabEnabled = v; },
    setDifficulty(v) { dabDifficulty = v; },
    setThreshold(v) { dabThreshold = v; },
  };

  // Settings > Dab action: forget the learned preheat-timer offset so
  // calibration starts fresh on the next heat cycle.
  function resetDabPreheatCalibration() {
    dabPreheatOffset = 0;
    dabPreheatTrack = null;
    try { localStorage.removeItem(DAB_PREHEAT_OFFSET_KEY); } catch { /* ignore */ }
    renderSettingsPanel();
    toast('Preheat timer calibration reset', 'success');
  }

  // Settings > Dab action: forget the learned device max draw so the
  // adaptive calibration re-learns from the next few pulls.
  function resetDabDrawCalibration() {
    dabLearnedMaxPct = 60;
    dabSessionPeakRaw = 0;
    try { localStorage.removeItem(DAB_DRAW_MAX_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(DAB_PEAK_HISTORY_KEY); } catch { /* ignore */ }
    renderSettingsPanel();
    toast('Draw calibration reset — pull hard once to re-learn', 'success');
  }

  // Settings > Dab action: wipe the saved score history.
  function clearDabHistory() {
    requireConfirm('Clear all dab score history?', () => {
      saveDabHistory([]);
      // Wipe the cleaning counter too — there's nothing left to
      // count from. Keep the reset stamp so an "old" dab imported
      // later won't be miscounted.
      setCleaningCounter(0);
      setCleaningCounterReset(Date.now());
      updateDabHistorySummary();
      updateCleaningReminder();
      toast('Dab score history cleared', 'success');
    });
  }

  // ============================================================
  // Constants
  // ============================================================
  const browserDebugEvents = [];
  const BROWSER_DEBUG_LIMIT = 300;
  const PROFILE_ORDER_KEY = 'puffco_profile_order';
  const PROFILE_VAPOR_KEY = 'puffco_profile_vapor_presets_v1';
  const LOCAL_PROFILES_KEY = 'puffco_local_profiles';
  const PROFILE_BACKUP_KEY = 'puffco_profile_backups_v1';
  const MOOD_LIBRARY_KEY = 'puffco_mood_library_v1';
  const LAST_CONNECTED_KEY = 'puffco_last_connected';
  const ADVANCED_USER_KEY = 'puffco:advanced-user';
  const PUFFCO_MANUFACTURER_MAC_PREFIX = 'F0:AD:4E';
  const PUFFCO_MANUFACTURER_MAC_PREFIXES = [PUFFCO_MANUFACTURER_MAC_PREFIX];
  const SCAN_BUTTON_TEXT = 'Scan Puffcos';
  // Round 2 polish: persisted card reorder. Keyed under puffco:* to
  // match the existing puffco:theme / puffco:accent / puffco_transport_mode
  // style. Read by the inline pre-paint script in <head> and by
  // initCardOrder() in this file. Source of truth for the card list
  // lives in the data-card-id attributes on .app-container children.
  const CARD_ORDER_KEY = 'puffco:card-order';
  const CARD_DRAG_INDICATOR_MS = 180;
  // Per-card item-order keys follow the pattern "puffco:item-order:<list>".
  // Each list id is the data-card-item-list value of the parent element.
  // We keep them separate from the card-order key so resetting cards
  // doesn't reset internal item orders (or vice versa) unless the user
  // explicitly asks for a full reset.
  const ITEM_ORDER_KEY_PREFIX = 'puffco:item-order:';
  const CUSTOMIZE_MODE_KEY = 'puffco:customize-mode';
  // When false, no card or item is draggable; the user has to flip the
  // toggle in the appearance popover to enter customize mode. We start
  // off (the previous "always-on" card drag is removed) so the page
  // feels calm by default and reordering is a deliberate action.
  let customizeMode = false;
  const DRAW_SESSION_KEY = 'puffco:draw-session';
  // Vapor presets — display-only labels. The IDs are stable so saved
  // profiles in localStorage keep working. Intensity 0-1 maps to the
  // dynamic inhale (diFrac) field in the mood light payload, which
  // tells the firmware how aggressively to modulate chamber power
  // during a draw. Smooth is the firmware default (no diFrac boost).
  // Bold / Intense / Extreme turn dynamic inhale on with increasing
  // strength. Extreme is the 3D XL chamber mode.
  const VAPOR_PRESETS = [
    { id: 'standard', name: 'Smooth',   short: 'Smooth',   desc: 'Default power curve, no draw modulation' },
    { id: 'high',     name: 'Bold',     short: 'Bold',     desc: 'Light draw response, ~33% modulation' },
    { id: 'max',      name: 'Intense',  short: 'Intense',  desc: 'Strong draw response, ~66% modulation' },
    { id: 'xl',       name: 'Extreme',  short: 'Extreme',  desc: 'Max draw response, 3D XL chamber mode' },
  ];
  // Lookup table for the dynamic inhale intensity each vapor preset
  // sends to the device. Smooth (0) means dynamic_inhale:false on the
  // mood light payload. The other three enable dynamic inhale with
  // increasing diFrac values.
  const VAPOR_INTENSITY = {
    standard: 0.0,
    high:     0.33,
    max:      0.66,
    xl:       1.0,
  };
  const VISIBLE_BLE_POLL_MS = 1000;
  const HIDDEN_BLE_POLL_MS = 8000;
  const VISIBLE_RECONNECT_MS = 2000;
  const HIDDEN_RECONNECT_MS = 10000;

  // Lorax Path Explorer State
  let loraxPaths = [];
  let selectedPathEntry = null;
  let registryLoaded = false;
  let registryRequestInFlight = false;
  let loraxActions = {};

  // Preset color palette
  const PRESETS = [
    '#00d6b4', '#14b8a6', '#22c55e', '#84cc16',
    '#f6a623', '#fb923c', '#ef4444', '#f43f5e',
    '#38bdf8', '#2563eb', '#7c3aed', '#a855f7',
    '#f8fafc', '#94a3b8', '#111827', '#0f766e',
  ];
  const MOOD_PRESETS = [
    {
      id: 'no_animation',
      name: 'Static color',
      desc: 'Split your Peak into color regions',
      min: 1,
      max: 6,
      colors: ['#ff0000'],
      tempo: false,
    },
    {
      id: 'fade',
      name: 'Fade',
      desc: 'Smooth transitions',
      min: 2,
      max: 6,
      colors: ['#ff0000', '#00ff00'],
      tempo: true,
    },
    {
      id: 'disco',
      name: 'Disco',
      desc: 'Spiraling color cycle',
      min: 2,
      max: 6,
      colors: ['#ff0000', '#00ff00', '#0000ff'],
      tempo: true,
    },
    {
      id: 'pulse',
      name: 'Pulse',
      desc: 'Breathing app-style glow',
      min: 1,
      max: 3,
      colors: ['#00d6b4', '#f6a623'],
      tempo: true,
      sourcePreset: 'fade',
    },
    {
      id: 'rainbow',
      name: 'Rainbow',
      desc: 'Classic Puffco spectrum',
      min: 3,
      max: 6,
      colors: ['#ef4444', '#f6a623', '#22c55e', '#38bdf8', '#7c3aed'],
      tempo: true,
      sourcePreset: 'disco',
    },
    {
      id: 'lava_lamp',
      name: 'Lava Lamp',
      desc: 'Warm rolling fade',
      min: 2,
      max: 4,
      colors: ['#ef4444', '#fb923c', '#f6a623'],
      tempo: true,
      sourcePreset: 'fade',
    },
    {
      id: 'spin',
      name: 'Spin',
      desc: 'Lighthouse motion',
      min: 1,
      max: 6,
      colors: ['#ff0000'],
      tempo: true,
    },
    {
      id: 'chase',
      name: 'Chase',
      desc: 'Fast rotating highlight',
      min: 1,
      max: 3,
      colors: ['#38bdf8', '#f8fafc'],
      tempo: true,
      sourcePreset: 'spin',
    },
    {
      id: 'split_gradient',
      name: 'Split Gradient',
      desc: 'Mirrored fissure gradient',
      min: 2,
      max: 6,
      colors: ['#ff0000', '#00ff00'],
      tempo: true,
    },
    {
      id: 'vertical_slideshow',
      name: 'Vertical Slideshow',
      desc: 'Colors slide upward',
      min: 2,
      max: 6,
      colors: ['#ff0000', '#00ff00'],
      tempo: true,
    },
  ];
  const DISCO_BASE_OFFSETS = [
    15360, 18773, 1707, 5120, 8533, 11947, 15360, 10240, 10240, 5120,
    2844, 1138, 853, 19627, 19342, 17636, 0, 0, 0, 0,
  ];
  const SPLIT_OFFSETS_2 = [0, 0, 0, 0, 0, 0, 7680, 25600, 15360, 7680, 12800, 12800, 17920, 17920, 12800, 12800, 15360, 15360, 15360, 15360];
  const SPLIT_OFFSETS_3_4 = [0, 0, 0, 0, 0, 0, 7680, 46080, 15360, 7680, 33280, 33280, 38400, 38400, 33280, 33280, 15360, 15360, 15360, 15360];
  const SPLIT_OFFSETS_5_6 = [0, 0, 0, 0, 0, 0, 7680, 66560, 15360, 7680, 53760, 53760, 58880, 58880, 53760, 53760, 15360, 15360, 15360, 15360];
  const VERTICAL_SLIDESHOW_OFFSETS = [20480, 20480, 20480, 20480, 20480, 20480, 15930, 9100, 11835, 15930, 0, 0, 6825, 6825, 0, 0, 20480, 20480, 20480, 20480];
  const moodEditor = {
    preset: 'no_animation',
    colors: ['#ff0000'],
    tempoFrac: 0.5,
    dynamicInhale: false,
  };
  const DEVICE_COMMANDS = new Set([
    'select_profile', 'set_profile', 'reorder_profiles', 'set_color', 'mood_light', 'lantern', 'lantern_color',
    'stealth', 'brightness', 'show_battery', 'show_version', 'heat', 'stop',
    'boost', 'set_boost_options', 'power', 'temperature_observe', 'temperature_source',
    'draw_strength_observe', 'draw_strength_source',
    'lorax_read', 'lorax_write', 'lorax_action', 'lorax_probe',
    'lorax_observe', 'heat_probe', 'heat_observe', 'official_attributes',
  ]);

  // ---- WebSocket ----

  function isLocalFrontend() {
    return ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  }

  function defaultBridgeUrl() {
    if (isLocalFrontend() && location.protocol !== 'https:') {
      const httpPort = Number(location.port);
      const wsPort = Number.isFinite(httpPort) && httpPort > 0 ? String(httpPort + 1) : '8421';
      return `ws://${location.hostname}:${wsPort}/ws`;
    }
    return 'ws://127.0.0.1:8421/ws';
  }

  function normalizeBridgeUrl(value) {
    const raw = String(value || '').trim() || defaultBridgeUrl();
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `ws://${raw}`;
    try {
      const parsed = new URL(withScheme);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(parsed.protocol)) parsed.protocol = 'ws:';
      if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/ws';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return defaultBridgeUrl();
    }
  }

  function setBridgeNote(message, state = '') {
    const note = document.getElementById('bridge-note');
    if (!note) return;
    note.textContent = message;
    note.classList.toggle('online', state === 'online');
    note.classList.toggle('offline', state === 'offline');
  }

  function browserBleSupported() {
    return Boolean(window.PuffcoBrowserBleClient && window.navigator?.bluetooth && window.isSecureContext);
  }

  function platformSummary() {
    const ua = window.navigator.userAgent || '';
    const platform = window.navigator.userAgentData?.platform || window.navigator.platform || 'Unknown';
    const brands = window.navigator.userAgentData?.brands?.map((item) => item.brand).join(', ') || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const isFirefox = /Firefox\//i.test(ua);
    const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
    const isChromium = /Chrome|Chromium|Edg|OPR|Brave|SamsungBrowser/i.test(ua) || /Chromium|Google Chrome|Microsoft Edge/i.test(brands);
    const browser = isFirefox ? 'Firefox' : isSafari ? 'Safari' : isChromium ? 'Chromium browser' : 'Unknown browser';
    const os = isIOS ? 'iOS/iPadOS' : isAndroid ? 'Android' : /Win/i.test(platform) ? 'Windows' : /Mac/i.test(platform) ? 'macOS' : /Linux/i.test(platform) ? 'Linux' : platform;
    return { browser, os, isIOS, isAndroid, isFirefox, isSafari, isChromium };
  }

  function syncShellClasses() {
    const platform = platformSummary();
    const narrow = window.matchMedia?.('(max-width: 700px)').matches ?? window.innerWidth <= 700;
    const coarseTouch = window.matchMedia?.('(pointer: coarse) and (hover: none)').matches ?? false;
    const mobileOS = platform.isIOS || platform.isAndroid;
    document.body.classList.toggle('mobile-nav-shell', Boolean(narrow && (mobileOS || coarseTouch)));
    document.body.classList.toggle('ios-shell', platform.isIOS);
    document.body.classList.toggle('non-chromium-shell', !platform.isChromium);
  }

  async function updateBleCapabilityPanel() {
    const panel = document.getElementById('ble-capability');
    if (!panel) return;
    const title = document.getElementById('ble-capability-title');
    const copy = document.getElementById('ble-capability-copy');
    const tags = document.getElementById('ble-capability-tags');
    const platform = platformSummary();
    const secure = window.isSecureContext;
    const apiPresent = Boolean(window.navigator?.bluetooth);
    let available = null;
    if (apiPresent && typeof window.navigator.bluetooth.getAvailability === 'function') {
      try {
        available = await window.navigator.bluetooth.getAvailability();
      } catch {
        available = null;
      }
    }

    const directReady = browserBleSupported() && available !== false;
    const hardBlocked = !secure || !apiPresent || platform.isIOS || platform.isSafari || platform.isFirefox;
    panel.classList.toggle('blocked', hardBlocked);
    panel.classList.toggle('limited', !hardBlocked && !directReady);
    panel.classList.toggle('online', directReady);
    if (hardBlocked || (!directReady && available === false)) bleCapabilityExpanded = true;
    renderBleCapabilityExpansion();

    const tagValues = [
      platform.browser,
      platform.os,
      secure ? 'Secure page' : 'HTTPS required',
      apiPresent ? 'Web Bluetooth API found' : 'No Web Bluetooth API',
      available === false ? 'Bluetooth unavailable' : available === true ? 'Adapter available' : 'Adapter unknown',
    ];
    if (tags) tags.innerHTML = tagValues.map((tag) => `<span class="capability-tag">${escHtml(tag)}</span>`).join('');

    if (directReady) {
      setText('ble-capability-title', 'Direct web Bluetooth ready');
      setText('ble-capability-hint', bleCapabilityExpanded ? 'Hide details' : 'Ready');
      setText('ble-capability-copy', 'This browser can connect from GitHub Pages or localhost. Press Connect and approve the browser Bluetooth chooser.');
      panel.setAttribute('aria-label', 'Direct web Bluetooth ready. Click for details.');
    } else if (!secure) {
      setText('ble-capability-title', 'HTTPS is required for web Bluetooth');
      setText('ble-capability-hint', 'Needs attention');
      setText('ble-capability-copy', 'Direct BLE only works from HTTPS, localhost, or 127.0.0.1. Use GitHub Pages or the local bridge.');
      panel.setAttribute('aria-label', 'Web Bluetooth needs HTTPS or localhost. Click for details.');
    } else if (platform.isIOS || platform.isSafari || platform.isFirefox || !apiPresent) {
      setText('ble-capability-title', 'Direct BLE is not exposed by this browser');
      setText('ble-capability-hint', 'Needs attention');
      setText('ble-capability-copy', 'Use Chrome or Edge on Windows, macOS, Linux, ChromeOS, or Android for direct web BLE. This browser can still view the app and use a local bridge where available.');
      panel.setAttribute('aria-label', 'Direct Bluetooth is unavailable in this browser. Click for details.');
    } else {
      setText('ble-capability-title', 'Bluetooth availability needs attention');
      setText('ble-capability-hint', 'Needs attention');
      setText('ble-capability-copy', 'The Web Bluetooth API exists, but the adapter may be off, blocked by browser policy, or unavailable to this page.');
      panel.setAttribute('aria-label', 'Bluetooth availability needs attention. Click for details.');
    }
  }

  function toggleBleCapability() {
    bleCapabilityExpanded = !bleCapabilityExpanded;
    renderBleCapabilityExpansion();
  }

  function expandBleCapability() {
    bleCapabilityExpanded = true;
    renderBleCapabilityExpansion();
  }

  function renderBleCapabilityExpansion() {
    const panel = document.getElementById('ble-capability');
    if (!panel) return;
    panel.classList.toggle('expanded', bleCapabilityExpanded);
    panel.setAttribute('aria-expanded', String(bleCapabilityExpanded));
    const hint = document.getElementById('ble-capability-hint');
    if (hint && !panel.classList.contains('blocked') && !panel.classList.contains('limited')) {
      hint.textContent = bleCapabilityExpanded ? 'Hide details' : 'Ready';
    }
  }

  function isBluetoothRelatedMessage(message) {
    return /bluetooth|ble|adapter|gatt|chooser|secure context|https|permission|device/i.test(String(message || ''));
  }

  function defaultTransportMode() {
    return browserBleSupported() ? 'browser_ble' : 'bridge';
  }

  function normalizeTransportMode(mode) {
    if (mode === 'browser_ble' && browserBleSupported()) return 'browser_ble';
    return 'bridge';
  }

  function getBrowserBle() {
    if (!browserBle) {
      browserBle = new window.PuffcoBrowserBleClient();
      browserBle.onDisconnected = () => {
        if (browserBleDisconnectHandled) return;
        browserBleDisconnectHandled = true;
        handleMessage({
          type: 'disconnected',
          message: 'Browser Bluetooth disconnected.',
          data: { connected: false, reason: 'Browser Bluetooth disconnected' },
        });
      };
    }
    return browserBle;
  }

  function renderBridgeUI() {
    const input = document.getElementById('bridge-url');
    if (input && document.activeElement !== input) input.value = bridgeUrl || defaultBridgeUrl();
    const select = document.getElementById('transport-mode');
    const browserOption = select?.querySelector('option[value="browser_ble"]');
    const browserSupported = browserBleSupported();
    if (browserOption) {
      browserOption.disabled = !browserSupported;
      browserOption.textContent = browserSupported ? 'Browser Bluetooth' : 'Browser Bluetooth (unsupported here)';
    }
    if (select && select.value !== transportMode) select.value = transportMode;
    const bridgeGroup = document.getElementById('bridge-url-group');
    const bridgeButton = document.getElementById('btn-bridge');
    const connectButton = document.getElementById('btn-connect');
    const browserMode = transportMode === 'browser_ble';
    const advanced = isAdvancedUser();
    if (bridgeGroup) bridgeGroup.classList.toggle('hidden', !advanced || browserMode);
    if (bridgeButton) bridgeButton.classList.toggle('hidden', !advanced || browserMode);
    if (connectButton && !connectPending) {
      connectButton.textContent = browserMode ? 'Connect Puffco' : 'Connect Selected Puffco';
    }
    if (browserMode) {
      setBridgeNote(
        browserSupported
          ? 'Browser Bluetooth is active. GitHub Pages can connect directly through the Chrome/Edge Bluetooth chooser.'
          : 'Browser Bluetooth is unavailable here. Use Chrome or Edge on HTTPS, localhost, or 127.0.0.1, or switch to the local bridge.',
        browserSupported ? 'online' : 'offline',
      );
    } else if (advanced) {
      setBridgeNote(`Local bridge scans Puffco devices with MAC prefix ${PUFFCO_MANUFACTURER_MAC_PREFIX}.`, 'online');
    }
    updateBleCapabilityPanel();
    renderBrowserDebugSummary();
    updateScanButtonVisibility();
  }

  function scanAvailableInCurrentMode() {
    return isAdvancedUser() && transportMode === 'bridge';
  }

  function updateScanButtonVisibility() {
    const btnScan = document.getElementById('btn-scan');
    if (!btnScan) return;
    const available = scanAvailableInCurrentMode();
    btnScan.classList.toggle('hidden', connected || !available);
    btnScan.disabled = connected || !available || scanPending;
    if (!scanPending) btnScan.textContent = SCAN_BUTTON_TEXT;
  }

  function renderBrowserDebugSummary() {
    const latest = browserDebugEvents[browserDebugEvents.length - 1];
    const platform = platformSummary();
    setText('debug-transport', transportMode === 'browser_ble' ? 'Browser Bluetooth' : 'Local bridge');
    setText('debug-platform', `${platform.browser} / ${platform.os}`);
    setText('debug-event-count', String(browserDebugEvents.length));
    setText('debug-last-event', latest ? `${logLabel(latest.type)} ${latest.message || latest.type}` : 'Ready');
    setText('debug-console-transport', transportMode === 'browser_ble' ? 'Browser Bluetooth' : 'Local bridge');
    setText('debug-console-context', `${window.isSecureContext ? 'Secure' : 'Not secure'} / ${platform.browser}`);
    setText('debug-console-count', String(browserDebugEvents.length));
    renderBrowserDebugLog();
  }

  function recordBrowserDebug(type, message, data = null) {
    const entry = {
      time: new Date().toISOString(),
      transport: transportMode,
      type: normalizeLogType(type),
      message: String(message || ''),
      data,
    };
    browserDebugEvents.push(entry);
    while (browserDebugEvents.length > BROWSER_DEBUG_LIMIT) browserDebugEvents.shift();
    try {
      localStorage.setItem('puffco_browser_debug_log', JSON.stringify(browserDebugEvents));
    } catch {}
    const logger = entry.type === 'error' ? console.error : entry.type === 'warn' ? console.warn : console.info;
    logger.call(console, `[Puffco ${entry.type.toUpperCase()}] ${entry.message}`, data ?? '');
    renderBrowserDebugSummary();
  }

  function restoreBrowserDebugLog() {
    try {
      const saved = JSON.parse(localStorage.getItem('puffco_browser_debug_log') || '[]');
      if (Array.isArray(saved)) {
        browserDebugEvents.splice(0, browserDebugEvents.length, ...saved.slice(-BROWSER_DEBUG_LIMIT));
        renderBrowserDebugSummary();
      }
    } catch {}
  }

  function clearBrowserDebugLog() {
    browserDebugEvents.splice(0, browserDebugEvents.length);
    try {
      localStorage.removeItem('puffco_browser_debug_log');
    } catch {}
    renderBrowserDebugSummary();
    appendLog('Browser debug log cleared', 'info', { skipDebug: true });
    toast('Debug log cleared', 'info');
  }

  function exportBrowserDebugLog() {
    return browserDebugEvents.slice();
  }

  function browserDebugPayload() {
    return {
      generated_at: new Date().toISOString(),
      location: location.href,
      platform: platformSummary(),
      secure_context: window.isSecureContext,
      web_bluetooth_api: Boolean(window.navigator?.bluetooth),
      transport: transportMode,
      connected,
      last_connection_status: lastConnectionStatus,
      last_message: lastBackendMessage,
      last_snapshot: lastDeviceSnapshot,
      events: exportBrowserDebugLog(),
    };
  }

  async function copyBrowserDebugLog() {
    const text = safeJsonStringify(browserDebugPayload());
    try {
      await navigator.clipboard.writeText(text);
      toast('Debug log copied', 'success');
      appendLog('Browser debug log copied to clipboard', 'success');
    } catch (err) {
      toast('Clipboard copy failed', 'error');
      appendLog(`Clipboard copy failed: ${err?.message || err}`, 'error');
    }
  }

  function downloadBrowserDebugLog() {
    try {
      const text = safeJsonStringify(browserDebugPayload());
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `puffco-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      appendLog('Browser debug log downloaded', 'success');
    } catch (err) {
      toast('Download failed', 'error');
      appendLog(`Download failed: ${err?.message || err}`, 'error');
    }
  }

  function renderBrowserDebugLog() {
    const log = document.getElementById('browser-debug-log');
    if (!log) return;
    const events = browserDebugEvents.slice(-60).reverse();
    if (!events.length) {
      log.innerHTML = '<div class="log-empty">No browser events yet</div>';
      return;
    }
    log.innerHTML = events.map((entry) => {
      const time = new Date(entry.time || Date.now()).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const detail = entry.data == null ? '' : `<small>${escHtml(compactDebugData(entry.data))}</small>`;
      return `
        <div class="log-row ${escAttr(entry.type)}">
          <span class="log-time">${escHtml(time)}</span>
          <span class="log-level">${escHtml(logLabel(entry.type))}</span>
          <span class="log-message">${escHtml(entry.message || entry.type)}${detail}</span>
        </div>
      `;
    }).join('');
  }

  function compactDebugData(data) {
    const text = friendlyJsonStringify(data);
    return text.length > 220 ? `${text.slice(0, 220)}...` : text;
  }

  function stopBrowserBlePolling() {
    if (browserBlePoll) {
      clearInterval(browserBlePoll);
      browserBlePoll = null;
    }
    browserBleStatusInFlight = false;
  }

  async function pollBrowserBleStatus() {
    if (transportMode !== 'browser_ble' || !connected || connectPending || browserBleStatusInFlight) return;
    browserBleStatusInFlight = true;
    try {
      const response = await getBrowserBle().handleCommand('status');
      handleMessage(response);
    } catch (err) {
      if (connected) {
        const detail = err?.message || String(err);
        handleMessage({ type: 'error', message: `Browser Bluetooth status failed: ${detail}` });
      }
    } finally {
      browserBleStatusInFlight = false;
    }
  }

  function startBrowserBlePolling() {
    if (transportMode !== 'browser_ble' || browserBlePoll) return;
    pollBrowserBleStatus();
    browserBlePoll = setInterval(pollBrowserBleStatus, document.hidden ? HIDDEN_BLE_POLL_MS : VISIBLE_BLE_POLL_MS);
  }

  function restartBrowserBlePolling() {
    if (transportMode !== 'browser_ble' || !connected) return;
    stopBrowserBlePolling();
    startBrowserBlePolling();
  }

  function closeBridgeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState < WebSocket.CLOSING) {
      suppressSocketReconnect = true;
      ws.close();
    }
  }

  function setTransportMode(mode) {
    const nextMode = normalizeTransportMode(mode);
    transportMode = nextMode;
    try { localStorage.setItem('puffco_transport_mode', transportMode); }
    catch { /* ignore quota / private mode */ }
    renderBridgeUI();
    if (transportMode === 'browser_ble') {
      closeBridgeSocket();
      ws = null;
      if (!connected) {
        setBridgeNote('Browser Bluetooth is active. Press Connect to open the browser Bluetooth chooser.', 'online');
      }
    } else {
      stopBrowserBlePolling();
      if (browserBle?.connected) sendBrowserBle('disconnect', {}, { quiet: true });
      connectBridge();
    }
  }

  function initWebSocket(urlOverride) {
    const url = normalizeBridgeUrl(urlOverride || bridgeUrl || localStorage.getItem('puffco_bridge_url'));
    bridgeUrl = url;
    renderBridgeUI();
    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('WebSocket connected');
      lastConnectionStatus = {
        stage: 'socket_connected',
        message: `Browser socket connected to local backend at ${url}.`,
        timestamp: new Date().toISOString(),
      };
      setBridgeNote(`Bridge connected: ${url}. Scans show Puffco devices with MAC prefix ${PUFFCO_MANUFACTURER_MAC_PREFIX}.`, 'online');
      renderBackendMirror();
      // Force a registry re-fetch on every (re)connect. The backend may
      // have restarted with a different firmware / registry, and the
      // previous fetch's payload is now stale. Without this, the
      // requestLoraxRegistry() short-circuit on `registryLoaded` would
      // leave the Lorax panel showing the old paths after a bridge
      // drop, even though the device is back and the new registry is
      // sitting in the backend.
      registryLoaded = false;
      requestLoraxRegistry();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.error('Bad WS message:', e);
      }
    };

    ws.onclose = () => {
      if (suppressSocketReconnect) {
        suppressSocketReconnect = false;
        return;
      }
      const backgrounded = document.hidden;
      const reconnectDelay = backgrounded ? HIDDEN_RECONNECT_MS : VISIBLE_RECONNECT_MS;
      console.log(`WebSocket closed, reconnecting in ${Math.round(reconnectDelay / 1000)}s...`);
      lastConnectionStatus = {
        stage: 'socket_closed',
        message: `Browser socket disconnected from local backend at ${bridgeUrl || url}.`,
        timestamp: new Date().toISOString(),
      };
      setBridgeNote(`Bridge disconnected. Retrying ${bridgeUrl || url}...`, 'offline');
      if ((connected || connectPending) && !backgrounded) {
        connected = false;
        connectPending = false;
        deviceState = null;
        updateProfilesUI([], null);
        renderProfileLibrary();
        // A bridge drop in the middle of a save/reload/select leaves
        // every in-flight UI flag in limbo: the modal would sit on
        // "Saving…" forever, the profile-reload spinner would never
        // clear, and the optimistic profile selection would never
        // reconcile. Wipe them here so the next connection starts
        // from a clean slate, and surface the error in the modal
        // if one is open.
        if (profileSaveInFlight != null) {
          const inflightIndex = profileSaveInFlight;
          profileSaveInFlight = null;
          if (pendingAutoCloseIndex === inflightIndex) pendingAutoCloseIndex = null;
          setSaveButtonsPending(false);
          markProfileReadbackError('Bridge disconnected — save not confirmed');
        }
        pendingProfileReload = null;
        optimisticProfileIndex = null;
        lastDeviceSnapshot = normalizeDisconnectedPayload(lastDeviceSnapshot, 'Server connection lost');
        updateConnectionUI(false);
        updateStatusUI(null);
        toast('Server connection lost', 'error');
      } else if (backgrounded && connected) {
        setBridgeNote(`Bridge paused in background. Reconnecting quietly to ${bridgeUrl || url}...`, 'offline');
      }
      renderBackendMirror();
      reconnectTimer = setTimeout(() => initWebSocket(), reconnectDelay);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setBridgeNote(`Bridge error. Make sure start.bat is running on Windows: ${bridgeUrl || url}`, 'offline');
    };
  }

  function connectBridge() {
    // Block re-entry. The `setTimeout(..., 50)` at the bottom opens a
    // 50 ms window where a second click of "Connect" (or a quick
    // user-toggle that overlaps with the previous click) lands before
    // initWebSocket() has assigned the new `ws`. Two pending timers
    // then race to create two WebSockets; the first is overwritten by
    // the second but keeps its onmessage handler attached, so a late
    // response on the orphaned socket would still drive handleMessage
    // and confuse the UI. The guard also dedupes a single click that
    // happens to be on a button that auto-replays (voice command etc.).
    if (bridgeConnectInFlight) return;
    bridgeConnectInFlight = true;
    transportMode = 'bridge';
    try { localStorage.setItem('puffco_transport_mode', transportMode); }
    catch { /* ignore quota / private mode */ }
    stopBrowserBlePolling();
    const input = document.getElementById('bridge-url');
    bridgeUrl = normalizeBridgeUrl(input?.value);
    try { localStorage.setItem('puffco_bridge_url', bridgeUrl); }
    catch { /* ignore quota / private mode */ }
    renderBridgeUI();
    setBridgeNote(`Connecting bridge: ${bridgeUrl}`, 'offline');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws && ws.readyState < WebSocket.CLOSING) {
      suppressSocketReconnect = true;
      ws.close();
    }
    setTimeout(() => {
      bridgeConnectInFlight = false;
      initWebSocket(bridgeUrl);
    }, 50);
  }

  async function sendBrowserBle(cmd, params = {}, options = {}) {
    try {
      if (cmd !== 'status' && !options.quiet) recordBrowserDebug('info', `Browser BLE command: ${cmd}`, params);
      const response = await getBrowserBle().handleCommand(cmd, params);
      handleMessage(response);
    } catch (err) {
      let detail = err?.message || String(err);
      if (err?.name === 'NotFoundError') detail = 'Bluetooth chooser was canceled.';
      if (cmd === 'connect' && err?.name === 'NotAllowedError') {
        setVoiceBluetoothPrompt(true, 'Chrome blocked the chooser. Tap Find Device while this page is active.');
      }
      if (!options.quiet) {
        expandBleCapability();
        handleMessage({ type: 'error', message: `Browser Bluetooth ${cmd} failed: ${detail}` });
      }
    }
  }

  function send(cmd, params = {}) {
    if (transportMode === 'browser_ble') {
      if (!browserBleSupported()) {
        toast('Browser Bluetooth is unavailable here', 'error');
        appendLog('Browser Bluetooth requires Chrome or Edge on HTTPS, localhost, or 127.0.0.1', 'error');
        expandBleCapability();
        return false;
      }
      if (DEVICE_COMMANDS.has(cmd) && !connected) {
        toast('Connect to your device first', 'error');
        appendLog(`Blocked ${cmd}: browser Bluetooth disconnected`, 'error');
        return false;
      }
      if (cmd !== 'status') appendLog(`Sent ${cmd} through browser Bluetooth`, 'info');
      if (cmd === 'connect') browserBleDisconnectHandled = false;
      sendBrowserBle(cmd, params);
      return true;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      toast('Not connected to server', 'error');
      appendLog(`Server socket is not connected (${bridgeUrl || defaultBridgeUrl()})`, 'error');
      return false;
    }
    if (DEVICE_COMMANDS.has(cmd) && !connected) {
      toast('Connect to your device first', 'error');
      appendLog(`Blocked ${cmd}: device disconnected`, 'error');
      return false;
    }
    if (cmd !== 'status') appendLog(`Sent ${cmd}`, 'info');
    ws.send(JSON.stringify({ cmd, params }));
    return true;
  }

  // ---- Message Handling ----

  function handleMessage(msg) {
    rememberBackendMessage(msg);
    try {
      switch (msg.type) {
        case 'status':
          updateDeviceState(msg.data);
          break;
        case 'connection_status':
          handleConnectionStatus(msg.data || { message: msg.message });
          break;
        case 'connected':
          connectPending = false;
          browserBleDisconnectHandled = false;
          setVoiceBluetoothPrompt(false);
          updateDeviceState(normalizeConnectedPayload(msg.data));
          if (transportMode === 'browser_ble') startBrowserBlePolling();
          toast('Connected to device!', 'success');
          appendLog(msg.message || 'Connected to device', 'success');
          break;
        case 'disconnected':
          connectPending = false;
          scanPending = false;
          connected = false;
          stopBrowserBlePolling();
          browserBleDisconnectHandled = true;
          // Same in-flight state cleanup as the bridge-disconnect
          // branch: a device-side drop mid-save leaves the modal
          // stuck on the "Saving…" state until the user manually
          // closes it. Reset the in-flight flags and surface the
          // error in the readback panel if one is open.
          if (profileSaveInFlight != null) {
            const inflightIndex = profileSaveInFlight;
            profileSaveInFlight = null;
            if (pendingAutoCloseIndex === inflightIndex) pendingAutoCloseIndex = null;
            setSaveButtonsPending(false);
            markProfileReadbackError('Device disconnected — save not confirmed');
          }
          pendingProfileReload = null;
          optimisticProfileIndex = null;
          lastDeviceSnapshot = normalizeDisconnectedPayload(msg.data, msg.message);
          deviceState = null;
          updateConnectionUI(false);
          updateStatusUI(null);
          updateProfilesUI([], null);
          renderProfileLibrary();
          renderBackendMirror();
          toast(msg.message || 'Disconnected from device', 'info');
          appendLog(msg.message || 'Disconnected from device', 'info');
          break;
        case 'ok':
          toast(msg.message, 'success');
          appendLog(msg.message, 'success');
          {
            const statePayload = extractDeviceStatePayload(msg.data);
          if (statePayload) updateDeviceState(statePayload);
          }
          if (msg.data?.write_verification) {
            handleWriteVerification(msg.data.write_verification);
          }
          if (msg.data?.action || msg.data?.write) {
            renderDevResult(msg.data.action ? `lorax_action:${msg.data.action}` : 'lorax_write', msg.data);
          }
          if (/heat cycle|boost/i.test(msg.message || '')) heatCommandPending = null;
          updateHeatControls();
          // If it's a successful Lorax write, reload the path value
          if (msg.data && msg.data.path && selectedPathEntry && msg.data.path === selectedPathEntry.path) {
            readSelectedLoraxPath();
          }
          handleProfileSaveResponse(msg, false);
          break;
        case 'error':
          {
            const friendly = friendlyErrorMessage(msg.message);
            toast(friendly, 'error');
            appendLog(friendly, 'error');
            if (isBluetoothRelatedMessage(msg.message)) expandBleCapability();
          }
          renderConnectionAttempts(msg.data?.attempts);
          optimisticProfileIndex = null;
          if (deviceState?.profiles) updateProfilesUI(deviceState.profiles, deviceState.current_profile);
          if (scanPending) finishDeviceScan();
          if (connectPending) {
            connectPending = false;
            updateConnectionUI(false);
          } else if (connected && transportMode !== 'browser_ble') {
            setTimeout(() => send('status'), 50);
          }
          heatCommandPending = null;
          updateHeatControls();
          handleProfileSaveResponse(msg, true);
          break;
        case 'temperature_observe':
        case 'heat_observe':
          handleTemperatureObservation(msg.data);
          renderDevResult(msg.type, msg.data);
          break;
        case 'draw_strength_observe':
          handleDrawStrengthObservation(msg.data);
          renderDevResult(msg.type, msg.data);
          break;
        case 'heat_probe':
        case 'lorax_probe':
        case 'lorax_observe':
        case 'official_attributes':
          renderDevResult(msg.type, msg.data);
          break;
        case 'temperature_source':
          appendLog(msg.data ? `Live temp source: ${msg.data.path} (${msg.data.encoding})` : 'Live temp source cleared', 'info');
          renderDevResult(msg.type, msg.data);
          send('status');
          break;
        case 'draw_strength_source':
          if (msg.data?.path) {
            const mode = msg.data.mode === 'dynamic_inhale' ? 'dynamic inhale' : msg.data.mode || 'direct';
            appendLog(`Dynamic inhale source pinned: ${msg.data.path} (${mode})`, 'info');
          } else {
            appendLog('Dynamic inhale pin cleared — falling back to discovery', 'info');
          }
          renderDevResult(msg.type, msg.data);
          send('status');
          break;
        case 'draw_strength_redetect':
          // Re-probe just completed. Surface what the device exposed so
          // the user can tell which encoding actually works on their
          // firmware.
          if (msg.data?.encoding) {
            appendLog(`Dynamic inhale encoding detected: ${msg.data.encoding}${msg.data.error ? ` (${msg.data.error})` : ''}`, 'success');
          } else {
            appendLog(`Dynamic inhale redetect failed: ${msg.data?.error || 'no working encoding'}`, 'warn');
          }
          renderDevResult(msg.type, msg.data);
          send('status');
          break;
        case 'scan_devices':
          handleDeviceScan(msg.data);
          break;
        case 'lorax_registry':
          handleLoraxRegistry(msg.data);
          break;
        case 'lorax_read':
          handleLoraxRead(msg.data);
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err, msg);
      appendLog(`UI error processing ${msg.type || 'message'}: ${err.message}`, 'error');
      renderBackendMirror();
    }
  }

  // ---- Device State ----

  function normalizeConnectedPayload(data) {
    const payload = data && typeof data === 'object' ? { ...data } : {};
    payload.connected = true;
    if (!payload.name) payload.name = 'Connected';
    return payload;
  }

  function normalizeDisconnectedPayload(data, message) {
    const payload = data && typeof data === 'object' ? { ...data } : {};
    payload.connected = false;
    if (!payload.disconnect_reason) payload.disconnect_reason = message || 'Disconnected';
    if (!payload.timestamp) payload.timestamp = new Date().toISOString();
    return payload;
  }

  function extractDeviceStatePayload(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.status && typeof data.status === 'object') {
      return extractDeviceStatePayload(data.status);
    }
    const hasSnapshotShape =
      data.connected === true ||
      data.connected === false ||
      data.battery !== undefined ||
      data.heat_report !== undefined ||
      data.official_attributes !== undefined ||
      data.readable !== undefined ||
      data.labels !== undefined;
    return hasSnapshotShape ? data : null;
  }

  function updateDeviceState(data) {
    if (!data) return;
    data = normalizeSnapshotForUi(data);
    deviceState = data;
    lastDeviceSnapshot = data;
    connected = data.connected === true;
    // Dab scoring: feed normalized status into dab detector
    if (dabEnabled && connected) dabOnStatus(data);
    if (connected) rememberLastConnected(data);
    if (data.current_profile != null && Number(data.current_profile) === Number(optimisticProfileIndex)) {
      optimisticProfileIndex = null;
    }
    document.body.classList.toggle('heat-active', connected && isHeatActive(data));
    updateConnectionUI(connected);
    if (connected) {
      updateStatusUI(data);
      updateProfilesUI(data.profiles, optimisticProfileIndex ?? data.current_profile);
      renderProfileLibrary();
      renderBackendMirror();
      stealthOn = !!data.stealth;
      updateToggle('toggle-stealth', stealthOn);
      lanternOn = !!data.lantern;
      updateToggle('toggle-lantern', lanternOn);

      // Lorax elements visibility
      const loraxEmpty = document.getElementById('lorax-empty');
      const loraxContent = document.getElementById('lorax-content');
      if (loraxEmpty) loraxEmpty.classList.add('hidden');
      if (loraxContent) loraxContent.classList.remove('hidden');

      requestLoraxRegistry();
    } else {
      updateStatusUI(null);
      updateProfilesUI([], null);
      renderProfileLibrary();
      closeModal();
      const loraxEmpty = document.getElementById('lorax-empty');
      const loraxContent = document.getElementById('lorax-content');
      if (loraxEmpty) loraxEmpty.classList.remove('hidden');
      if (loraxContent) loraxContent.classList.add('hidden');
    }
    reconcileHeatPending();
    updateHeatControls();
    renderBackendMirror();
    if (pendingProfileReload != null) applyPendingProfileReload();
  }

  // ---- UI Updates ----

  function setConnectedOnlyVisibility(isConnected) {
    document.querySelectorAll('.connected-only, .connected-only-nav').forEach((el) => {
      el.hidden = !isConnected;
      el.setAttribute('aria-hidden', String(!isConnected));
      if ('inert' in el) el.inert = !isConnected;
      if (el.classList.contains('connected-only-nav')) {
        el.tabIndex = isConnected ? 0 : -1;
      }
    });
    updateActiveNavLink();
  }

  function sectionIsReachable(section) {
    if (!section) return false;
    if (section.hidden || section.getAttribute('aria-hidden') === 'true') return false;
    if (section.closest('[hidden], [aria-hidden="true"]')) return false;
    return true;
  }

  function updateActiveNavLink(forcedHash = '') {
    const links = [...document.querySelectorAll('.app-menu a[href^="#"]')];
    if (!links.length) return;
    const visibleLinks = links.filter((link) => !link.hidden && link.getAttribute('aria-hidden') !== 'true');
    const viewportAnchor = Math.max(110, Math.round(window.innerHeight * 0.22));
    let active = forcedHash;

    if (!active) {
      let best = null;
      visibleLinks.forEach((link) => {
        const section = document.querySelector(link.getAttribute('href'));
        if (!sectionIsReachable(section)) return;
        const rect = section.getBoundingClientRect();
        if (rect.bottom < viewportAnchor) return;
        const score = Math.abs(rect.top - viewportAnchor);
        if (!best || score < best.score) best = { link, score };
      });
      active = best?.link?.getAttribute('href') || visibleLinks[0]?.getAttribute('href') || '';
    }

    links.forEach((link) => {
      const isActive = link.getAttribute('href') === active;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }

  const LABEL_HELP = {
    Power: 'Battery charge state and current battery level.',
    Device: 'Connected device name, model, and serial when available.',
    State: 'Current firmware operating state reported by the device.',
    'Active Profile': 'Selected heat profile slot and profile name.',
    'Live Temp': 'Current chamber temperature from the official live temperature path.',
    Target: 'Target heater temperature for the active profile or heat cycle.',
    Timer: 'Firmware heat-cycle countdown when active, otherwise selected profile duration.',
    Boost: 'Selected profile boost settings from /p/app/thc/btmp and /p/app/thc/btim.',
    'LED Brightness': 'Per-zone LED brightness read from /u/app/ui/lbrt.',
    Chamber: 'Detected chamber type reported by firmware.',
    Firmware: 'Application firmware version from package helpers or /p/sys/fw/ver.',
    'Last Connected': 'Most recent successful local connection remembered by this browser.',
    Remaining: 'Time remaining until the active heat cycle ends automatically.',
    'Backend Stage': 'Most recent backend connection stage.',
    'Last Message': 'Most recent WebSocket or command message.',
    Updated: 'Timestamp of the latest status snapshot.',
    'BLE Link': 'Whether the backend still sees the Bluetooth link as connected.',
    'Backend Connected': 'Backend device-connected flag.',
    Polling: 'Backend background status polling state.',
    'Battery Raw': 'Raw battery telemetry used to derive the displayed battery percent.',
    'Temp Source': 'Lorax path used for live chamber temperature.',
    Bootloader: 'Bootloader firmware version from package helpers or /p/sys/fw/bver.',
    Serial: 'Hardware serial number from /p/sys/hw/ser when available.',
    Lantern: 'Lantern state or remaining lantern duration.',
    'Low Battery': 'Low-battery warning or threshold telemetry.',
    'Max Battery': 'Configured maximum battery charge level.',
  };

  function initLabelTooltips() {
    document.querySelectorAll('.stat-label').forEach((label) => {
      const text = label.textContent.trim();
      label.title = LABEL_HELP[text] || `${text} telemetry from the current device snapshot.`;
      label.tabIndex = 0;
      label.setAttribute('role', 'button');
    });
    document.addEventListener('click', (event) => {
      const label = event.target.closest('.stat-label');
      if (!label) return;
      const text = label.textContent.trim();
      showLabelTooltip(label, LABEL_HELP[text] || `${text} telemetry from the current device snapshot.`);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const label = event.target.closest('.stat-label');
      if (!label) return;
      event.preventDefault();
      const text = label.textContent.trim();
      showLabelTooltip(label, LABEL_HELP[text] || `${text} telemetry from the current device snapshot.`);
    });
  }

  function showLabelTooltip(anchor, message) {
    document.querySelectorAll('.label-tooltip').forEach((node) => node.remove());
    const tip = document.createElement('div');
    tip.className = 'label-tooltip';
    tip.textContent = message;
    document.body.appendChild(tip);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(12, rect.left));
    const top = Math.min(window.innerHeight - tip.offsetHeight - 12, rect.bottom + 8);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    setTimeout(() => tip.remove(), 2800);
  }

  function initAppNavigation() {
    const nav = document.querySelector('.app-menu');
    if (!nav) return;
    nav.addEventListener('click', (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      const hash = link.getAttribute('href');
      const section = document.querySelector(hash);
      if (hash === '#advanced-panel' && section) section.open = true;
      updateActiveNavLink(hash);
    });
    window.addEventListener('scroll', () => updateActiveNavLink(), { passive: true });
    window.addEventListener('hashchange', () => {
      const section = document.querySelector(window.location.hash);
      if (window.location.hash === '#advanced-panel' && section) section.open = true;
      updateActiveNavLink(window.location.hash);
    });
    updateActiveNavLink(window.location.hash);
  }

  function updateConnectionUI(isConnected) {
    document.body.classList.toggle('device-connected', isConnected);
    document.body.classList.toggle('device-disconnected', !isConnected);
    if (!isConnected) document.body.classList.remove('heat-active');
    setConnectedOnlyVisibility(isConnected);
    const badge = document.getElementById('connection-badge');
    const text = document.getElementById('connection-text');
    const btnConnect = document.getElementById('btn-connect');
    const btnDisconnect = document.getElementById('btn-disconnect');
    const btnScan = document.getElementById('btn-scan');
    const nameInput = document.getElementById('device-name');
    const macToggle = document.getElementById('use-mac-address');
    const scanResults = document.getElementById('device-scan-results');

    if (isConnected) {
      if (badge) badge.classList.add('connected');
      if (text) text.textContent = deviceState?.name || 'Connected';
      if (btnConnect) {
        btnConnect.classList.add('hidden');
        btnConnect.innerHTML = 'Connect';
        btnConnect.disabled = false;
      }
      updateScanButtonVisibility();
      if (btnDisconnect) btnDisconnect.classList.remove('hidden');

      if (nameInput) {
        const group = nameInput.closest('.input-group');
        if (group) group.classList.add('hidden');
      }
      if (macToggle) {
        const group = macToggle.closest('.optional-device-field');
        if (group) group.classList.add('hidden');
      }
      if (scanResults) {
        scanResults.classList.remove('active');
        scanResults.innerHTML = '';
      }

      updateControlAvailability(true);
    } else {
      connectPending = false;
      scanPending = false;
      if (badge) badge.classList.remove('connected');
      if (text) text.textContent = 'Disconnected';
      if (btnConnect) {
        btnConnect.classList.remove('hidden');
        btnConnect.innerHTML = 'Connect';
        btnConnect.disabled = false;
      }
      if (btnScan) {
        btnScan.textContent = SCAN_BUTTON_TEXT;
      }
      updateScanButtonVisibility();
      if (btnDisconnect) btnDisconnect.classList.add('hidden');

      if (nameInput) {
        const group = nameInput.closest('.input-group');
        if (group) group.classList.remove('hidden');
      }
      if (macToggle) {
        const group = macToggle.closest('.optional-device-field');
        if (group) group.classList.remove('hidden');
      }
      if (scanResults) {
        scanResults.classList.remove('active');
        scanResults.innerHTML = '';
      }

      heatCommandPending = null;
      updateControlAvailability(false);
    }
    syncIdentityModeUI();
  }

  function usingMacAddress() {
    return Boolean(document.getElementById('use-mac-address')?.checked);
  }

  function isMacAddressString(value) {
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(normalizeMacAddress(value));
  }

  function normalizeMacAddress(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return '';
    const compact = raw.replace(/[^0-9A-F]/g, '');
    if (compact.length !== 12) return raw.replace(/-/g, ':');
    return compact.match(/.{1,2}/g).join(':');
  }

  function normalizeMacPrefix(value) {
    const raw = String(value || '').trim().toUpperCase();
    const compact = raw.replace(/[^0-9A-F]/g, '');
    if (compact.length >= 6) return compact.slice(0, 6).match(/.{1,2}/g).join(':');
    const parts = normalizeMacAddress(value).split(':').filter(Boolean);
    return parts.length >= 3 ? parts.slice(0, 3).join(':') : '';
  }

  function scanManufacturerPrefixes(data) {
    const explicit = Array.isArray(data?.manufacturer_prefixes)
      ? data.manufacturer_prefixes
      : Array.isArray(data?.mac_prefixes)
        ? data.mac_prefixes
        : data?.manufacturer_prefix
          ? [data.manufacturer_prefix]
          : PUFFCO_MANUFACTURER_MAC_PREFIXES;
    const normalized = explicit.map(normalizeMacPrefix).filter(Boolean);
    return normalized.length ? [...new Set(normalized)] : PUFFCO_MANUFACTURER_MAC_PREFIXES;
  }

  function deviceScanAddress(item) {
    return normalizeMacAddress(item?.address || item?.mac || item?.mac_address || item?.bdaddr || '');
  }

  function matchesPuffcoManufacturerPrefix(address, prefixes = PUFFCO_MANUFACTURER_MAC_PREFIXES) {
    const normalized = normalizeMacAddress(address);
    const normalizedPrefixes = (Array.isArray(prefixes) ? prefixes : [prefixes])
      .map(normalizeMacPrefix)
      .filter(Boolean);
    const effectivePrefixes = normalizedPrefixes.length ? normalizedPrefixes : PUFFCO_MANUFACTURER_MAC_PREFIXES;
    return effectivePrefixes.some((prefix) => normalized.startsWith(`${prefix}:`));
  }

  // Bridge scan no longer filters by manufacturer prefix. We return every
  // device and decorate each row with a `likely_puffco` boolean so the UI
  // can still surface the best candidates. The Puffco hardware has shipped
  // under multiple Bluetooth identifiers and we don't want to hide a user's
  // device because its MAC prefix changed.
  function filterPuffcoScanDevices(devices, prefixes = PUFFCO_MANUFACTURER_MAC_PREFIXES) {
    return (Array.isArray(devices) ? devices : [])
      .map((item) => {
        const address = deviceScanAddress(item);
        const name = String(item?.name || '').toLowerCase();
        const likelyByName = /(peak|pearl|puffco|proxy|lorax)/i.test(name);
        const likelyByMac = matchesPuffcoManufacturerPrefix(address, prefixes);
        return {
          ...(item && typeof item === 'object' ? item : {}),
          address,
          likely_puffco: Boolean(item?.likely_puffco ?? likelyByName ?? likelyByMac),
          likely_by_name: likelyByName,
          likely_by_mac: likelyByMac,
        };
      })
      // Sort likely Puffcos first, then by RSSI (strongest signal first)
      .sort((a, b) => {
        if (a.likely_puffco !== b.likely_puffco) return a.likely_puffco ? -1 : 1;
        const ar = Number(a.rssi) || -999;
        const br = Number(b.rssi) || -999;
        return br - ar;
      });
  }

  function syncIdentityModeUI() {
    const macMode = usingMacAddress();
    const label = document.getElementById('device-identity-label');
    const input = document.getElementById('device-name');
    if (label) label.textContent = macMode ? 'MAC Address' : 'Device Name';
    if (input) {
      input.placeholder = macMode ? `${PUFFCO_MANUFACTURER_MAC_PREFIX}:00:00:00` : 'Puffco';
      input.setAttribute('aria-label', macMode ? 'Device MAC address' : 'Device name');
    }
  }

  function toggleMacAddressMode() {
    const input = document.getElementById('device-name');
    const macMode = usingMacAddress();
    const current = input?.value.trim() || '';
    if (macMode) {
      if (current && !isMacAddressString(current)) {
        try { localStorage.setItem('puffco_device_name', current); } catch { /* ignore */ }
      }
      if (input) input.value = localStorage.getItem('puffco_device_mac') || '';
    } else {
      if (isMacAddressString(current)) {
        try { localStorage.setItem('puffco_device_mac', current); } catch { /* ignore */ }
      }
      if (input) input.value = localStorage.getItem('puffco_device_name') || 'Puffco';
    }
    try { localStorage.setItem('puffco_use_mac_address', macMode ? '1' : '0'); }
    catch { /* ignore */ }
    syncIdentityModeUI();
  }

  function currentDeviceIdentity() {
    const value = document.getElementById('device-name')?.value.trim() || '';
    if (!isAdvancedUser()) {
      return { device: 'Puffco', mac: undefined, display: 'Puffco' };
    }
    if (usingMacAddress()) {
      const mac = isMacAddressString(value) ? normalizeMacAddress(value) : value;
      return { device: 'Puffco', mac: mac || undefined, display: mac || 'MAC address' };
    }
    return { device: value || 'Puffco', mac: undefined, display: value || 'Puffco' };
  }

  function updateControlAvailability(isConnected) {
    const selectors = [
      '#controls-grid .connected-only button',
      'button[data-device-command]',
      '#profiles-card button',
      '#brightness-card button',
      '#brightness-card input',
      '#power-card button',
    ];
    document.querySelectorAll(selectors.join(',')).forEach((el) => {
      el.disabled = !isConnected;
    });
    document.querySelectorAll('#voice-card button, #voice-card input').forEach((el) => {
      el.disabled = false;
    });
    applyCapabilityGates(deviceState);
    updateHeatControls();
  }

  function rememberLastConnected(data) {
    const stamp = {
      timestamp: new Date().toISOString(),
      name: data?.name || null,
      serial: data?.serial || null,
      transport: data?.transport || data?.backend?.transport || transportMode,
    };
    try {
      localStorage.setItem(LAST_CONNECTED_KEY, JSON.stringify(stamp));
    } catch {}
  }

  function lastConnectedLabel() {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_CONNECTED_KEY) || 'null');
      if (!saved?.timestamp) return '—';
      const when = formatTimestamp(saved.timestamp);
      return saved.name ? `${when} · ${saved.name}` : when;
    } catch {
      return '—';
    }
  }

  function detectCapabilities(data) {
    const hasProfiles = Array.isArray(data?.profiles) && data.profiles.length > 0;
    const official = data?.official_attributes || {};
    const errors = data?.official_errors || {};
    const chamber = formatChamber(data?.chamber);
    const noChamber = /no chamber|not detected|missing|none/i.test(`${chamber} ${data?.error || ''}`);
    const officialErrorCount = errors && typeof errors === 'object' ? Object.keys(errors).length : 0;
    return {
      heat: {
        ok: Boolean(data?.connected && !noChamber),
        reason: noChamber ? 'Chamber not ready' : !data?.connected ? 'Device disconnected' : '',
      },
      boost: {
        ok: Boolean(data?.connected && !noChamber && (data.boost_time_s != null || data.boost_temperature_delta_f != null || data.official_readable?.boostTime || data.official_readable?.boostTemperature || isHeatActive(data))),
        reason: noChamber ? 'Chamber not ready' : 'Boost settings not exposed yet',
      },
      mood: {
        ok: Boolean(data?.connected && hasProfiles),
        reason: hasProfiles ? '' : 'Profile color slots not available',
      },
      lantern: {
        ok: Boolean(data?.connected && (data.lantern != null || official.lanternRemainingTime != null || data.lantern_remaining_time_s != null)),
        reason: 'Lantern state not exposed by this firmware',
      },
      stealth: {
        ok: Boolean(data?.connected && data.stealth != null),
        reason: 'Stealth state not exposed by this firmware',
      },
      brightness: {
        ok: Boolean(data?.connected && (data.led_brightness != null || data.official_readable?.brightness)),
        reason: 'LED brightness readback not exposed yet',
      },
      official: {
        ok: officialErrorCount === 0,
        reason: officialErrorCount ? `${officialErrorCount} official attribute read issue${officialErrorCount === 1 ? '' : 's'}` : '',
      },
    };
  }

  function applyCapabilityGates(data) {
    const caps = detectCapabilities(data || {});
    const setGate = (selector, cap) => {
      document.querySelectorAll(selector).forEach((el) => {
        const disabled = !connected || !cap.ok;
        el.disabled = disabled;
        if (disabled && cap.reason) el.title = cap.reason;
        else el.removeAttribute('title');
      });
    };
    setGate('#toggle-lantern, button[onclick="app.applyMoodToLantern()"]', caps.lantern);
    setGate('#toggle-stealth', caps.stealth);
    setGate('#brightness-card button, #brightness-card input', caps.brightness);
    setGate('button[data-device-command="mood_light"]', caps.mood);
    const extend = document.getElementById('btn-extend');
    if (extend) {
      extend.disabled = true;
      extend.title = 'Extend is not exposed by this BLE bridge yet';
    }
    renderCapabilityStrip(caps);
  }

  function renderCapabilityStrip(caps) {
    const strip = document.getElementById('capability-strip');
    if (!strip) return;
    const items = [
      ['Heat', caps.heat],
      ['Mood', caps.mood],
      ['Lantern', caps.lantern],
      ['Stealth', caps.stealth],
      ['Brightness', caps.brightness],
      ['Official attrs', caps.official],
    ];
    strip.innerHTML = items.map(([label, cap]) => {
      const title = cap.ok ? `${label} supported` : cap.reason;
      return `<span class="capability-pill ${cap.ok ? 'ok' : 'warn'}" title="${escAttr(title)}">${escHtml(label)} ${cap.ok ? 'OK' : 'Limited'}</span>`;
    }).join('');
  }

  function updateStatusUI(data) {
    const empty = document.getElementById('status-empty');
    const content = document.getElementById('status-content');

    if (!data || !data.connected) {
      if (empty) empty.classList.add('visible');
      if (content) content.classList.add('hidden');
      updateTelemetryFields(null);
      updateHeroTelemetry(null);
      updateHeatLiveUI(data);
      applyCapabilityGates(null);
      // Clear every backend-mirror stat-* so a stale value doesn't linger
      // after a disconnect.
      const mirrorIds = [
        'stat-battery-source', 'stat-charge-eta', 'stat-lantern-time', 'stat-low-battery', 'stat-max-battery',
        'stat-firmware', 'stat-bootloader', 'stat-serial', 'stat-name',
        'stat-dpd', 'stat-drem', 'stat-total-dabs',
        'stat-dpd-hero', 'stat-drem-hero', 'stat-total-dabs-hero', 'stat-dpd-trend',
        'stat-battery-voltage', 'stat-battery-current', 'stat-battery-temperature', 'stat-battery-capacity',
        'stat-heater-power', 'stat-heater-resistance', 'stat-heater-voltage',
        'stat-charge-source', 'stat-charge-rate', 'stat-charge-elapsed',
        'stat-cable-attached', 'stat-mode', 'stat-days-owned', 'stat-device-utc',
        'stat-fault-end', 'stat-ble-fault-abs', 'stat-ble-fault-cr', 'stat-avg-time-dab',
      ];
      mirrorIds.forEach((id) => setText(id, '—'));
      document.getElementById('boost-options-panel')?.classList.add('hidden');
      return;
    }

    if (empty) empty.classList.remove('visible');
    if (content) content.classList.remove('hidden');
    const labels = data.labels || {};

    // Power and usage summary
    const pct = normalizePercent(data.battery);
    const fill = document.getElementById('battery-fill');
    const ring = document.getElementById('battery-ring');
    const chargeCss = chargeClass(data.charge);
    const batteryClass = pct < 15 ? ' critical' : pct < 30 ? ' low' : '';
    if (fill) {
      fill.style.width = data.battery != null ? `${pct}%` : '0%';
      fill.className = `battery-fill${batteryClass} ${chargeCss}`.trim();
    }
    if (ring) {
      ring.style.setProperty('--battery-level', String(data.battery != null ? pct : 0));
      ring.className = `battery-ring${batteryClass} ${chargeCss}`.trim();
    }
    const batteryEl = document.getElementById('battery-pct');
    if (batteryEl) {
      batteryEl.textContent = labels.battery ?? (data.battery != null ? `${pct}%` : '—');
    }

    const chargeLabel = labels.charge ?? formatCharge(data.charge);
    const chargePill = document.getElementById('charge-pill');
    if (chargePill) {
      chargePill.textContent = chargeLabel;
      chargePill.className = `charge-pill ${chargeCss}`;
    }

    // Stats
    setText('stat-state', labels.state ?? formatDeviceState(data.state));
    setText('stat-chamber', labels.chamber ?? formatChamber(data.chamber));
    setText('stat-device-model', formatDeviceIdentity(data));
    setText('stat-firmware-inline', data.firmware || data.software_version || '—');
    setText('stat-firmware-display', data.firmware || data.software_version || '—');
    setText('stat-serial-display', data.serial ?? '—');
    setText('stat-last-connected', lastConnectedLabel());
    setText('stat-charge', chargeLabel);
    updateTelemetryFields(data);
    setText('stat-firmware', data.firmware ?? '—');
    setText('stat-bootloader', data.bootloader ?? '—');
    setText('stat-serial', data.serial ?? '—');
    setText('stat-dpd', labels.dabs_per_day ?? formatDabsPerDay(data.dabs_per_day));
    setText('stat-drem', labels.dabs_left ?? formatMetric(data.dabs_left, 0));
    setText('stat-total-dabs', labels.total_dabs ?? formatMetric(data.total_dabs, 0));
    // Hero usage strip — same fields surfaced in the status card so
    // the user doesn't have to open the backend mirror to see how
    // their week is going.
    setText('stat-dpd-hero', formatDabsPerDay(data.dabs_per_day));
    setText('stat-drem-hero', formatMetric(data.dabs_left, 0));
    setText('stat-total-dabs-hero', formatMetric(data.total_dabs, 0));
    // Cleaning reminder is local-state, not a device field. Render
    // it on every snapshot so the counter stays in sync with whatever
    // just happened on the device (cleaning cycle, dab save, etc.).
    updateCleaningReminder();
    {
      const trendEl = document.getElementById('stat-dpd-trend');
      if (trendEl) {
        const dpd = Number(data.dabs_per_day);
        const days = Number(data.days_owned);
        if (Number.isFinite(dpd) && Number.isFinite(days) && days > 0 && data.total_dabs != null) {
          const expected = Number(data.total_dabs) / days;
          if (Number.isFinite(expected) && expected > 0) {
            const ratio = dpd / expected;
            const pct = Math.round((ratio - 1) * 100);
            trendEl.textContent = pct === 0 ? 'on pace' : `${pct > 0 ? '+' : ''}${pct}% vs avg`;
          } else {
            trendEl.textContent = '—';
          }
        } else {
          trendEl.textContent = '—';
        }
      }
    }
    setText('stat-name', data.name ?? '—');
    // Hardware diagnostics — every value below is sourced from an
    // OFFICIAL_ATTRIBUTE_SPECS Lorax path. When the path didn't read,
    // the field is null and we fall back to "—".
    const hw = data;
    setText('stat-battery-voltage',   labels.battery_voltage  ?? (hw.battery_voltage_v  == null ? '—' : `${hw.battery_voltage_v.toFixed(2)} V`));
    setText('stat-battery-current',   labels.battery_current  ?? (hw.battery_current_a  == null ? '—' : `${(Math.abs(hw.battery_current_a) * 1000).toFixed(0)} mA`));
    setText('stat-battery-temperature', labels.battery_temperature ?? (hw.battery_temperature_c == null ? '—' : `${hw.battery_temperature_c.toFixed(1)} °C`));
    setText('stat-battery-capacity',  labels.battery_capacity ?? (hw.battery_capacity   == null ? '—' : `${Math.round(hw.battery_capacity)} mAh`));
    setText('stat-heater-power',      labels.heater_power     ?? (hw.heater_power_w     == null ? '—' : `${hw.heater_power_w.toFixed(1)} W`));
    setText('stat-heater-resistance', labels.heater_resistance?? (hw.heater_resistance_ohm == null ? '—' : `${hw.heater_resistance_ohm.toFixed(2)} Ω`));
    setText('stat-heater-voltage',    labels.heater_voltage   ?? (hw.heater_voltage_v   == null ? '—' : `${hw.heater_voltage_v.toFixed(2)} V`));
    setText('stat-charge-source',     labels.charge_source    ?? (hw.charge_source_label ?? (hw.charge_source == null ? '—' : 'Source ' + hw.charge_source)));
    setText('stat-charge-rate',       labels.charge_rate      ?? (hw.charge_rate_w      == null ? '—' : `${hw.charge_rate_w} W`));
    setText('stat-charge-elapsed',    hw.charge_elapsed_time_s == null ? '—' : formatSecondsLabel(hw.charge_elapsed_time_s));
    setText('stat-cable-attached',    labels.cable_attached   ?? (hw.cable_attached === true ? 'Cable attached' : hw.cable_attached === false ? 'On battery' : '—'));
    setText('stat-mode',              labels.mode             ?? (hw.mode == null ? '—' : hw.mode.toFixed(2)));
    setText('stat-days-owned',        labels.days_owned       ?? (hw.days_owned == null ? '—' : `${hw.days_owned} day${hw.days_owned === 1 ? '' : 's'}`));
    setText('stat-device-utc',        hw.device_utc_time      ?? '—');
    setText('stat-fault-end',         hw.fault_end_index      == null ? '—' : String(hw.fault_end_index));
    setText('stat-ble-fault-abs',     hw.ble_fault_absolute_count == null ? '—' : String(hw.ble_fault_absolute_count));
    setText('stat-ble-fault-cr',      hw.ble_fault_credit_count   == null ? '—' : String(hw.ble_fault_credit_count));
    setText('stat-avg-time-dab',      hw.avg_seconds_per_dab == null ? '—' : formatSecondsLabel(hw.avg_seconds_per_dab));
    updateHeroTelemetry(data);

    // Heat indicator
    const indicator = document.getElementById('heat-indicator');
    const isHeating = isHeatActive(data);
    if (indicator) {
      indicator.className = 'heat-indicator mt-sm' + (isHeating ? ' active' : '');
    }
    const heatStatusText = document.getElementById('heat-status-text');
    if (heatStatusText) {
      heatStatusText.textContent = heatStatusLabel(data);
    }
    updateHeatLiveUI(data);
    applyCapabilityGates(data);
    updateHeatControls();
  }

  function updateHeroTelemetry(data) {
    if (!data || !data.connected) {
      setText('hero-device-name', 'Disconnected');
      setText('hero-state-chip', 'Offline');
      setText('hero-current-temp', '—');
      setText('hero-target-temp', '—');
      setText('hero-heat-timer', '—');
      setText('hero-profile', '—');
      setText('hero-vapor', '—');
      return;
    }

    const report = getHeatReport(data);
    const readable = data.official_readable || {};
    const selectedProfile = getSelectedProfile(data);
    const current = report.current_temp_label || data.live_temperature?.label || readable.currentTemperature || formatTemperatureF(data.current_temperature_f) || '—';
    const target = formatTargetTemperature(data, report, readable, selectedProfile) || '—';
    const remaining = getDynamicRemainingSeconds(report);
    let timer = report.duration_label || formatSecondsLabel(selectedProfile?.time_s) || '—';
    if (remaining != null) {
      timer = formatSecondsClock(remaining);
    } else if (report.timer_confidence === 'preheating') {
      timer = 'Preheating';
    }

    const profileName = data.active_profile_name || selectedProfile?.name || (data.current_profile != null ? `Profile ${data.current_profile}` : '—');
    setText('hero-device-name', data.name || 'Puffco');
    setText('hero-state-chip', heatStatusLabel(data));
    setText('hero-current-temp', current);
    setText('hero-target-temp', target);
    setText('hero-heat-timer', timer);
    setText('hero-profile', profileName);
    setText('hero-vapor', selectedProfile ? vaporPresetMeta(selectedProfile).name : '—');
  }

  function updateHeatLiveUI(data) {
    const countdownEl = document.getElementById('heat-countdown');
    const phaseEl = document.getElementById('heat-live-phase');
    const currentEl = document.getElementById('heat-live-current');
    const targetEl = document.getElementById('heat-live-target');
    const metaEl = document.getElementById('heat-live-meta');
    const panel = document.getElementById('heat-live-panel');
    if (!countdownEl || !phaseEl || !currentEl || !targetEl || !metaEl || !panel) return;

    if (!data || !data.connected) {
      countdownEl.textContent = 'Idle';
      phaseEl.textContent = 'Disconnected';
      currentEl.textContent = 'Current unavailable';
      targetEl.textContent = 'Target unavailable';
      metaEl.textContent = 'Connect to read live heat state';
      panel.className = 'heat-live-panel';
      return;
    }

    const report = getHeatReport(data);
    const readable = data.official_readable || {};
    const heating = isHeatActive(data);
    const selectedProfile = getSelectedProfile(data);
    const current = report.current_temp_label || data.live_temperature?.label || readable.currentTemperature || formatTemperatureF(data.current_temperature_f);
    const target = formatTargetTemperature(data, report, readable, selectedProfile);
    let countdown = heating ? 'Syncing' : report.duration_label || formatSecondsLabel(selectedProfile?.time_s) || 'Idle';
    let meta = report.duration_label ? `${report.duration_label} profile` : 'Waiting for heat cycle';

    const dynamicRemaining = getDynamicRemainingSeconds(report);
    if (dynamicRemaining != null) {
      countdown = formatSecondsClock(dynamicRemaining);
      const prefix = report.timer_confidence === 'firmware' ? 'Firmware timer' : 'Timer';
      meta = `${prefix} running until automatic end`;
    } else if (heating && report.timer_confidence === 'syncing') {
      countdown = 'Sync';
      meta = 'Timer starts after an observed preheat-to-active transition';
    } else if (heating && report.timer_confidence === 'preheating') {
      countdown = 'Heat';
      meta = report.duration_label ? `Countdown begins at active heat, ${report.duration_label} profile` : 'Countdown begins at active heat';
    }

    countdownEl.textContent = countdown;
    phaseEl.textContent = report.phase || heatStatusLabel(data);
    currentEl.textContent = current ? `Current ${current}` : 'Current unavailable';
    targetEl.textContent = target ? `Target ${target}` : 'Target unavailable';
    metaEl.textContent = meta;
    updateSessionMetrics(data, dynamicRemaining);
    updateDrawStrengthUI(data);
    const hasTimer = ['observed', 'firmware'].includes(report.timer_confidence);
    panel.className = 'heat-live-panel' + (heating ? ' active' : '') + (hasTimer ? ' timer-running' : '');
    updateHeroTelemetry(data);
    updateTelemetryFields(data);
  }

  function updateSessionMetrics(data, remaining = null) {
    const report = getHeatReport(data);
    const rem = remaining != null
      ? formatSecondsClock(remaining)
      : report.timer_remaining_label || formatSecondsLabel(report.timer_remaining_s) || report.duration_label || '—';
    setText('session-remaining', rem);
    setText('session-boost', data?.connected ? formatBoostSetting(data, data.official_readable || {}) : '—');
    setText('session-chamber', data?.connected ? formatChamber(data.chamber) : '—');
  }

  // ---- Draw strength bar smoothing ----
  //
  // The draw strength sensor reports percent via the regular 1-second
  // status poll. With a pure CSS transition, the bar rises smoothly on
  // the inhale but snaps back to the next poll's value on the way down
  // — which looks like a flicker, not a real bar. Instead we keep two
  // values: a "target" set from the latest data, and a "displayed"
  // value that animates toward the target on each animation frame.
  //
  // Attack (rising) is fast so the bar feels responsive to a hard
  // pull: 0.32 of the gap per frame, which fills from 0→100% in ~6
  // frames (~100ms at 60fps). Release (falling) is much slower at
  // 0.045 per frame, so a 100→0% drop takes ~110 frames (~1.85s) —
  // long enough that a brief pause between hits doesn't fully
  // empty the bar. Peak hold snaps a tick to the highest seen
  // value and slowly lets it fall, so you can see the strongest
  // part of the hit even after the bar starts dropping.
  //
  // The peak-marker is a separate element (.draw-strength-peak) and
  // uses an independent CSS variable (--draw-peak) so the two don't
  // fight for the same transform.
  // Rise: snap to target (0.85 = essentially instant — the lag now
  // lives in the BLE poll, not in the bar's easing). Slow rise was
  // the #1 reason the inhale bar "felt" unresponsive even with the
  // 1Hz snapshot firing on time.
  const DRAW_BAR_RISE_PER_FRAME = 0.85;
  // Fall: still gentle so a soft inhale doesn't pin the bar high
  // after the user lets go. ~150ms to fall halfway.
  const DRAW_BAR_FALL_PER_FRAME = 0.10;
  const DRAW_PEAK_RISE_PER_FRAME = 0.85;  // peak catches up to a new high
  const DRAW_PEAK_HOLD_MS = 700;          // how long the peak stays put before falling
  const DRAW_PEAK_FALL_PER_FRAME = 0.06;  // peak decays over ~1s once the hold expires
  const drawBarState = {
    current: 0,
    target: 0,
    peak: 0,
    peakHeldUntil: 0,
    raf: 0,
    lastFrameMs: 0,
    connected: false,
    // Cached last integer percent written to #draw-strength-readout so the
    // rAF tick can skip the DOM write when the value hasn't changed.
    lastReadoutPct: null,
  };
  function tickDrawStrengthBar(nowMs) {
    const panel = document.getElementById('draw-strength-panel');
    if (!panel) {
      drawBarState.raf = 0;
      return;
    }
    const last = drawBarState.lastFrameMs || nowMs;
    const dt = Math.max(0, Math.min(80, nowMs - last)); // clamp to 80ms gaps
    drawBarState.lastFrameMs = nowMs;

    // Per-frame interpolation factor scales with elapsed time so the
    // bar still feels right on 30Hz displays or paused tabs.
    const dtScale = dt / 16.6667;
    if (drawBarState.current < drawBarState.target) {
      const step = (drawBarState.target - drawBarState.current) * DRAW_BAR_RISE_PER_FRAME * dtScale;
      drawBarState.current = Math.min(drawBarState.target, drawBarState.current + step);
    } else if (drawBarState.current > drawBarState.target) {
      const step = (drawBarState.current - drawBarState.target) * DRAW_BAR_FALL_PER_FRAME * dtScale;
      drawBarState.current = Math.max(drawBarState.target, drawBarState.current - step);
    }

    // Peak hold: track the highest current value seen, snap up
    // quickly, hold for a beat, then fall. If disconnected, peak
    // decays to 0 so the marker doesn't get stuck.
    // Peak-snap behavior: when a new hit exceeds the previous peak,
    // `peak = max(peak + rise, current)` snaps the marker up to the
    // current value on the very next frame so a sharp inhale can
    // never "under-read" the previous high.
    if (drawBarState.current >= drawBarState.peak - 0.01) {
      // New high or matched the previous peak: snap up and reset hold.
      const rise = (drawBarState.current - drawBarState.peak) * DRAW_PEAK_RISE_PER_FRAME * dtScale;
      drawBarState.peak = Math.max(drawBarState.peak + rise, drawBarState.current);
      drawBarState.peakHeldUntil = nowMs + DRAW_PEAK_HOLD_MS;
    } else if (nowMs > drawBarState.peakHeldUntil) {
      // Holding period elapsed, decay toward current.
      const drop = (drawBarState.peak - drawBarState.current) * DRAW_PEAK_FALL_PER_FRAME * dtScale;
      drawBarState.peak = Math.max(drawBarState.current, drawBarState.peak - drop);
    }

    panel.style.setProperty('--draw-strength', drawBarState.current.toFixed(2));
    panel.style.setProperty('--draw-peak', drawBarState.peak.toFixed(2));
    // The numeric readout is NOT written here. The bar easing is a
    // purely visual treatment; the readout mirrors the raw sensor
    // sample so the number always matches what the dab scorer is
    // consuming (see updateDrawStrengthUI).
    // Active CSS class is sticky once lit so a single 0 reading
    // between two real samples doesn't visually flicker off.
    panel.classList.toggle('bar-active', drawBarState.current >= 8);
    panel.classList.toggle('bar-hot', drawBarState.current >= 60);
    // Maxed-out state — airflow pinned at the top of the bar.
    // Triggers a strong glow + "MAX" suffix in the label.
    panel.classList.toggle('bar-maxed', drawBarState.current >= 95);
    panel.classList.toggle('bar-peak', drawBarState.peak - drawBarState.current >= 6);

    drawBarState.raf = window.requestAnimationFrame(tickDrawStrengthBar);
  }

  function startDrawBarLoop() {
    if (drawBarState.raf) return;
    drawBarState.lastFrameMs = 0;
    drawBarState.raf = window.requestAnimationFrame(tickDrawStrengthBar);
  }

  function resetDrawBarState() {
    drawBarState.current = 0;
    drawBarState.target = 0;
    drawBarState.peak = 0;
    drawBarState.peakHeldUntil = 0;
    drawBarState.lastReadoutPct = null;
    const panel = document.getElementById('draw-strength-panel');
    if (panel) {
      panel.style.setProperty('--draw-strength', '0');
      panel.style.setProperty('--draw-peak', '0');
    }
  }

  function updateDrawStrengthUI(data) {
    const panel = document.getElementById('draw-strength-panel');
    const label = document.getElementById('draw-strength-label');
    if (!panel || !label) return;
    // Readouts are normalized to the device's learned max draw (100 =
    // your hardest pull) and allow up to DAB_UI_AIRFLOW_MAX overshoot;
    // the bar itself stays visually capped at 100.
    const percent = data?.connected
      ? Math.max(0, Math.min(DAB_UI_AIRFLOW_MAX, Math.round(dabNormalizePercent(Number(data.draw_strength_percent) || 0))))
      : 0;
    const active = Boolean(data?.draw_strength_active || percent >= 5);
    const dynamicInhale = data?.draw_strength_mode === 'dynamic_inhale' || data?.draw_strength_source === '/p/app/htr/inh';
    const wasActive = panel.classList.contains('active');

    // Feed the smoothing loop. The loop is responsible for the actual
    // --draw-strength CSS variable, so we don't set it here directly.
    if (data?.connected) {
      drawBarState.connected = true;
      drawBarState.target = Math.min(100, percent);
      // First data point of a session: snap the bar to the value so
      // the user doesn't wait for it to ramp from 0.
      if (!wasActive && active && drawBarState.current === 0) {
        drawBarState.current = Math.min(100, percent);
      }
      startDrawBarLoop();
      // Also kick the 10Hz idle bar poll so the bar keeps moving
      // between 1Hz snapshots. The poll self-terminates if the bar
      // is no longer connected or a scoring-session sampler takes
      // over the radio.
      if (data?.draw_strength_source) dabStartIdleBarPoll();
    } else {
      drawBarState.connected = false;
      drawBarState.target = 0;
      dabStopIdleBarPoll();
      // Let the bar naturally decay to 0 in the loop rather than
      // snapping. The loop keeps running until the panel disappears.
      startDrawBarLoop();
    }
    panel.classList.toggle('active', active);
    // Round 2: surface a "heating" state on the draw panel when the
    // sensor is firing while the chamber is heating, so the panel
    // visually agrees with .heat-live-panel.timer-running.
    if (data?.connected && active && (data.heat === 'HEATING' || data.heat === 'BOOSTING' || data.heat === 'heating' || data.heat === 'boosting')) {
      panel.classList.add('heating');
    } else {
      panel.classList.remove('heating');
    }
    label.textContent = data?.connected
      ? (active
          ? (percent >= 95 ? `${percent}% MAX ${dynamicInhale ? 'inhale' : 'draw'}` : `${percent}% ${dynamicInhale ? 'inhale' : 'draw'}`)
          : 'Idle')
      : 'Disconnected';
    // Big numeric readout + screen-reader status. The readout mirrors
    // the RAW sensor sample — the exact draw_strength_percent value
    // the dab scorer consumes on the same poll — so the dynamic
    // inhale UI and dab scoring always report the same number for the
    // same draw. The bar's eased animation (--draw-strength) stays a
    // purely visual treatment and no longer drives the readout.
    const readout = document.getElementById('draw-strength-readout');
    if (readout) {
      if (!data?.connected) {
        readout.textContent = '—';
        drawBarState.lastReadoutPct = null;
      } else if (drawBarState.lastReadoutPct !== percent) {
        readout.textContent = `${percent}%`;
        drawBarState.lastReadoutPct = percent;
      }
    }
    if (data?.connected) {
      panel.setAttribute('aria-valuenow', String(percent));
    }
    if (data?.connected) {
      const verb = dynamicInhale ? 'inhale' : 'draw';
      panel.setAttribute('aria-valuetext',
        active
          ? `${percent} percent, active ${verb}${panel.classList.contains('heating') ? ', heating' : ''}`
          : 'Idle');
    } else {
      panel.setAttribute('aria-valuetext', 'Disconnected');
      panel.setAttribute('aria-valuenow', '0');
    }
    // Round 2: bump the per-session draw counter when a draw starts.
    // Trigger on the inactive->active transition while connected,
    // regardless of whether the device is currently heating (the
    // sensor can fire in idle state too).
    if (data?.connected && active && !wasActive && typeof bumpDrawSessionCount === 'function') {
      try { bumpDrawSessionCount(); } catch (_) { /* ignore */ }
    }

    // Round 2: keep the inline draw chip and the device-stage ring in
    // sync with the same data source. These work in both idle and
    // heating states.
    try { updateDrawSensorChip(data); } catch (_) { /* ignore */ }
    try { updateDrawSensorRing(data); } catch (_) { /* ignore */ }
  }

  function updateTelemetryFields(data) {
    const telemetryIds = [
      'stat-current-temp',
      'stat-target-temp',
      'stat-heat-timer',
      'stat-profile',
      'stat-vapor',
      'stat-battery-source',
      'stat-charge-eta',
      'stat-boost',
      'stat-lantern-time',
      'stat-low-battery',
      'stat-max-battery',
      'stat-led-brightness',
    ];
    if (!data || !data.connected) {
      telemetryIds.forEach((id) => setText(id, '—'));
      updateSessionMetrics(null);
      return;
    }
    const report = getHeatReport(data);
    const readable = data.official_readable || {};
    const selectedProfile = getSelectedProfile(data);
    const current = report.current_temp_label || data.live_temperature?.label || data.official_readable?.currentTemperature || formatTemperatureF(data.current_temperature_f);
    const target = formatTargetTemperature(data, report, readable, selectedProfile);
    const remaining = getDynamicRemainingSeconds(report);
    let timer = report.duration_label || formatSecondsLabel(selectedProfile?.time_s) || '—';
    if (remaining != null) {
      timer = formatSecondsClock(remaining);
    } else if (report.timer_confidence === 'preheating') {
      timer = 'Preheating';
    }

    const profileName = data.active_profile_name || selectedProfile?.name || (data.current_profile != null ? `Profile ${data.current_profile}` : '—');
    setText('stat-current-temp', current || '—');
    setText('stat-target-temp', target || '—');
    setText('stat-heat-timer', timer);
    setText('stat-profile', profileName);
    setText('stat-vapor', selectedProfile ? formatVaporPreset(selectedProfile) : '—');
    setText('stat-battery-source', formatBatterySource(data.battery_source, data.battery_source_type));
    setText('stat-charge-eta', formatChargeEta(data, readable));
    setText('stat-boost', formatBoostSetting(data, readable));
    setText('stat-lantern-time', formatLanternStatus(data, readable));
    setText('stat-low-battery', readable.lowBatteryIndicator || formatBooleanLabel(data.low_battery_indicator) || '—');
    setText('stat-max-battery', readable.maxBatteryLevel || formatPercentLabel(data.max_battery_level) || 'Not reported');
    setText('stat-led-brightness', readable.brightness || formatBrightness(data.led_brightness) || '—');
    syncBoostOptionInputs(data);
  }

  function updateHeatControls() {
    const startBtn = document.getElementById('btn-heat');
    const boostBtn = document.getElementById('btn-boost');
    const extendBtn = document.getElementById('btn-extend');
    const stopBtn = document.getElementById('btn-stop');
    const boostOptionsBtn = document.getElementById('btn-boost-options');
    const statusText = document.getElementById('heat-status-text');
    if (!startBtn || !boostBtn || !stopBtn) return;

    const heating = connected && isHeatActive(deviceState);
    const pending = !!heatCommandPending;
    startBtn.disabled = !connected || heating || pending;
    boostBtn.disabled = !connected || !heating || pending;
    if (extendBtn) extendBtn.disabled = true;
    stopBtn.disabled = !connected || (!heating && heatCommandPending !== 'heat') || pending;
    if (boostOptionsBtn) boostOptionsBtn.disabled = !connected || pending;
    boostBtn.classList.toggle('hidden', !heating);
    if (extendBtn) extendBtn.classList.add('hidden');
    stopBtn.classList.toggle('hidden', !heating);

    startBtn.classList.toggle('loading', heatCommandPending === 'heat');
    boostBtn.classList.toggle('loading', heatCommandPending === 'boost');
    stopBtn.classList.toggle('loading', heatCommandPending === 'stop');

    startBtn.textContent = heatCommandPending === 'heat' ? 'Starting…' : 'Start Heat';
    boostBtn.textContent = heatCommandPending === 'boost' ? 'Boosting…' : (isBoostActive(deviceState) ? 'Boost Active' : 'Boost');
    if (boostOptionsBtn) {
      const boostSetting = formatBoostSetting(deviceState || {}, deviceState?.official_readable || {});
      boostOptionsBtn.textContent = boostSetting === 'Boost options unavailable' ? 'Boost Options' : `Boost ${boostSetting}`;
      const panel = document.getElementById('boost-options-panel');
      boostOptionsBtn.setAttribute('aria-expanded', String(panel ? !panel.classList.contains('hidden') : false));
    }
    stopBtn.textContent = heatCommandPending === 'stop' ? 'Stopping…' : 'Stop';

    if (statusText && heatCommandPending) {
      const labels = { heat: 'Starting heat…', boost: 'Sending boost…', stop: 'Stopping heat…' };
      statusText.textContent = labels[heatCommandPending] || statusText.textContent;
    } else if (statusText) {
      statusText.textContent = heatStatusLabel(deviceState);
    }
  }

  function updateProfilesUI(profiles, currentIndex) {
    const grid = document.getElementById('profiles-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const colorBtns = document.getElementById('color-profile-btns');
    if (colorBtns) colorBtns.innerHTML = '';
    if (!profiles || profiles.length === 0) {
      grid.innerHTML = '<div class="empty-state compact">Connect to load heat profiles.</div>';
      return;
    }

    const orderedProfiles = applySavedProfileOrder(profiles);
    orderedProfiles.forEach((rawProfile, i) => {
      const p = profileWithVapor(rawProfile, i);
      const profileIndex = Number(p.index ?? i);
      const isPending = optimisticProfileIndex != null && Number(optimisticProfileIndex) === profileIndex;
      const isActive = isPending || p.active || profileIndex === Number(currentIndex);
      const profileColors = extractProfileColors(p.color);
      const profileColor = profileColors[0] || extractProfileColor(p.color);
      const profileSwatch = profileColorBackground(profileColors);
      const mood = extractProfileMood(p.color);
      const moodOrigin = profileMoodOrigin(p.color);
      const moodName = mood.name;
      const tempLabel = formatProfileTemperature(p.temp_f);
      const timeLabel = formatProfileDuration(p.time_s);
      const vaporLabel = formatVaporPreset(p, { short: true });

      // Profile card
      const card = document.createElement('div');
      card.className = 'profile-card' + (isActive ? ' active' : '') + (isPending ? ' pending' : '');
      card.style.setProperty('--profile-color', profileColor);
      card.tabIndex = 0;
      // Native HTML5 dragstart/drop are now handled by Sortable on the
      // grid container (see wireProfilesSortable). We still need the
      // data attribute for the reorder callback to identify the slot.
      card.dataset.profileIndex = String(profileIndex);
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `Select ${p.name || `Profile ${profileIndex}`}`);
      card.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        selectProfile(profileIndex);
      });
      card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectProfile(profileIndex);
        }
      });

      card.innerHTML = `
        <div class="profile-name">
          <span class="profile-drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
          <span class="active-indicator"></span>
          <span>${escHtml(p.name || `Profile ${profileIndex}`)}</span>
          <div class="profile-color-swatch" style="background:${escAttr(profileSwatch)};margin-left:auto;"></div>
        </div>
        <div class="profile-meta">
          <span>${escHtml(tempLabel)}</span>
          <span>${escHtml(timeLabel)}</span>
          <span>${escHtml(vaporLabel)}</span>
          <span>${escHtml(moodName)}</span>
          <span class="profile-sync-badge ${moodOrigin.className}">${escHtml(moodOrigin.label)}</span>
        </div>
        <div class="profile-actions">
          <button class="btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}" onclick="app.selectProfile(${profileIndex})">
            ${isPending ? 'Switching...' : isActive ? 'Active' : 'Select'}
          </button>
          <button class="btn btn-sm btn-secondary" onclick="app.editProfile(${profileIndex})">Edit</button>
          <button class="btn btn-sm btn-secondary" onclick="app.saveDeviceProfileToLibrary(${profileIndex})">Save Local</button>
        </div>
      `;
      grid.appendChild(card);

      // Color target button
      if (colorBtns) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm ' + (isActive ? 'btn-primary' : 'btn-secondary');
        btn.textContent = p.name || `Profile ${p.index}`;
        btn.dataset.deviceCommand = 'mood_light';
        btn.onclick = () => applyMoodToSpecificProfile(p.index);
        colorBtns.appendChild(btn);
      }
    });
    renderProfileLibrary();
    wireProfilesSortable(grid);
  }

  // Wire Sortable on the device-profiles grid. Idempotent: subsequent
  // renders reuse the existing instance, but only the new children
  // are draggable thanks to Sortable's event delegation.
  // ---- Unified Sortable factory ----
  // Every drag surface in the app routes through this one factory so
  // the physics, classes, and touch behavior are identical everywhere.
  // This replaced a mix of five hand-tuned Sortable configs and two
  // native HTML5 drag implementations (which shared a broken
  // getDragAfterElement helper that only matched .lorax-tab elements
  // and only measured horizontally — the source of most of the
  // "drag and drop is buggy" reports: status items always dropped to
  // the end, vertical lists used horizontal hit-testing, and each
  // surface animated differently).
  function createUnifiedSortable(el, overrides = {}) {
    if (!el || typeof Sortable === 'undefined') return null;
    const defaults = {
      animation: 200,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      dragClass: 'sortable-drag',
      forceFallback: true,       // identical behavior across browsers
      fallbackOnBody: true,      // ghost never clipped by overflow
      fallbackTolerance: 5,
      swapThreshold: 0.6,        // less twitchy slot swapping
      delay: 120,
      delayOnTouchOnly: true,    // immediate on mouse, long-press on touch
      touchStartThreshold: 5,
      scroll: true,
      scrollSensitivity: 60,
      scrollSpeed: 12,
      bubbleScroll: true,
    };
    const opts = { ...defaults, ...overrides };
    // Always tag the body during a drag so global CSS (wiggle pause,
    // cursor) reacts, while still honoring caller hooks.
    const userStart = opts.onStart;
    const userEnd = opts.onEnd;
    opts.onStart = (evt) => {
      document.body.classList.add('sortable-active');
      if (typeof userStart === 'function') userStart(evt);
    };
    opts.onEnd = (evt) => {
      document.body.classList.remove('sortable-active');
      if (typeof userEnd === 'function') userEnd(evt);
    };
    return Sortable.create(el, opts);
  }

  function wireProfilesSortable(grid) {
    if (!grid || typeof Sortable === 'undefined') return;
    if (grid.__sortableProfileInstance) return;
    const instance = createUnifiedSortable(grid, {
      draggable: '.profile-card',
      handle: '.profile-drag-handle, .profile-card',
      filter: 'button, input, .profile-actions',
      preventOnFilter: true,
      ghostClass: 'profile-drag-ghost',
      chosenClass: 'profile-drag-chosen',
      dragClass: 'profile-drag-active',
      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        // Read the new order straight from the DOM and re-order the
        // deviceState.profiles array to match. This avoids the
        // "find the displaced target" trick — the DOM already
        // reflects the desired order.
        const orderedIds = Array.from(grid.children)
          .map((el) => Number(el.dataset?.profileIndex))
          .filter((n) => Number.isInteger(n));
        const profiles = deviceState?.profiles;
        if (!Array.isArray(profiles) || !profiles.length) return;
        const next = orderedIds.map((idx) =>
          profiles.find((p, fallback) => Number(p.index ?? fallback) === idx)
        );
        if (next.some((p) => !p)) return;
        commitDeviceProfileOrder(next, Number(evt.item?.dataset?.profileIndex));
      },
    });
    grid.__sortableProfileInstance = instance;
  }

  function applySavedProfileOrder(profiles) {
    const items = Array.isArray(profiles) ? profiles.slice() : [];
    let order = [];
    try {
      order = JSON.parse(localStorage.getItem(PROFILE_ORDER_KEY) || '[]');
    } catch {
      order = [];
    }
    if (!Array.isArray(order) || !order.length) return items;
    const rank = new Map(order.map((value, index) => [Number(value), index]));
    return items.sort((a, b) => {
      const aIndex = Number(a.index ?? items.indexOf(a));
      const bIndex = Number(b.index ?? items.indexOf(b));
      const aRank = rank.has(aIndex) ? rank.get(aIndex) : Number.MAX_SAFE_INTEGER;
      const bRank = rank.has(bIndex) ? rank.get(bIndex) : Number.MAX_SAFE_INTEGER;
      return aRank - bRank || aIndex - bIndex;
    });
  }

  function reorderProfiles(fromIndex, toIndex) {
    if (!deviceState || !Array.isArray(deviceState.profiles) || fromIndex === toIndex) return;
    const profiles = applySavedProfileOrder(deviceState.profiles);
    const fromPos = profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(fromIndex));
    const toPos = profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(toIndex));
    if (fromPos < 0 || toPos < 0) return;
    const [moved] = profiles.splice(fromPos, 1);
    profiles.splice(toPos, 0, moved);
    commitDeviceProfileOrder(profiles, fromIndex);
  }

  function profilePayloadForDevice(profile, index) {
    const vaporId = normalizeVaporPreset(profile);
    const vaporDi = vaporDynamicInhaleFor(vaporId);
    const payload = {
      index,
      name: profile.name || `Profile ${index}`,
      temp_f: Number(profile.temp_f),
      time_s: Number(profile.time_s),
      vapor: vaporId,
    };
    const mood = normalizeProfileMood(profile);
    if (mood) {
      // Vapor is the source of truth for dynamic inhale intensity,
      // matching saveProfile / copyLocalProfileToDevice: Bold /
      // Intense / Extreme force dynamic_inhale on with the matching
      // di_frac; Smooth preserves the mood editor's own flag.
      payload.mood_light = {
        preset: mood.sourcePreset || mood.preset,
        colors: mood.colors,
        tempo_frac: mood.tempoFrac ?? mood.tempo_frac ?? 0.5,
        dynamic_inhale: vaporDi.dynamic_inhale || (mood.dynamicInhale ?? mood.dynamic_inhale ?? false),
        di_frac: vaporDi.di_frac,
      };
    }
    return payload;
  }

  function commitDeviceProfileOrder(orderedProfiles, movedIndex) {
    const currentProfile = Number(deviceState?.current_profile);
    const selectedIndex = orderedProfiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === currentProfile);
    // Resolve each profile's vapor preset BEFORE remapping its slot
    // index. Raw device snapshot profiles carry no `vapor` field — the
    // user's Bold/Intense choice lives in the localStorage overrides,
    // keyed by the profile's ORIGINAL slot. The old code normalized the
    // raw profile (always 'standard'), then persisted that for every
    // slot — i.e. one drag-and-drop reset every profile to Smooth.
    // profileWithVapor() reads the override at the original index, so
    // the vapor choice now travels with its profile to the new slot.
    const nextProfiles = orderedProfiles.map((profile, slotIndex) => ({
      ...profileWithVapor(profile),
      index: slotIndex,
      active: slotIndex === selectedIndex,
    }));
    deviceState.profiles = nextProfiles;
    if (selectedIndex >= 0) deviceState.current_profile = selectedIndex;
    try {
      localStorage.removeItem(PROFILE_ORDER_KEY);
    } catch {}
    updateProfilesUI(deviceState.profiles, selectedIndex >= 0 ? selectedIndex : deviceState.current_profile);
    writeProfileVaporOverridesForProfiles(nextProfiles);
    const payload = {
      // Build the device payload from the vapor-resolved profiles so
      // the bridge writes the correct dynamic-inhale settings too.
      profiles: nextProfiles.map((profile, slotIndex) => profilePayloadForDevice(profile, slotIndex)),
      select_index: selectedIndex >= 0 ? selectedIndex : null,
    };
    if (send('reorder_profiles', payload)) {
      optimisticProfileIndex = selectedIndex >= 0 ? selectedIndex : null;
      toast(`Moving profile ${movedIndex} on device`, 'info');
    } else {
      toast('Profile order saved locally only', 'warn');
    }
  }

  function extractProfileColors(colorObj) {
    if (!colorObj) return ['#8b5cf6'];
    const bytesToColors = (raw, limit = 6) => {
      if (!raw) return [];
      const values = Array.isArray(raw)
        ? raw
        : (typeof Uint8Array !== 'undefined' && raw instanceof Uint8Array)
          ? Array.from(raw)
          : [];
      if (values.length < 3 || !values.every(value => Number.isFinite(Number(value)))) return [];
      const colors = [];
      for (let index = 0; index + 2 < values.length; index += 3) {
        const rgb = values.slice(index, index + 3).map(value => Math.max(0, Math.min(255, Number(value))));
        colors.push('#' + rgb.map(value => value.toString(16).padStart(2, '0')).join(''));
      }
      const unique = [...new Set(colors)];
      if (unique.length <= limit) return unique;
      const sampled = [];
      for (let index = 0; index < limit; index += 1) {
        sampled.push(unique[Math.round((index / Math.max(1, limit - 1)) * (unique.length - 1))]);
      }
      return [...new Set(sampled)];
    };
    const normalize = (raw) => {
      if (!raw) return null;
      if (typeof raw === 'string') {
        const direct = raw.match(/#[0-9a-fA-F]{6}/);
        if (direct) return direct[0].toLowerCase();
        const compact = raw.replace(/[^0-9a-fA-F]/g, '');
        if (compact.length >= 6) return `#${compact.slice(0, 6).toLowerCase()}`;
      }
      if (Array.isArray(raw)) {
        if (raw.length >= 3 && raw.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
          return bytesToColors(raw, 1)[0] || null;
        }
        for (const item of raw) {
          const color = normalize(item);
          if (color) return color;
        }
      }
      return null;
    };
    const collect = (raw) => {
      if (!raw) return [];
      if (typeof raw === 'string') {
        const color = normalize(raw);
        return color ? [color] : [];
      }
      if (Array.isArray(raw)) {
        if (raw.length >= 3 && raw.slice(0, 3).every(v => Number.isFinite(Number(v)))) {
          return bytesToColors(raw);
        }
        return raw.flatMap(item => collect(item));
      }
      return [];
    };
    // Navigate the nested color structure from the Puffco CBOR response
    try {
      const metaColors = collect(colorObj.meta?.userColors || colorObj.meta?.arrayColors);
      if (metaColors.length) return [...new Set(metaColors)];
      if (colorObj.lamp?.param?.color) {
        const paramColors = collect(colorObj.lamp.param.color);
        if (paramColors.length) return [...new Set(paramColors)];
      }
      // Try flat "color" key
      if (colorObj.color) {
        const flatColors = collect(colorObj.color);
        if (flatColors.length) return [...new Set(flatColors)];
      }
    } catch (e) {}
    return ['#8b5cf6'];
  }

  function extractProfileColor(colorObj) {
    return extractProfileColors(colorObj)[0] || '#8b5cf6';
  }

  function profileColorBackground(colors) {
    const unique = [...new Set((colors || []).filter(color => /^#[0-9a-f]{6}$/i.test(color)))];
    if (unique.length <= 1) return unique[0] || '#8b5cf6';
    const stops = unique.map((color, index) => {
      const start = Math.round((index / unique.length) * 100);
      const end = Math.round(((index + 1) / unique.length) * 100);
      return `${color} ${start}% ${end}%`;
    });
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  function formatProfileTemperature(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? `${Math.round(parsed)} F` : 'Temp not synced';
  }

  function formatProfileDuration(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? formatSecondsLabel(parsed) : 'Time not synced';
  }

  function normalizeVaporPreset(profileOrValue) {
    const raw = profileOrValue && typeof profileOrValue === 'object'
      ? profileOrValue.vapor ?? profileOrValue.vapor_preset ?? profileOrValue.xl_vapor ?? profileOrValue.vaporControl
      : profileOrValue;
    const value = String(raw ?? 'standard').trim().toLowerCase().replace(/[\s_-]+/g, '_');
    // Map common words and the new display labels onto the four preset
    // IDs. The order in VAPOR_PRESETS is the official progression —
    // Smooth → Bold → Intense → Extreme.
    const aliases = {
      // New display names
      smooth: 'standard',
      bold: 'high',
      intense: 'max',
      extreme: 'xl',
      // Old display names (kept so exported/imported backups still work)
      normal: 'standard',
      balanced: 'standard',
      default: 'standard',
      low: 'standard',
      more: 'high',
      boosted: 'high',
      high_vapor: 'high',
      maximum: 'max',
      max_vapor: 'max',
      full: 'max',
      xlarge: 'xl',
      '3d_xl': 'xl',
      xl_vapor: 'xl',
      // Common industry synonyms
      mild: 'standard',
      medium: 'high',
      strong: 'max',
      ultra: 'xl',
    };
    const id = aliases[value] || value;
    return VAPOR_PRESETS.some((preset) => preset.id === id) ? id : 'standard';
  }

  // Returns the dynamic-inhale payload the device should receive for a
  // given vapor preset. Smooth (standard) means "no draw modulation" —
  // dynamic_inhale stays false and the firmware uses the default power
  // curve. The other three set dynamic_inhale: true and supply a
  // fractional intensity (diFrac) between 0.33 and 1.0 that the
  // firmware maps to a more aggressive chamber response during a draw.
  // The intensity value is included in the mood light payload as
  // tempo_frac so the server's mood_light_payload picks it up via the
  // existing dynamic_inhale pathway. Callers that want the raw field
  // should use vaporIntensityFor() instead.
  function vaporDynamicInhaleFor(profileOrValue) {
    const id = normalizeVaporPreset(profileOrValue);
    const intensity = VAPOR_INTENSITY[id] ?? 0.0;
    if (intensity <= 0) {
      return { dynamic_inhale: false, di_frac: 0 };
    }
    return { dynamic_inhale: true, di_frac: Number(intensity.toFixed(2)) };
  }

  function vaporIntensityFor(profileOrValue) {
    const id = normalizeVaporPreset(profileOrValue);
    return VAPOR_INTENSITY[id] ?? 0.0;
  }

  function vaporPresetMeta(profileOrValue) {
    const id = normalizeVaporPreset(profileOrValue);
    return VAPOR_PRESETS.find((preset) => preset.id === id) || VAPOR_PRESETS[0];
  }

  function formatVaporPreset(profileOrValue, options = {}) {
    const preset = vaporPresetMeta(profileOrValue);
    return options.short ? preset.short : preset.name;
  }

  function extractProfileMood(colorObj) {
    const profileColors = extractProfileColors(colorObj);
    const fallbackColor = profileColors[0] || extractProfileColor(colorObj);
    const meta = colorObj?.meta || {};
    const preset = inferMoodPreset(colorObj);
    const presetName = MOOD_PRESETS.find(item => item.id === preset)?.name ?? 'Static color';
    const rawName = meta.moodName || meta.led3Name || presetName;
    const rawColors = Array.isArray(meta.userColors) ? meta.userColors : profileColors;
    const colors = rawColors
      .flatMap(color => extractProfileColors({ color }))
      .filter(color => /^#[0-9a-f]{6}$/i.test(color));
    return {
      preset: preset || 'no_animation',
      name: normalizeMoodDisplayName(rawName),
      colors: colors.length ? colors : [fallbackColor],
      tempoFrac: Number.isFinite(Number(meta.tempoFrac)) ? Math.max(0, Math.min(1, Number(meta.tempoFrac))) : 0.5,
      dynamicInhale: !!Number(meta.dynamicInhale || 0),
      sourcePreset: preset,
    };
  }

  function inferMoodPreset(colorObj) {
    const meta = colorObj?.meta || {};
    const lamp = colorObj?.lamp || {};
    const param = lamp?.param || {};
    const candidates = [
      meta.moodType,
      meta.led3Tag,
      meta.moodName,
      meta.led3Name,
      lamp.tag,
      lamp.name,
    ].map(value => String(value || '').trim().toLowerCase().replace(/-/g, '_'));
    for (const candidate of candidates) {
      const preset = MOOD_PRESETS.find(item => (
        candidate === item.id
        || candidate.includes(item.id)
        || candidate.includes(String(item.name).toLowerCase().replace(/[\s-]+/g, '_'))
      ));
      if (preset) return preset.id;
    }
    const offset = Array.isArray(param.offset) ? param.offset.map(value => Number(value)) : [];
    const offsetKey = offset.join(',');
    const colorCount = Number(param.colorLen) > 0 && Number(param.colorLen) !== 32
      ? Math.max(1, Math.round(Number(param.colorLen) / 5))
      : extractProfileColors(colorObj).length;
    if (Number(param.anim) === 7) return 'spin';
    if (Number(param.colorLen) === 32) return 'no_animation';
    if (offset.length) {
      if (offset.every(value => value === 0)) return 'fade';
      if (offsetKey === VERTICAL_SLIDESHOW_OFFSETS.join(',')) return 'vertical_slideshow';
      if (
        offsetKey === SPLIT_OFFSETS_2.join(',')
        || offsetKey === SPLIT_OFFSETS_3_4.join(',')
        || offsetKey === SPLIT_OFFSETS_5_6.join(',')
        || (offset.includes(7680) && offset.some(value => value >= 25600))
      ) return 'split_gradient';
      const expectedDisco = DISCO_BASE_OFFSETS.map(value => Math.round(value * Math.max(1, colorCount))).join(',');
      if (offsetKey === expectedDisco || offset[0] === 15360 || offset.includes(18773)) return 'disco';
    }
    if (lamp.name === 'pikaled2' || Array.isArray(param.color)) return 'no_animation';
    return null;
  }

  function normalizeMoodDisplayName(name) {
    return String(name || '').trim().toLowerCase() === 'no animation' ? 'Static color' : displayValue(name, 'Static color');
  }

  function isOfficialMoodPayload(colorObj) {
    const meta = colorObj?.meta || {};
    const lamp = colorObj?.lamp || {};
    const preset = inferMoodPreset(colorObj);
    return lamp.name === 'pikaled2'
      && MOOD_PRESETS.some(item => item.id === preset);
  }

  function profileMoodOrigin(colorObj) {
    const meta = colorObj?.meta || {};
    if (meta.format === 'official-pikaled2-profile-colr') {
      return { label: 'App-made', className: 'ok' };
    }
    if (isOfficialMoodPayload(colorObj)) {
      return { label: 'Puffco app', className: 'ok' };
    }
    return { label: 'Device', className: 'warn' };
  }

  function readJsonStorage(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      return value == null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    // QuotaExceededError (and Safari private-mode throws) can fire on
    // setItem. Silently drop the write — the next page load will simply
    // see the previous value, which is a sane fallback for settings.
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* ignore quota / private mode */ }
  }

  // ---- Vapor override device key (root cause of "everything says
  // Smooth") ----
  // Overrides used to be keyed by `serial || name || 'default-device'`
  // read live off the CURRENT snapshot. Fast status polls don't include
  // the serial, so the key oscillated between the serial (full
  // snapshot) and the device name (fast snapshot) — whichever bucket
  // didn't have your Bold/Intense entry rendered as Smooth. The key is
  // now STICKY: the first serial seen for the session is cached (and
  // persisted), and lookups fall back across every legacy bucket the
  // override may have been written under.
  const PROFILE_VAPOR_LAST_SERIAL_KEY = 'puffco_last_device_serial_v1';
  let cachedVaporDeviceSerial = (() => {
    try { return localStorage.getItem(PROFILE_VAPOR_LAST_SERIAL_KEY) || null; }
    catch { return null; }
  })();

  function profileVaporDeviceKey() {
    const liveSerial = deviceState?.serial ? String(deviceState.serial) : null;
    if (liveSerial && liveSerial !== cachedVaporDeviceSerial) {
      cachedVaporDeviceSerial = liveSerial;
      try { localStorage.setItem(PROFILE_VAPOR_LAST_SERIAL_KEY, liveSerial); } catch { /* ignore */ }
    }
    return String(liveSerial || cachedVaporDeviceSerial || deviceState?.name || 'default-device');
  }

  // Every storage bucket this device's overrides may historically live
  // under, most-authoritative first.
  function profileVaporKeyCandidates() {
    const keys = [];
    const push = (k) => { if (k && !keys.includes(String(k))) keys.push(String(k)); };
    push(deviceState?.serial);
    push(cachedVaporDeviceSerial);
    push(deviceState?.name);
    push('default-device');
    return keys;
  }

  function readProfileVaporOverrides() {
    const payload = readJsonStorage(PROFILE_VAPOR_KEY, { version: 1, devices: {} });
    return payload && typeof payload === 'object' && payload.devices && typeof payload.devices === 'object'
      ? payload
      : { version: 1, devices: {} };
  }

  // Merged per-slot override map for the current device: legacy buckets
  // first, the sticky-key bucket last so it wins per-slot conflicts.
  function readMergedVaporOverridesForDevice() {
    const payload = readProfileVaporOverrides();
    const candidates = profileVaporKeyCandidates();
    const merged = {};
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const bucket = payload.devices?.[candidates[i]];
      if (bucket && typeof bucket === 'object') Object.assign(merged, bucket);
    }
    const primary = payload.devices?.[profileVaporDeviceKey()];
    if (primary && typeof primary === 'object') Object.assign(merged, primary);
    return merged;
  }

  function writeProfileVaporOverride(index, vapor) {
    if (!Number.isFinite(Number(index))) return;
    const payload = readProfileVaporOverrides();
    const deviceKey = profileVaporDeviceKey();
    const device = { ...(payload.devices[deviceKey] || {}) };
    device[String(Number(index))] = normalizeVaporPreset(vapor);
    payload.devices = { ...payload.devices, [deviceKey]: device };
    payload.updated_at = new Date().toISOString();
    writeJsonStorage(PROFILE_VAPOR_KEY, payload);
  }

  function writeProfileVaporOverridesForProfiles(profiles) {
    if (!Array.isArray(profiles)) return;
    profiles.forEach((profile, fallbackIndex) => {
      const index = Number(profile?.index ?? fallbackIndex);
      writeProfileVaporOverride(index, normalizeVaporPreset(profile));
    });
  }

  // Resolve the vapor preset for a profile, layering in the per-slot
  // localStorage override. Override priority is critical here:
  //
  //   * The server (and `readProfiles` in the BLE client) decode the
  //     vapor from the device's mood-light payload — the di_frac +
  //     dynamicInhale pair. The decoding is best-effort: when the
  //     device's payload is in a state the bridge can't translate
  //     (e.g. dynamicInhale is False but the user previously set Bold,
  //     or the di_frac is missing), the server returns
  //     profile.vapor = "standard" for every slot. Without an
  //     override, every profile in the UI reads Smooth.
  //
  //   * The localStorage override is the USER'S choice, written the
  //     moment the user picks Bold / Intense / Extreme in the profile
  //     editor. The server's "standard" is the device's *current*
  //     decoding of the mood-light payload, which can lag or be wrong.
  //
  //   The old logic used `??` to fall through the profile fields to
  //   the override, but `??` only falls through on null/undefined —
  //   "standard" from the server is a real value and shadowed the
  //   override completely. So every profile read as Smooth regardless
  //   of the user's saved preference.
  //
  //   The fix: when the override for this slot is set AND differs
  //   from the server's "standard" fallback, the override wins. If
  //   the override matches "standard" or is unset, fall through to
  //   the server's value (so a profile the user has never touched
  //   still displays the device's actual current setting).
  function profileWithVapor(profile, fallbackIndex = null) {
    if (!profile || typeof profile !== 'object') return profile;
    const index = Number(profile.index ?? fallbackIndex);
    const device = readMergedVaporOverridesForDevice();
    const override = Number.isFinite(index) ? device[String(index)] : null;
    const serverVapor = profile.vapor ?? profile.vapor_preset ?? profile.xl_vapor ?? null;
    // Override wins when the user has explicitly set a non-default
    // value. Default override values are skipped so the server's
    // current reading can still flow through.
    const effective = (override && override !== 'standard')
      ? override
      : (serverVapor ?? override ?? 'standard');
    return { ...profile, vapor: normalizeVaporPreset(effective) };
  }

  function validateProfile(profile) {
    if (!profile || typeof profile !== 'object') return { ok: false, reason: 'Profile is not an object' };
    const temp = Number(profile.temp_f);
    const time = Number(profile.time_s);
    if (!profile.name && profile.name !== '') return { ok: false, reason: 'Profile name is missing' };
    if (!Number.isFinite(temp) || temp < 250 || temp > 700) return { ok: false, reason: 'Temperature must be 250-700 F' };
    if (!Number.isFinite(time) || time < 5 || time > 300) return { ok: false, reason: 'Duration must be 5-300 seconds' };
    return { ok: true };
  }

  function normalizeProfileMood(profile) {
    const source = profile?.mood || (profile?.color ? extractProfileMood(profile.color) : null);
    if (!source) return null;
    const colors = (Array.isArray(source.colors) ? source.colors : [])
      .flatMap(color => extractProfileColors({ color }))
      .filter(color => /^#[0-9a-f]{6}$/i.test(color));
    const devicePreset = source.preset || 'no_animation';
    const displayPreset = source.appPreset || source.sourcePreset || devicePreset;
    const tempo = Number(source.tempoFrac ?? source.tempo_frac);
    const tempoFrac = Number.isFinite(tempo) ? Math.max(0, Math.min(1, tempo)) : 0.5;
    const dynamicInhale = Boolean(source.dynamicInhale ?? source.dynamic_inhale);
    const presetName = MOOD_PRESETS.find(item => item.id === displayPreset)?.name || source.name || 'Static color';
    return {
      preset: displayPreset,
      name: normalizeMoodDisplayName(presetName),
      colors: colors.length ? [...new Set(colors)] : ['#ff0000'],
      tempoFrac,
      tempo_frac: tempoFrac,
      dynamicInhale,
      dynamic_inhale: dynamicInhale,
      appPreset: displayPreset,
      sourcePreset: devicePreset,
    };
  }

  function profileForStorage(profile, source = 'device') {
    const mood = normalizeProfileMood(profile);
    return {
      id: profile.id || `${source}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      source,
      archived: Boolean(profile.archived),
      index: Number.isFinite(Number(profile.index)) ? Number(profile.index) : null,
      name: profile.name || 'Profile',
      temp_f: Number(profile.temp_f),
      time_s: Number(profile.time_s),
      boost_temperature_delta_f: profile.boost_temperature_delta_f ?? deviceState?.boost_temperature_delta_f ?? null,
      boost_time_s: profile.boost_time_s ?? deviceState?.boost_time_s ?? null,
      vapor: normalizeVaporPreset(profile),
      chamber: profile.chamber ?? deviceState?.chamber ?? null,
      color: profile.color || null,
      mood,
      saved_at: new Date().toISOString(),
    };
  }

  function readProfileLibrary() {
    const payload = readJsonStorage(LOCAL_PROFILES_KEY, { version: 1, profiles: [] });
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [];
    return { version: Number(payload?.version) || 1, profiles };
  }

  function writeProfileLibrary(profiles) {
    writeJsonStorage(LOCAL_PROFILES_KEY, {
      version: 1,
      updated_at: new Date().toISOString(),
      profiles,
    });
  }

  function saveProfileBackup(reason = 'manual') {
    const profiles = Array.isArray(deviceState?.profiles)
      ? applySavedProfileOrder(deviceState.profiles).map((profile, fallbackIndex) => profileWithVapor(profile, fallbackIndex))
      : [];
    if (!profiles.length) return null;
    const backups = readJsonStorage(PROFILE_BACKUP_KEY, []);
    const snapshot = {
      version: 1,
      reason,
      saved_at: new Date().toISOString(),
      device: { name: deviceState?.name || null, serial: deviceState?.serial || null },
      current_profile: deviceState?.current_profile ?? null,
      profiles,
    };
    backups.unshift(snapshot);
    writeJsonStorage(PROFILE_BACKUP_KEY, backups.slice(0, 10));
    return snapshot;
  }

  function saveDeviceProfileToLibrary(index) {
    const profile = findProfile(index);
    if (!profile) { toast('Profile not found', 'error'); return; }
    const stored = profileForStorage(profile, 'device');
    const validation = validateProfile(stored);
    if (!validation.ok) {
      toast(validation.reason, 'error');
      return;
    }
    const library = readProfileLibrary().profiles;
    library.unshift(stored);
    writeProfileLibrary(library);
    renderProfileLibrary();
    toast('Profile saved to local library', 'success');
  }

  function renderProfileLibrary() {
    const grid = document.getElementById('profile-library-grid');
    if (!grid) return;
    const library = readProfileLibrary().profiles;
    const visible = library.filter((profile) => !profile.archived);
    if (!visible.length) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = visible.map((profile) => {
      const mood = normalizeProfileMood(profile);
      const colors = mood?.colors?.length ? mood.colors : extractProfileColors(profile.color);
      const color = extractProfileColor({ color: colors[0] });
      const background = profileColorBackground(colors);
      const moodName = mood?.name || mood?.preset || 'Static color';
      const vaporLabel = formatVaporPreset(profile, { short: true });
      return `
        <div class="profile-card local-profile-card" data-local-profile-id="${escAttr(profile.id)}" draggable="true" style="--profile-color:${escAttr(color)}">
          <div class="profile-name">
            <span class="active-indicator"></span>
            <span class="profile-drag-handle" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
            <span>${escHtml(profile.name || 'Local profile')}</span>
            <div class="profile-color-swatch" style="background:${escAttr(background)};margin-left:auto;"></div>
          </div>
          <div class="profile-meta">
            <span>${escHtml(formatProfileTemperature(profile.temp_f))}</span>
            <span>${escHtml(formatProfileDuration(profile.time_s))}</span>
            <span>${escHtml(vaporLabel)}</span>
            <span>${escHtml(moodName)}</span>
            <span class="profile-sync-badge warn">Local</span>
          </div>
          <div class="profile-actions">
            <button class="btn btn-sm btn-secondary" data-action="copy" data-profile-id="${escAttr(profile.id)}">Copy to Slot</button>
            <button class="btn btn-sm btn-secondary" data-action="archive" data-profile-id="${escAttr(profile.id)}">Archive</button>
          </div>
        </div>
      `;
    }).join('');
    bindProfileLibraryCards(grid);
  }

  function bindProfileLibraryCards(grid) {
    grid.querySelectorAll('.local-profile-card').forEach((card) => {
      card.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (button) {
          const id = button.dataset.profileId;
          if (button.dataset.action === 'copy') copyLocalProfileToDevice(id);
          if (button.dataset.action === 'archive') archiveLocalProfile(id);
          return;
        }
        editLocalProfile(card.dataset.localProfileId);
      });
    });
    wireProfileLibrarySortable(grid);
  }

  // Wire Sortable on the local-profile-library grid. Idempotent.
  function wireProfileLibrarySortable(grid) {
    if (!grid || typeof Sortable === 'undefined') return;
    if (grid.__sortableLibraryInstance) return;
    const instance = Sortable.create(grid, {
      animation: 180,
      draggable: '.local-profile-card',
      handle: '.profile-drag-handle, .local-profile-card',
      filter: 'button, input, .profile-actions',
      preventOnFilter: true,
      ghostClass: 'profile-drag-ghost',
      chosenClass: 'profile-drag-chosen',
      dragClass: 'profile-drag-active',
      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const fromId = evt.item?.dataset?.localProfileId;
        // The "to" id is the id of the card now at the newIndex-1
        // (or newIndex+1 if moved up) — i.e. the displaced card.
        const movedDown = evt.newIndex > evt.oldIndex;
        const neighbor = movedDown ? evt.newIndex - 1 : evt.newIndex + 1;
        const neighborEl = grid.children[neighbor];
        const toId = neighborEl?.dataset?.localProfileId;
        if (fromId && toId) reorderLocalProfiles(fromId, toId);
      },
    });
    grid.__sortableLibraryInstance = instance;
  }

  function reorderLocalProfiles(fromId, toId) {
    if (!fromId || !toId || fromId === toId) return;
    const library = readProfileLibrary().profiles;
    const fromIndex = library.findIndex((profile) => profile.id === fromId);
    if (fromIndex < 0) return;
    const [moved] = library.splice(fromIndex, 1);
    const toIndex = library.findIndex((profile) => profile.id === toId);
    if (toIndex < 0) return;
    library.splice(toIndex, 0, moved);
    writeProfileLibrary(library);
    renderProfileLibrary();
  }

  function duplicateLocalProfile(id) {
    const library = readProfileLibrary().profiles;
    const source = library.find((profile) => profile.id === id);
    if (!source) return;
    library.unshift({ ...source, id: `local-${Date.now()}`, name: `${source.name || 'Profile'} Copy`, archived: false, saved_at: new Date().toISOString() });
    writeProfileLibrary(library);
    renderProfileLibrary();
  }

  function archiveLocalProfile(id) {
    if (!confirm('Archive this profile? It will be hidden from the library.')) return;
    const library = readProfileLibrary().profiles.map((profile) => (
      profile.id === id ? { ...profile, archived: true, archived_at: new Date().toISOString() } : profile
    ));
    writeProfileLibrary(library);
    renderProfileLibrary();
    toast('Profile archived', 'info');
  }

  function addNewProfile() {
    const profile = profileForStorage({
      id: `local-${Date.now()}`,
      source: 'local',
      name: 'New Profile',
      temp_f: 520,
      time_s: 60,
      vapor: 'standard',
      mood: {
        preset: 'no_animation',
        name: 'Static color',
        colors: ['#ff0000'],
        tempoFrac: 0.5,
        dynamicInhale: false,
        sourcePreset: 'no_animation',
      },
    }, 'local');
    const library = readProfileLibrary().profiles;
    library.unshift(profile);
    writeProfileLibrary(library);
    renderProfileLibrary();
    editLocalProfile(profile.id);
    toast('New local profile created', 'success');
  }

  function editLocalProfile(id) {
    const profile = readProfileLibrary().profiles.find((item) => item.id === id);
    if (!profile) return;
    editingProfileIndex = null;
    editingLocalProfileId = id;
    const modal = document.getElementById('profile-modal');
    modal?.classList.add('local-profile-edit');
    document.getElementById('modal-kicker').textContent = 'Local profile';
    document.getElementById('modal-name').value = profile.name || '';
    document.getElementById('modal-temp').value = profile.temp_f ?? '';
    document.getElementById('modal-time').value = profile.time_s ?? '';
    document.getElementById('modal-vapor').value = normalizeVaporPreset(profile);
    document.getElementById('modal-index').value = '';

    const mood = normalizeProfileMood(profile) || extractProfileMood(profile.color);
    moodEditor.preset = mood.preset || 'no_animation';
    moodEditor.colors = mood.colors?.length ? mood.colors.slice() : ['#ff0000'];
    moodEditor.tempoFrac = Number.isFinite(Number(mood.tempoFrac)) ? Number(mood.tempoFrac) : 0.5;
    moodEditor.dynamicInhale = Boolean(mood.dynamicInhale);
    syncPickerToMoodColor();
    renderMoodControls();
    renderVaporControls();
    renderModalSummary();
    syncProfileDialSliders();
    populateProfileReadback(profile);
    clearProfileReadbackState();
    document.getElementById('modal-select').checked = false;

    modal?.classList.add('visible');
  }

  function resetCurrentProfile() {
    if (editingLocalProfileId) {
      const profile = readProfileLibrary().profiles.find((item) => item.id === editingLocalProfileId);
      if (profile) editLocalProfile(profile.id);
      return;
    }
    if (editingProfileIndex != null) {
      editProfile(editingProfileIndex);
      return;
    }
    document.getElementById('modal-name').value = 'New Profile';
    document.getElementById('modal-temp').value = '520';
    document.getElementById('modal-time').value = '60';
    document.getElementById('modal-vapor').value = 'standard';
    setMoodPreset('no_animation');
    renderVaporControls();
    renderModalSummary();
    syncProfileDialSliders();
    clearProfileReadbackState();
    clearProfileDialValidity();
  }

  function deleteCurrentProfile() {
    if (editingLocalProfileId) {
      const id = editingLocalProfileId;
      archiveLocalProfile(id);
      closeModal();
      toast('Local profile archived', 'success');
      return;
    }
    if (editingProfileIndex == null) return;
    const index = Number(editingProfileIndex);
    saveProfileBackup('before_reset_profile_slot');
    writeProfileVaporOverride(index, 'standard');
    send('set_profile', {
      index,
      name: `Profile ${index}`,
      temp_f: 520,
      time_s: 60,
      vapor: 'standard',
      mood_light: {
        preset: 'no_animation',
        colors: ['#ff0000'],
        tempo_frac: 0.5,
        dynamic_inhale: false,
      },
    });
    closeModal();
    toast('Profile slot reset', 'success');
  }

  function saveLocalProfileFromModal() {
    const library = readProfileLibrary().profiles;
    const index = library.findIndex((profile) => profile.id === editingLocalProfileId);
    if (index < 0) return;
    const name = document.getElementById('modal-name').value.trim() || 'Local profile';
    const temp = parseFloat(document.getElementById('modal-temp').value);
    const time = parseFloat(document.getElementById('modal-time').value);
    const vapor = normalizeVaporPreset(document.getElementById('modal-vapor')?.value);
    const vaporDi = vaporDynamicInhaleFor(vapor);
    const mood = moodParams();
    if (!mood) return;
    // Merge vapor into the mood payload so the stored profile carries
    // both the user's mood setting and the vapor choice. When vapor
    // is Smooth (standard) we keep whatever dynamic_inhale the mood
    // editor had set. When vapor is Bold/Intense/Extreme, vapor wins.
    const mergedMood = {
      ...mood,
      dynamic_inhale: vaporDi.dynamic_inhale || Boolean(mood.dynamic_inhale),
      di_frac: vaporDi.di_frac,
    };
    const profile = {
      ...library[index],
      name,
      temp_f: temp,
      time_s: time,
      vapor,
      color: null,
      mood: normalizeProfileMood({ mood: mergedMood }),
      saved_at: new Date().toISOString(),
    };
    const validation = validateProfile(profile);
    if (!validation.ok) {
      toast(validation.reason, 'error');
      return;
    }
    library[index] = profile;
    writeProfileLibrary(library);
    renderProfileLibrary();
    closeModal();
    toast('Local profile updated', 'success');
  }

  function copyLocalProfileToDevice(id) {
    const library = readProfileLibrary().profiles;
    const profile = library.find((item) => item.id === id);
    if (!profile) return;
    const validation = validateProfile(profile);
    if (!validation.ok) {
      toast(validation.reason, 'error');
      return;
    }
    const slot = prompt('Copy to device slot 0-3', String(deviceState?.current_profile ?? 0));
    if (slot == null) return;
    const index = Number(slot);
    if (!Number.isInteger(index) || index < 0 || index > 3) {
      toast('Device slot must be 0-3', 'error');
      return;
    }
    saveProfileBackup('before_copy_local_to_device');
    const vaporId = normalizeVaporPreset(profile);
    const vaporDi = vaporDynamicInhaleFor(vaporId);
    const params = {
      index,
      name: profile.name,
      temp_f: Number(profile.temp_f),
      time_s: Number(profile.time_s),
      vapor: vaporId,
    };
    const mood = normalizeProfileMood(profile);
    if (mood) {
      // Vapor is the source of truth for dynamic inhale intensity.
      // Smooth turns it off, Bold/Intense/Extreme turn it on with the
      // matching diFrac. We OR-merge with the mood editor's flag so a
      // user-set dynamic inhale checkbox is preserved when vapor is
      // Smooth (e.g. a profile that wants pulsing lights but Smooth
      // power).
      const useVapor = vaporDi.dynamic_inhale
        || (mood.dynamicInhale ?? mood.dynamic_inhale ?? false);
      params.mood_light = {
        preset: mood.sourcePreset || mood.preset,
        colors: mood.colors,
        tempo_frac: mood.tempoFrac ?? mood.tempo_frac ?? 0.5,
        dynamic_inhale: useVapor,
        di_frac: vaporDi.di_frac,
      };
    } else if (vaporDi.dynamic_inhale) {
      // No mood editor on the profile but the vapor setting wants
      // dynamic inhale — send a no_animation mood light payload with
      // the matching diFrac. The firmware's profile-colour write is
      // what actually stores the dynamicInhale flag.
      params.mood_light = {
        preset: 'no_animation',
        colors: ['#ff0000'],
        tempo_frac: 0.5,
        dynamic_inhale: true,
        di_frac: vaporDi.di_frac,
      };
    }
    writeProfileVaporOverride(index, params.vapor);
    send('set_profile', params);
    toast(`Profile copied with ${vaporPresetMeta(vaporId).name} vapor`, 'info');
  }

  function restoreProfileBackup() {
    const backups = readJsonStorage(PROFILE_BACKUP_KEY, []);
    const latest = Array.isArray(backups) ? backups[0] : null;
    if (!latest?.profiles?.length) {
      toast('No profile backup available', 'warn');
      return;
    }
    writeProfileLibrary(latest.profiles.map((profile) => profileForStorage(profile, 'backup')));
    renderProfileLibrary();
    toast('Backup restored into local library', 'success');
  }

  function restoreDefaultProfiles() {
    if (!confirm('Reset profile order to device defaults?')) return;
    try {
      localStorage.removeItem(PROFILE_ORDER_KEY);
    } catch {}
    if (deviceState?.profiles) updateProfilesUI(deviceState.profiles, deviceState.current_profile);
    toast('Profile order reset', 'success');
  }

  // ---- Color Controls ----

  function initColorControls() {
    const wheel = document.getElementById('color-wheel');
    const hexInput = document.getElementById('hex-input');
    const preview = document.getElementById('color-preview');

    if (!wheel || !hexInput || !preview) return;

    wheel.addEventListener('input', () => {
      const val = wheel.value;
      hexInput.value = val.toUpperCase();
      setMoodPreview(val);
      moodEditor.colors[0] = val.toLowerCase();
      renderMoodColors();
      renderModalSummary();
    });

    hexInput.addEventListener('input', () => {
      let val = hexInput.value.trim();
      if (!val.startsWith('#')) val = '#' + val;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        wheel.value = val;
        setMoodPreview(val);
        moodEditor.colors[0] = val.toLowerCase();
        renderMoodColors();
        renderModalSummary();
      }
    });

    // Preset swatches
    const swatchContainer = document.getElementById('color-swatches');
    PRESETS.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      swatch.style.background = color;
      swatch.style.setProperty('--swatch-color', color);
      swatch.title = color;
      swatch.onclick = () => {
        wheel.value = color;
        hexInput.value = color.toUpperCase();
        setMoodPreview(color);
        moodEditor.colors[0] = color.toLowerCase();
        renderMoodColors();
        renderModalSummary();
        // Highlight active swatch
        swatchContainer.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
      };
      swatchContainer.appendChild(swatch);
    });

    // Modal color sync
    const modalColor = document.getElementById('modal-color');
    const modalSwatch = document.getElementById('modal-color-swatch');
    if (modalColor) {
      modalColor.addEventListener('input', () => {
        const value = modalColor.value.toLowerCase();
        if (wheel) wheel.value = value;
        if (hexInput) hexInput.value = value.toUpperCase();
        if (modalSwatch) modalSwatch.textContent = value.toUpperCase();
        setMoodPreview(value);
        moodEditor.colors[0] = value;
        renderMoodColors();
        renderModalSummary();
      });
    }

    initMoodControls();
  }

  function getCurrentColor() {
    const hexInput = document.getElementById('hex-input');
    let val = hexInput.value.trim();
    if (!val.startsWith('#')) val = '#' + val;
    if (!/^#[0-9a-fA-F]{6}$/.test(val)) {
      toast('Invalid hex color. Use format #RRGGBB', 'error');
      return null;
    }
    return val;
  }

  function activeMoodPreset() {
    return [...MOOD_PRESETS, ...localMoodPresets].find(preset => preset.id === moodEditor.preset) || MOOD_PRESETS[0];
  }

  function setMoodPreview(color) {
    const preview = document.getElementById('color-preview');
    const modalPreview = document.getElementById('modal-color-preview');
    const hero = document.querySelector('.profile-editor-hero');
    [preview, modalPreview].forEach((el) => {
      if (!el) return;
      el.style.background = color;
      el.style.setProperty('--preview-glow', color + '60');
    });
    if (hero) hero.style.setProperty('--preview-glow', color + '60');
  }

  function setMoodPreset(id) {
    const preset = MOOD_PRESETS.find(item => item.id === id) || MOOD_PRESETS[0];
    const custom = localMoodPresets.find(item => item.id === id);
    const selected = custom || preset;
    moodEditor.preset = selected.id;
    moodEditor.colors = selected.colors.slice();
    moodEditor.dynamicInhale = Boolean(selected.dynamicInhale);
    moodEditor.tempoFrac = Number.isFinite(Number(selected.tempoFrac)) ? Number(selected.tempoFrac) : 0.5;
    if (!selected.tempo) moodEditor.tempoFrac = 0.5;
    const nameInput = document.getElementById('mood-name');
    if (nameInput) nameInput.value = selected.local ? selected.name : '';
    syncPickerToMoodColor();
    renderMoodControls();
    renderModalSummary();
  }

  function syncPickerToMoodColor() {
    const color = moodEditor.colors[0] || '#ff0000';
    const wheel = document.getElementById('color-wheel');
    const hexInput = document.getElementById('hex-input');
    const modalColor = document.getElementById('modal-color');
    const modalSwatch = document.getElementById('modal-color-swatch');
    if (wheel) wheel.value = color;
    if (hexInput) hexInput.value = color.toUpperCase();
    if (modalColor) modalColor.value = color;
    if (modalSwatch) modalSwatch.textContent = color.toUpperCase();
    setMoodPreview(color);
  }

  function initMoodControls() {
    const tempo = document.getElementById('mood-tempo');
    const dynamic = document.getElementById('mood-dynamic');
    ['modal-temp', 'modal-time', 'modal-vapor'].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener(id === 'modal-vapor' ? 'change' : 'input', () => {
        if (id === 'modal-vapor') renderVaporControls();
        renderModalSummary();
      });
    });
    if (tempo) {
      tempo.addEventListener('input', () => {
        moodEditor.tempoFrac = Number(tempo.value) / 100;
        renderMoodTempo();
        renderModalSummary();
      });
    }
    if (dynamic) {
      dynamic.addEventListener('change', () => {
        moodEditor.dynamicInhale = dynamic.checked;
        renderModalSummary();
      });
    }
    renderMoodControls();
  }

  function renderMoodControls() {
    const presetWrap = document.getElementById('mood-presets');
    if (presetWrap) {
      presetWrap.innerHTML = '';
      [...MOOD_PRESETS, ...localMoodPresets].forEach(preset => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mood-preset' + (preset.id === moodEditor.preset ? ' active' : '');
        btn.innerHTML = `<strong>${escHtml(preset.name)}</strong><span>${escHtml(preset.local ? 'Local mood' : preset.desc)}</span>`;
        btn.onclick = () => setMoodPreset(preset.id);
        presetWrap.appendChild(btn);
      });
    }
    renderMoodColors();
    renderMoodTempo();
  }

  function renderMoodColors() {
    const preset = activeMoodPreset();
    const wrap = document.getElementById('mood-colors');
    if (!wrap) return;
    wrap.innerHTML = '';
    moodEditor.colors.forEach((color, index) => {
      const slot = document.createElement('div');
      slot.className = 'mood-color-slot';
      slot.draggable = true;
      slot.dataset.colorIndex = String(index);
      slot.innerHTML = `
        <span class="mood-drag-handle" title="Drag to reorder" aria-hidden="true">⋮</span>
        <span>${index + 1}</span>
        <input type="color" value="${escHtml(color)}" aria-label="Mood color ${index + 1}" />
        <input type="text" class="hex-input" value="${escHtml(color.toUpperCase())}" maxlength="7" />
        <button class="icon-btn mood-remove" title="Remove color" ${moodEditor.colors.length <= preset.min ? 'disabled' : ''}>×</button>
      `;
      const colorInput = slot.querySelector('input[type="color"]');
      const textInput = slot.querySelector('input[type="text"]');
      const removeBtn = slot.querySelector('button.mood-remove');
      const update = (value) => {
        let next = value.trim();
        if (!next.startsWith('#')) next = '#' + next;
        if (!/^#[0-9a-fA-F]{6}$/.test(next)) return;
        next = next.toLowerCase();
        moodEditor.colors[index] = next;
        colorInput.value = next;
        textInput.value = next.toUpperCase();
        if (index === 0) syncPickerToMoodColor();
        renderModalSummary();
      };
      colorInput.addEventListener('input', () => update(colorInput.value));
      textInput.addEventListener('input', () => update(textInput.value));
      removeBtn.addEventListener('click', () => {
        if (moodEditor.colors.length <= preset.min) return;
        moodEditor.colors.splice(index, 1);
        renderMoodColors();
        renderModalSummary();
      });
      wrap.appendChild(slot);
    });
    wireMoodColorsSortable(wrap);
    const add = document.getElementById('mood-add-color');
    if (add) {
      add.disabled = moodEditor.colors.length >= preset.max;
      add.textContent = `Add color (${moodEditor.colors.length}/${preset.max})`;
    }
    const range = document.getElementById('mood-color-range');
    if (range) range.textContent = `${preset.min}-${preset.max} colors`;
  }

  // Wire Sortable on the mood-colors wrap. Idempotent. The reorder
  // uses the newIndex directly so we can splice the colors array in
  // a single shot and re-render to refresh the color values.
  function wireMoodColorsSortable(wrap) {
    if (!wrap || typeof Sortable === 'undefined') return;
    if (wrap.__sortableMoodInstance) return;
    const instance = Sortable.create(wrap, {
      animation: 160,
      draggable: '.mood-color-slot',
      handle: '.mood-drag-handle, .mood-color-slot',
      filter: 'input, button, .mood-remove',
      preventOnFilter: true,
      ghostClass: 'mood-drag-ghost',
      chosenClass: 'mood-drag-chosen',
      dragClass: 'mood-drag-active',
      onEnd(evt) {
        const from = evt.oldIndex;
        const to = evt.newIndex;
        if (from === to) return;
        if (from < 0 || to < 0) return;
        if (from >= moodEditor.colors.length || to >= moodEditor.colors.length) return;
        const [moved] = moodEditor.colors.splice(from, 1);
        moodEditor.colors.splice(to, 0, moved);
        syncPickerToMoodColor();
        renderMoodColors();
        renderModalSummary();
      },
    });
    wrap.__sortableMoodInstance = instance;
  }

  function renderMoodTempo() {
    const preset = activeMoodPreset();
    const tempoWrap = document.getElementById('mood-tempo-wrap');
    const tempo = document.getElementById('mood-tempo');
    const tempoValue = document.getElementById('mood-tempo-value');
    const dynamic = document.getElementById('mood-dynamic');
    if (tempoWrap) tempoWrap.hidden = !preset.tempo;
    if (tempo) tempo.value = String(Math.round(moodEditor.tempoFrac * 100));
    if (tempoValue) tempoValue.textContent = `${Math.round(moodEditor.tempoFrac * 100)}%`;
    if (dynamic) dynamic.checked = moodEditor.dynamicInhale;
  }

  function addMoodColor() {
    const preset = activeMoodPreset();
    if (moodEditor.colors.length >= preset.max) return;
    moodEditor.colors.push(moodEditor.colors[moodEditor.colors.length - 1] || preset.colors[0]);
    renderMoodColors();
    renderModalSummary();
  }

  function moodParams(extra = {}) {
    const preset = activeMoodPreset();
    if (moodEditor.colors.length < preset.min || moodEditor.colors.length > preset.max) {
      toast(`${preset.name} needs ${preset.min}-${preset.max} color(s)`, 'error');
      return null;
    }
    return {
      preset: preset.sourcePreset || moodEditor.preset,
      appPreset: moodEditor.preset,
      name: preset.name,
      colors: moodEditor.colors.slice(),
      tempo_frac: moodEditor.tempoFrac,
      dynamic_inhale: moodEditor.dynamicInhale,
      ...extra,
    };
  }

  function validateMoodPreset(preset) {
    if (!preset || typeof preset !== 'object') return { ok: false, reason: 'Mood is not an object' };
    if (!preset.name || typeof preset.name !== 'string') return { ok: false, reason: 'Mood name is required' };
    const colors = Array.isArray(preset.colors) ? preset.colors : [];
    if (colors.length < 1 || colors.length > 6) return { ok: false, reason: 'Mood needs 1-6 colors' };
    if (!colors.every((color) => /^#[0-9a-f]{6}$/i.test(String(color)))) return { ok: false, reason: 'Mood colors must use #RRGGBB' };
    return { ok: true };
  }

  function readMoodLibrary() {
    const payload = readJsonStorage(MOOD_LIBRARY_KEY, { version: 1, moods: [] });
    return Array.isArray(payload?.moods) ? payload.moods : [];
  }

  function writeMoodLibrary(moods) {
    writeJsonStorage(MOOD_LIBRARY_KEY, {
      version: 1,
      updated_at: new Date().toISOString(),
      moods,
    });
    localMoodPresets = moods;
  }

  function currentMoodPresetPayload(nameOverride = '') {
    const base = activeMoodPreset();
    const name = String(nameOverride || document.getElementById('mood-name')?.value || base.name || 'Mood').trim();
    return {
      id: base.local ? base.id : `local-mood-${Date.now()}`,
      local: true,
      name,
      desc: 'Local mood',
      min: Math.max(1, Math.min(6, Number(base.min) || 1)),
      max: Math.max(1, Math.min(6, Number(base.max) || 6)),
      colors: moodEditor.colors.slice(),
      tempo: Boolean(base.tempo),
      tempoFrac: moodEditor.tempoFrac,
      dynamicInhale: moodEditor.dynamicInhale,
      sourcePreset: base.local ? base.sourcePreset : base.id,
      saved_at: new Date().toISOString(),
    };
  }

  function saveMoodPreset() {
    const preset = currentMoodPresetPayload();
    const validation = validateMoodPreset(preset);
    if (!validation.ok) {
      toast(validation.reason, 'error');
      return;
    }
    const moods = readMoodLibrary();
    const index = moods.findIndex((item) => item.id === preset.id);
    if (index >= 0) moods[index] = preset;
    else moods.unshift(preset);
    writeMoodLibrary(moods);
    localMoodPresets = moods;
    moodEditor.preset = preset.id;
    renderMoodControls();
    toast('Mood saved locally', 'success');
  }

  function deleteMoodPreset() {
    if (deleteMoodPreset._inFlight) return;
    deleteMoodPreset._inFlight = true;
    setTimeout(() => { deleteMoodPreset._inFlight = false; }, 500);
    const active = activeMoodPreset();
    if (!active.local) {
      toast('Built-in moods cannot be deleted', 'warn');
      return;
    }
    writeMoodLibrary(readMoodLibrary().filter((item) => item.id !== active.id));
    moodEditor.preset = 'no_animation';
    syncPickerToMoodColor();
    renderMoodControls();
    toast('Mood deleted', 'success');
  }

  function exportMoods() {
    try {
      const moods = readMoodLibrary();
      const payload = { version: 1, exported_at: new Date().toISOString(), moods };
      const blob = new Blob([safeJsonStringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `puffco-moods-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast('Moods exported', 'success');
    } catch (err) {
      toast('Mood export failed', 'error');
    }
  }

  function openMoodImport() {
    document.getElementById('mood-import-file')?.click();
  }

  async function importMoodFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const incoming = Array.isArray(payload?.moods) ? payload.moods : Array.isArray(payload) ? payload : [];
      const normalized = incoming.map((item, index) => ({
        ...item,
        id: item.id || `imported-mood-${Date.now()}-${index}`,
        local: true,
        min: Number(item.min) || 1,
        max: Number(item.max) || 6,
      }));
      const invalid = normalized.map(validateMoodPreset).find((result) => !result.ok);
      if (invalid) throw new Error(invalid.reason);
      writeMoodLibrary([...normalized, ...readMoodLibrary()]);
      renderMoodControls();
      toast('Moods imported', 'success');
    } catch (err) {
      toast(`Mood import failed: ${err?.message || err}`, 'error');
    } finally {
      const input = document.getElementById('mood-import-file');
      if (input) input.value = '';
    }
  }

  function restoreDefaultMoods() {
    if (!confirm('Clear all local mood presets and restore defaults?')) return;
    writeMoodLibrary([]);
    moodEditor.preset = 'no_animation';
    setMoodPreset('no_animation');
    toast('Local moods cleared', 'success');
  }

  function applyMoodToProfile() {
    const params = moodParams();
    if (params) send('mood_light', params);
  }

  function applyMoodToSpecificProfile(index) {
    const params = moodParams({ index });
    if (params) send('mood_light', params);
  }

  function applyMoodToLantern() {
    const params = moodParams();
    if (params && send('lantern_color', params)) {
      lanternOn = true;
      updateToggle('toggle-lantern', true);
    }
  }

  function applyColorToProfile() {
    const color = getCurrentColor();
    if (!color) return;
    send('set_color', { hex: color });
  }

  function applyColorToSpecificProfile(index) {
    const color = getCurrentColor();
    if (!color) return;
    send('set_color', { hex: color, index });
  }

  function applyLanternColor() {
    const color = getCurrentColor();
    if (!color) return;
    if (send('lantern_color', { hex: color })) {
      lanternOn = true;
      updateToggle('toggle-lantern', true);
    }
  }

  // ---- Profile Edit Modal ----

  function renderModalSummary() {
    const summary = document.getElementById('modal-summary');
    if (!summary) return;
    const temp = document.getElementById('modal-temp')?.value || '—';
    const time = document.getElementById('modal-time')?.value || '—';
    const vapor = formatVaporPreset(document.getElementById('modal-vapor')?.value);
    const preset = activeMoodPreset();
    summary.textContent = `${temp}°F · ${time}s · ${vapor} · ${preset.name}`;
  }

  function renderVaporControls() {
    const wrap = document.getElementById('modal-vapor-presets');
    const select = document.getElementById('modal-vapor');
    if (!wrap || !select) return;
    const active = normalizeVaporPreset(select.value);
    wrap.innerHTML = VAPOR_PRESETS.map((preset) => `
      <button type="button" class="vapor-preset ${preset.id === active ? 'active' : ''}" data-vapor="${escAttr(preset.id)}">
        <strong>${escHtml(preset.name)}</strong>
        <span>${escHtml(preset.desc)}</span>
      </button>
    `).join('');
    wrap.querySelectorAll('.vapor-preset').forEach((button) => {
      button.addEventListener('click', () => {
        select.value = button.dataset.vapor;
        renderVaporControls();
        renderModalSummary();
      });
    });
  }

  function editProfile(index) {
    editingProfileIndex = index;
    editingLocalProfileId = null;
    const profile = findProfile(index);
    if (!profile) { toast('Profile not found', 'error'); return; }

    document.getElementById('profile-modal')?.classList.remove('local-profile-edit');
    document.getElementById('modal-kicker').textContent = `Profile ${index}`;
    document.getElementById('modal-name').value = profile.name || '';
    document.getElementById('modal-temp').value = profile.temp_f ?? '';
    document.getElementById('modal-time').value = profile.time_s ?? '';
    document.getElementById('modal-vapor').value = normalizeVaporPreset(profile);
    document.getElementById('modal-index').value = index;

    const mood = extractProfileMood(profile.color);
    moodEditor.preset = mood.preset;
    moodEditor.colors = mood.colors;
    moodEditor.tempoFrac = mood.tempoFrac;
    moodEditor.dynamicInhale = mood.dynamicInhale;
    syncPickerToMoodColor();
    renderMoodControls();
    renderVaporControls();
    renderModalSummary();
    syncProfileDialSliders();
    populateProfileReadback(profile);
    clearProfileReadbackState();
    document.getElementById('modal-select').checked = false;
    document.getElementById('profile-modal').classList.add('visible');
  }

  function findProfile(index) {
    const profiles = Array.isArray(deviceState?.profiles) ? deviceState.profiles : [];
    const fallback = profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(index));
    return fallback >= 0 ? profileWithVapor(profiles[fallback], fallback) : null;
  }

  // Slider <-> number sync for the temperature and duration dial fields.
  // Drag the slider for an approximate value, type for an exact one. The
  // slider also gets re-tinted by the percent of the range covered, so
  // users get a visual cue when the value sits at the high or low end.
  function syncProfileDialSliders() {
    syncDialPair('modal-temp', 'modal-temp-slider', { min: 250, max: 700 });
    syncDialPair('modal-time', 'modal-time-slider', { min: 5, max: 180 });
  }

  function syncDialPair(numberId, sliderId, { min, max }) {
    const numberEl = document.getElementById(numberId);
    const sliderEl = document.getElementById(sliderId);
    if (!numberEl || !sliderEl) return;
    if (sliderEl.dataset.bound === '1') return;
    sliderEl.dataset.bound = '1';
    const tint = () => {
      const value = Number(sliderEl.value);
      if (!Number.isFinite(value)) return;
      const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
      sliderEl.style.background = `linear-gradient(90deg, var(--accent, #c084fc) 0%, var(--accent, #c084fc) ${pct}%, rgba(255,255,255,0.12) ${pct}%, rgba(255,255,255,0.12) 100%)`;
    };
    const pushValue = (raw) => {
      if (raw === '' || raw == null) {
        // Empty input — leave the slider where it is; validation will
        // surface the missing value at save time.
        return;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(min, Math.min(max, value));
      if (Number.isFinite(Number(sliderEl.value)) && Number(sliderEl.value) !== clamped) {
        sliderEl.value = String(clamped);
      }
      tint();
    };
    sliderEl.addEventListener('input', () => {
      numberEl.value = sliderEl.value;
      validateProfileDial(numberId, numberEl.value, { min, max });
      renderModalSummary();
      tint();
    });
    numberEl.addEventListener('input', () => {
      pushValue(numberEl.value);
      validateProfileDial(numberId, numberEl.value, { min, max });
      renderModalSummary();
    });
    numberEl.addEventListener('blur', () => {
      if (numberEl.value === '') return;
      const value = Number(numberEl.value);
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(min, Math.min(max, value));
      numberEl.value = String(clamped);
      pushValue(clamped);
    });
    pushValue(numberEl.value || sliderEl.value);
  }

  function validateProfileDial(id, value, { min, max }) {
    const el = document.getElementById(id);
    if (!el) return true;
    const field = el.closest('.dial-field');
    if (!field) return true;
    const numeric = Number(value);
    if (value === '' || !Number.isFinite(numeric)) {
      field.classList.remove('is-invalid');
      return true;
    }
    if (numeric < min || numeric > max) {
      field.classList.add('is-invalid');
      return false;
    }
    field.classList.remove('is-invalid');
    return true;
  }

  function clearProfileDialValidity() {
    document.querySelectorAll('#profile-modal .dial-field.is-invalid').forEach((el) => el.classList.remove('is-invalid'));
  }

  // Fills the readback panel (chamber / boost / last saved). All values
  // are best-effort — if the device didn't report a chamber we just show
  // a dash instead of pretending the data exists.
  function populateProfileReadback(profile) {
    const chamber = document.getElementById('modal-chamber');
    const boostTemp = document.getElementById('modal-boost-temp');
    const boostTime = document.getElementById('modal-boost-time');
    const savedStamp = document.getElementById('modal-saved-stamp');
    if (chamber) chamber.textContent = formatChamber(deviceState?.chamber) || '—';
    if (boostTemp) {
      const deltaF = Number(deviceState?.boost_temperature_delta_f);
      if (Number.isFinite(deltaF) && deltaF !== 0) boostTemp.textContent = `+${Math.round(deltaF)} °F`;
      else boostTemp.textContent = '—';
    }
    if (boostTime) {
      const seconds = Number(deviceState?.boost_time_s);
      if (Number.isFinite(seconds) && seconds > 0) boostTime.textContent = `${Math.round(seconds)} s`;
      else boostTime.textContent = '—';
    }
    if (savedStamp) {
      const stamp = profile?.saved_at || deviceState?.profile_saved_at?.[profile?.index];
      savedStamp.textContent = stamp ? formatRelativeStamp(stamp) : '—';
    }
  }

  function formatRelativeStamp(value) {
    if (!value) return '—';
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString();
    } catch {
      return '—';
    }
  }

  function clearProfileReadbackState() {
    const panel = document.getElementById('modal-readback');
    if (!panel) return;
    panel.classList.remove('is-saved', 'is-error', 'is-saving');
    const stamp = document.getElementById('modal-saved-stamp');
    if (stamp) stamp.textContent = '—';
  }

  function markProfileReadbackSaving() {
    const panel = document.getElementById('modal-readback');
    if (!panel) return;
    panel.classList.remove('is-saved', 'is-error');
    panel.classList.add('is-saving');
    const stamp = document.getElementById('modal-saved-stamp');
    if (stamp) stamp.innerHTML = '<span class="spinner-inline" aria-hidden="true"></span>Saving…';
  }

  function markProfileReadbackSaved(message) {
    const panel = document.getElementById('modal-readback');
    if (!panel) return;
    panel.classList.remove('is-saving', 'is-error');
    panel.classList.add('is-saved');
    const stamp = document.getElementById('modal-saved-stamp');
    if (stamp) stamp.textContent = message || 'Saved';
  }

  function markProfileReadbackError(message) {
    const panel = document.getElementById('modal-readback');
    if (!panel) return;
    panel.classList.remove('is-saving', 'is-saved');
    panel.classList.add('is-error');
    const stamp = document.getElementById('modal-saved-stamp');
    if (stamp) stamp.textContent = message || 'Save failed';
  }

  // Discard local edits and re-read this profile slot from the device.
  // Useful when the user suspects the local snapshot is stale (for
  // example, after editing the same profile in the official app).
  function reloadCurrentProfile() {
    if (editingProfileIndex == null) {
      toast('Open a profile first', 'warn');
      return;
    }
    const index = Number(editingProfileIndex);
    const btn = event?.currentTarget;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Reloading…';
    }
    markProfileReadbackSaving();
    pendingProfileReload = index;
    send('status', { full: true });
    setTimeout(() => {
      // Safety net: if the status message never lands (transport down),
      // restore the button and surface a hint rather than leaving the
      // user staring at a perpetual spinner.
      if (pendingProfileReload == null) return;
      pendingProfileReload = null;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Reload from device';
      }
      markProfileReadbackError('Reload timed out');
    }, 4000);
  }

  // Called from the 'status' message handler when a reload is pending.
  function applyPendingProfileReload() {
    const index = pendingProfileReload;
    if (index == null) return;
    pendingProfileReload = null;
    const profile = findProfile(index);
    const buttons = document.querySelectorAll('#profile-modal .modal-actions button');
    const reloadBtn = Array.from(buttons).find((b) => b.textContent.trim().startsWith('Reloading'));
    if (reloadBtn) {
      reloadBtn.disabled = false;
      reloadBtn.textContent = 'Reload from device';
    }
    if (!profile) {
      markProfileReadbackError('Profile not found on device');
      return;
    }
    document.getElementById('modal-name').value = profile.name || '';
    document.getElementById('modal-temp').value = profile.temp_f ?? '';
    document.getElementById('modal-time').value = profile.time_s ?? '';
    document.getElementById('modal-vapor').value = normalizeVaporPreset(profile);
    const mood = extractProfileMood(profile.color);
    moodEditor.preset = mood.preset;
    moodEditor.colors = mood.colors;
    moodEditor.tempoFrac = mood.tempoFrac;
    moodEditor.dynamicInhale = mood.dynamicInhale;
    syncPickerToMoodColor();
    renderMoodControls();
    renderVaporControls();
    renderModalSummary();
    syncProfileDialSliders();
    populateProfileReadback(profile);
    markProfileReadbackSaved('Reloaded from device');
    toast(`Reloaded profile ${index} from device`, 'success');
  }

  function closeModal() {
    const modal = document.getElementById('profile-modal');
    modal?.classList.remove('visible');
    modal?.classList.remove('local-profile-edit');
    editingProfileIndex = null;
    editingLocalProfileId = null;
    profileSaveInFlight = null;
    pendingProfileReload = null;
    pendingAutoCloseIndex = null;
    setSaveButtonsPending(false);
    clearProfileReadbackState();
    clearProfileDialValidity();
  }

  function saveProfile(forceSelect = false) {
    if (editingLocalProfileId) {
      saveLocalProfileFromModal();
      return;
    }
    // Block a double-click that lands between the first save setting
    // profileSaveInFlight and the setSaveButtonsPending call further
    // down. Without this guard, two set_profile commands go out for
    // the same profile, the device ends up doing the same write twice,
    // and the modal still works — but the device flash wear is doubled
    // and the activity log gets two "Updated profile N" entries.
    if (profileSaveInFlight != null) {
      toast('Profile save already in progress', 'info');
      return;
    }
    const index = parseInt(document.getElementById('modal-index').value);
    const name = document.getElementById('modal-name').value.trim() || null;
    const tempStr = document.getElementById('modal-temp').value;
    const timeStr = document.getElementById('modal-time').value;
    const vapor = normalizeVaporPreset(document.getElementById('modal-vapor')?.value);

    // Block on out-of-range dial values so the user gets a clear visual
    // signal in the form (not just a toast that vanishes). The validator
    // also runs a second time below as a hard guard.
    const tempOk = validateProfileDial('modal-temp', tempStr, { min: 250, max: 700 });
    const timeOk = validateProfileDial('modal-time', timeStr, { min: 5, max: 180 });
    if (!tempOk || !timeOk) {
      toast('Temperature must be 250-700 °F and duration 5-180 s', 'error');
      return;
    }

    const params = { index };
    if (name) params.name = name;
    if (tempStr) params.temp_f = parseFloat(tempStr);
    if (timeStr) params.time_s = parseFloat(timeStr);
    params.vapor = vapor;
    const validation = validateProfile({
      name: name || findProfile(index)?.name || `Profile ${index}`,
      temp_f: params.temp_f ?? findProfile(index)?.temp_f,
      time_s: params.time_s ?? findProfile(index)?.time_s,
    });
    if (!validation.ok) {
      toast(validation.reason, 'error');
      return;
    }
    const mood = moodParams();
    if (!mood) return;
    // Merge vapor into the mood payload so the device sees the right
    // dynamic inhale + di_frac. Vapor is the source of truth: Bold /
    // Intense / Extreme force dynamic_inhale: true with a matching
    // intensity. Smooth preserves whatever the mood editor set.
    const vaporDi = vaporDynamicInhaleFor(vapor);
    params.mood_light = {
      ...mood,
      dynamic_inhale: vaporDi.dynamic_inhale || Boolean(mood.dynamic_inhale),
      di_frac: vaporDi.di_frac,
    };
    if (forceSelect || document.getElementById('modal-select').checked) params.select = true;

    saveProfileBackup('before_set_profile');
    writeProfileVaporOverride(index, vapor);
    updateOptimisticProfileDetails(index, params);
    // Keep the modal open so the user can see the saving/saved state in
    // the readback panel. The success and error handlers below dismiss
    // it after a short delay or surface the error inline.
    markProfileReadbackSaving();
    profileSaveInFlight = index;
    const sent = send('set_profile', params);
    if (!sent) {
      profileSaveInFlight = null;
      markProfileReadbackError('Bridge is offline — could not send');
      return;
    }
    if (params.select) {
      optimisticProfileIndex = index;
      updateOptimisticProfile(index);
    }
    setSaveButtonsPending(true);
    // Auto-close on success so the experience matches the official Puffco
    // app's "tap save, modal disappears" feel. We give the user ~1.4s to
    // see the "Saved" stamp before dismissing. Errors keep the modal
    // open so the user can fix and retry.
    setTimeout(() => {
      if (pendingAutoCloseIndex === index) {
        pendingAutoCloseIndex = null;
        profileSaveInFlight = null;
        closeModal();
      }
    }, 1400);
    pendingAutoCloseIndex = index;
  }

  function setSaveButtonsPending(pending) {
    document.querySelectorAll('#profile-modal [data-device-command="set_profile"]').forEach((btn) => {
      btn.disabled = pending;
      btn.dataset.pending = pending ? '1' : '';
    });
  }

  function currentProfilesPayload() {
    return {
      version: 1,
      exported_at: new Date().toISOString(),
      device: {
        name: deviceState?.name || null,
        serial: deviceState?.serial || null,
      },
      current_profile: deviceState?.current_profile ?? null,
      profiles: Array.isArray(deviceState?.profiles)
        ? applySavedProfileOrder(deviceState.profiles).map((profile, fallbackIndex) => profileWithVapor(profile, fallbackIndex))
        : [],
    };
  }

  function exportProfiles() {
    const payload = currentProfilesPayload();
    if (!payload.profiles.length) {
      toast('No profiles available to export', 'warn');
      return;
    }
    try {
      localStorage.setItem(LOCAL_PROFILES_KEY, JSON.stringify(payload));
    } catch {}
    try {
      const blob = new Blob([safeJsonStringify(payload)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `puffco-profiles-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast('Profiles exported', 'success');
    } catch (err) {
      toast('Profile export failed', 'error');
    }
  }

  function openProfileImport() {
    document.getElementById('profile-import-file')?.click();
  }

  async function importProfileFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const profiles = Array.isArray(payload?.profiles) ? payload.profiles : Array.isArray(payload) ? payload : [];
      if (!profiles.length) throw new Error('No profiles found');
      const normalized = profiles.map((profile, fallbackIndex) => ({
        ...profile,
        id: profile.id || `imported-profile-${Date.now()}-${fallbackIndex}`,
        source: profile.source || 'import',
        index: Number.isFinite(Number(profile.index)) ? Number(profile.index) : fallbackIndex,
      }));
      const invalid = normalized.map(validateProfile).find((result) => !result.ok);
      if (invalid) throw new Error(invalid.reason);
      const mode = confirm('Replace local profile library? Press Cancel to merge.') ? 'replace' : 'merge';
      const next = mode === 'replace' ? normalized : [...normalized, ...readProfileLibrary().profiles];
      writeProfileLibrary(next);
      renderProfileLibrary();
      toast(`Profiles imported (${mode})`, 'success');
    } catch (err) {
      toast(`Profile import failed: ${err?.message || err}`, 'error');
    } finally {
      const input = document.getElementById('profile-import-file');
      if (input) input.value = '';
    }
  }

  // ---- Toggle Helpers ----

  function updateToggle(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('on', Boolean(state));
    el.setAttribute('aria-pressed', String(Boolean(state)));
  }

  function setLanternState(nextState) {
    if (!connected) return false;
    const previous = lanternOn;
    lanternOn = Boolean(nextState);
    updateToggle('toggle-lantern', lanternOn);
    if (!send('lantern', { state: lanternOn ? 'on' : 'off' })) {
      lanternOn = previous;
      updateToggle('toggle-lantern', previous);
      return false;
    }
    return true;
  }

  function toggleLantern() {
    return setLanternState(!lanternOn);
  }

  function setStealthState(nextState) {
    if (!connected) return false;
    const previous = stealthOn;
    stealthOn = Boolean(nextState);
    updateToggle('toggle-stealth', stealthOn);
    if (!send('stealth', { state: stealthOn ? 'on' : 'off' })) {
      stealthOn = previous;
      updateToggle('toggle-stealth', previous);
      return false;
    }
    return true;
  }

  function toggleStealth() {
    return setStealthState(!stealthOn);
  }

  // ---- Brightness ----

  function updateSliderLabel(name) {
    const slider = document.getElementById(`slider-${name}`);
    document.getElementById(`val-${name}`).textContent = `${slider.value}%`;
  }

  function updateAllBrightness() {
    const value = document.getElementById('slider-all').value;
    ['base', 'mid', 'glass', 'logo'].forEach((name) => {
      document.getElementById(`slider-${name}`).value = value;
      updateSliderLabel(name);
    });
    document.getElementById('val-all').textContent = `${value}%`;
  }

  function applyBrightness() {
    return send('brightness', {
      base: parseInt(document.getElementById('slider-base').value),
      mid: parseInt(document.getElementById('slider-mid').value),
      glass: parseInt(document.getElementById('slider-glass').value),
      logo: parseInt(document.getElementById('slider-logo').value),
    });
  }

  function setAllBrightnessPercent(percent) {
    const value = Math.max(1, Math.min(100, Math.round(Number(percent))));
    if (!Number.isFinite(value)) return false;
    const all = document.getElementById('slider-all');
    if (all) all.value = String(value);
    ['base', 'mid', 'glass', 'logo'].forEach((name) => {
      const slider = document.getElementById(`slider-${name}`);
      if (slider) slider.value = String(value);
      updateSliderLabel(name);
    });
    setText('val-all', `${value}%`);
    return applyBrightness();
  }

  function syncBoostOptionInputs(data) {
    const tempInput = document.getElementById('boost-temp-delta');
    const timeInput = document.getElementById('boost-time-delta');
    if (!tempInput || !timeInput) return;
    if (document.activeElement === tempInput || document.activeElement === timeInput) return;
    const temp = Number(data?.boost_temperature_delta_f);
    const time = Number(data?.boost_time_s);
    tempInput.value = Number.isFinite(temp) ? String(Math.round(temp)) : '';
    timeInput.value = Number.isFinite(time) ? String(Math.round(time)) : '';
  }

  function toggleBoostOptions() {
    const panel = document.getElementById('boost-options-panel');
    if (!panel) return;
    syncBoostOptionInputs(deviceState);
    panel.classList.toggle('hidden');
    document.getElementById('btn-boost-options')?.setAttribute('aria-expanded', String(!panel.classList.contains('hidden')));
  }

  function saveBoostOptions() {
    const tempInput = document.getElementById('boost-temp-delta');
    const timeInput = document.getElementById('boost-time-delta');
    const temp = Number(tempInput?.value);
    const time = Number(timeInput?.value);
    if (!Number.isFinite(temp) || temp < 0 || temp > 120) {
      toast('Boost temperature must be 0-120 F', 'error');
      return;
    }
    if (!Number.isFinite(time) || time < 0 || time > 180) {
      toast('Boost time must be 0-180 seconds', 'error');
      return;
    }
    send('set_boost_options', { temp_delta_f: temp, time_s: time });
  }

  // ---- Commands ----

  function connectDevice() {
    if (connectPending) return;
    const identity = currentDeviceIdentity();

    // Save to localStorage
    if (identity.mac) {
      try { localStorage.setItem('puffco_device_mac', identity.mac); } catch { /* ignore */ }
    } else {
      try { localStorage.setItem('puffco_device_name', identity.device); } catch { /* ignore */ }
    }

    const btn = document.getElementById('btn-connect');
    connectPending = true;
    btn.innerHTML = '<span class="spinner"></span> Connecting…';
    btn.disabled = true;

    if (!send('connect', { device: identity.device, mac: identity.mac })) {
      connectPending = false;
      updateConnectionUI(false);
      return;
    }

    // Safety timeout: if the chooser/backend never responds, reset to allow retry.
    const timeoutMs = transportMode === 'browser_ble' ? 45000 : 120000;
    setTimeout(() => {
      if (!connectPending) return;
      connectPending = false;
      updateConnectionUI(false);
      toast('Connection attempt timed out', 'error');
      const source = transportMode === 'browser_ble' ? 'browser Bluetooth chooser/device' : 'backend';
      appendLog(`Connection timed out after ${Math.round(timeoutMs / 1000)}s — no response from ${source}`, 'error');
    }, timeoutMs);
  }

  function disconnectDevice() {
    send('disconnect');
  }

  function resyncDevice() {
    if (connectPending) {
      toast('Connection already in progress', 'info');
      return;
    }
    const identity = currentDeviceIdentity();
    appendLog('Requesting backend BLE resync', 'info');
    send('connect', { device: identity.device, mac: identity.mac });
  }

  function scanDevices() {
    if (!scanAvailableInCurrentMode() || scanPending || connected) return;
    const button = document.getElementById('btn-scan');
    const results = document.getElementById('device-scan-results');
    scanPending = true;
    if (button) {
      button.innerHTML = '<span class="spinner"></span> Scanning…';
      button.disabled = true;
    }
    if (results) {
      results.innerHTML = '';
      results.classList.add('active');
    }
    if (!send('scan_devices', {
      timeout: 6,
      // Show every device the bridge finds. The Puffco hardware has
      // shipped under multiple Bluetooth identifiers and at least one
      // user-reported case where the Puffco's MAC prefix is not the
      // historical F0:AD:4E range. We still highlight likely Puffcos in
      // the result list, but no longer hide anything.
      puffco_only: false,
      // These fields are sent for back-compat with the bridge, but the
      // server-side filter is bypassed because puffco_only is false.
      manufacturer_prefix: PUFFCO_MANUFACTURER_MAC_PREFIX,
      manufacturer_prefixes: PUFFCO_MANUFACTURER_MAC_PREFIXES,
      mac_prefixes: PUFFCO_MANUFACTURER_MAC_PREFIXES,
    })) {
      finishDeviceScan();
      return false;
    }
    return true;
  }

  function finishDeviceScan() {
    scanPending = false;
    const button = document.getElementById('btn-scan');
    if (button) {
      button.textContent = SCAN_BUTTON_TEXT;
    }
    updateScanButtonVisibility();
  }

  function handleDeviceScan(data) {
    finishDeviceScan();
    const results = document.getElementById('device-scan-results');
    if (!results) return;
    const allDevices = Array.isArray(data?.devices) ? data.devices : [];
    const prefixes = scanManufacturerPrefixes(data);
    const prefixLabel = prefixes.join(', ');
    const devices = filterPuffcoScanDevices(allDevices, prefixes);
    const filteredOut = Math.max(0, allDevices.length - devices.length);
    if (!devices.length) {
      const noteText = data?.note || (devices.length
        ? `Found ${devices.length} nearby BLE device${devices.length === 1 ? '' : 's'}.`
        : 'No devices discovered. Make sure Bluetooth is enabled and try again.');
      results.innerHTML = `<div class="scan-empty">${escapeHtml(noteText)}</div>`;
      results.classList.add('active');
      appendLog(data?.note || `No Puffco devices found with MAC prefix ${prefixLabel}`, 'info');
      return;
    }
    results.innerHTML = devices.map((item) => {
      const name = escapeHtml(item.name || 'Puffco device');
      const address = escapeHtml(item.address || '');
      const rssi = item.rssi == null ? '' : `<span>${escapeHtml(String(item.rssi))} dBm</span>`;
      return `
        <button class="scan-result" type="button" data-address="${address}" data-name="${name}">
          <i aria-hidden="true"></i>
          <span>
            <strong>${name}</strong>
            <small>${address}</small>
          </span>
          ${rssi}
        </button>
      `;
    }).join('');
    results.classList.add('active');
    results.querySelectorAll('.scan-result').forEach((button) => {
      button.addEventListener('click', () => {
        const name = button.dataset.name || 'Puffco';
        const address = button.dataset.address || '';
        document.getElementById('device-name').value = address || name;
        const macToggle = document.getElementById('use-mac-address');
        if (macToggle) macToggle.checked = Boolean(address);
        syncIdentityModeUI();
        try { localStorage.setItem('puffco_device_name', name); } catch { /* ignore */ }
        try { localStorage.setItem('puffco_device_mac', address); } catch { /* ignore */ }
        try { localStorage.setItem('puffco_use_mac_address', address ? '1' : '0'); } catch { /* ignore */ }
        appendLog(`Selected ${name} (${address})`, 'success');
        results.classList.remove('active');
        results.innerHTML = '';
        setTimeout(() => connectDevice(), 50);
      });
    });
    const extra = filteredOut ? ` (${filteredOut} non-matching BLE device${filteredOut === 1 ? '' : 's'} hidden)` : '';
    appendLog(`Found ${devices.length} Puffco device${devices.length === 1 ? '' : 's'} with MAC prefix ${prefixLabel}${extra}`, 'success');
  }

  function refreshStatus() {
    return send('status');
  }

  function selectProfile(index) {
    if (!connected) { toast('Connect to a device first', 'warn'); return false; }
    if (optimisticProfileIndex === Number(index)) return false;
    optimisticProfileIndex = Number(index);
    updateOptimisticProfile(index);
    if (!send('select_profile', { index })) {
      optimisticProfileIndex = null;
      if (deviceState?.profiles) updateProfilesUI(deviceState.profiles, deviceState.current_profile);
      return false;
    }
    return true;
  }

  function updateOptimisticProfile(index) {
    if (!deviceState || !Array.isArray(deviceState.profiles)) return;
    const profile = findProfile(index);
    deviceState = {
      ...deviceState,
      current_profile: Number(index),
      active_profile_name: profile?.name || `Profile ${index}`,
      active_profile_temp_f: Number.isFinite(Number(profile?.temp_f)) ? Number(profile.temp_f) : deviceState.active_profile_temp_f,
      // IMPORTANT: do NOT stamp `vapor: 'standard'` onto the inactive
      // profiles here. The raw device snapshot never carries a `vapor`
      // field, so normalizeVaporPreset(item) would resolve to 'standard'
      // and SHADOW the per-slot override that lives in localStorage.
      // profileWithVapor() (called by updateProfilesUI) only falls
      // through to the override when profile.vapor is undefined; once
      // we write 'standard' into deviceState, every other profile
      // renders as Smooth until the next raw snapshot arrives. The
      // active profile DOES get a resolved vapor because the user just
      // picked it — findProfile() already returns a profileWithVapor
      // result, so its .vapor is the override-aware value.
      profiles: deviceState.profiles.map((item, fallbackIndex) => {
        const isActive = Number(item.index ?? fallbackIndex) === Number(index);
        if (!isActive) return { ...item }; // leave .vapor undefined
        return { ...item, vapor: profile?.vapor, active: true };
      }),
    };
    lastDeviceSnapshot = deviceState;
    updateProfilesUI(deviceState.profiles, index);
    updateHeroTelemetry(deviceState);
    updateTelemetryFields(deviceState);
    appendLog(`Switching to ${profile?.name || `Profile ${index}`}`, 'info');
  }

  function updateOptimisticProfileDetails(index, params) {
    if (!deviceState || !Array.isArray(deviceState.profiles)) return;
    const targetIndex = Number(index);
    deviceState = {
      ...deviceState,
      profiles: deviceState.profiles.map((item, fallbackIndex) => {
        if (Number(item.index ?? fallbackIndex) !== targetIndex) return item;
        return {
          ...item,
          name: params.name ?? item.name,
          temp_f: params.temp_f ?? item.temp_f,
          time_s: params.time_s ?? item.time_s,
          vapor: normalizeVaporPreset(params.vapor ?? item),
        };
      }),
    };
    if (Number(deviceState.current_profile) === targetIndex) {
      const profile = findProfile(targetIndex);
      deviceState.active_profile_name = profile?.name || deviceState.active_profile_name;
      deviceState.active_profile_temp_f = profile?.temp_f ?? deviceState.active_profile_temp_f;
    }
    lastDeviceSnapshot = deviceState;
    updateProfilesUI(deviceState.profiles, deviceState.current_profile);
    updateHeroTelemetry(deviceState);
    updateTelemetryFields(deviceState);
  }

  // ---- Cleaning mode ----
  // Low-temperature burn-off: starts a heat cycle, immediately pulls
  // the heater target down to 150°F, and keeps re-asserting it (the
  // firmware ramps tcmd back toward the profile temperature on its
  // own) until the 20-second window elapses, then stops the cycle.
  // Tapping the button again cancels early.
  const CLEANING_TEMP_F = 150;
  const CLEANING_SECONDS = 20;
  let cleaningTimer = null;
  let cleaningUntil = 0;

  function startCleaningMode() {
    if (cleaningTimer) {
      stopCleaningMode('Cleaning cancelled');
      return;
    }
    if (!connected) {
      toast('Connect to a device to run cleaning mode', 'warning');
      return;
    }
    if (isHeatActive(deviceState)) {
      toast('Stop the current heat cycle before cleaning', 'warning');
      return;
    }
    const tempC = Math.round(((CLEANING_TEMP_F - 32) / 1.8) * 100) / 100;
    if (!send('heat')) {
      toast('Could not start cleaning cycle', 'error');
      return;
    }
    // The user just kicked off a real burn-off. Reset the cleaning
    // counter so the next cycle of dabs starts at zero. Cleaning
    // cycles themselves never count, so this is the only way the
    // counter can decrement.
    markCleaningCycleCompleted();
    cleaningUntil = Date.now() + (CLEANING_SECONDS * 1000);
    const assertTarget = () => {
      send('lorax_write', { path: '/p/app/htr/tcmd', value: tempC, type: 'float32' });
    };
    // First assert shortly after the heat command lands, then keep the
    // target pinned low for the rest of the window.
    setTimeout(() => { if (cleaningTimer) assertTarget(); }, 800);
    cleaningTimer = setInterval(() => {
      if (Date.now() >= cleaningUntil) {
        stopCleaningMode('Cleaning cycle finished');
        return;
      }
      assertTarget();
      updateCleaningButton();
    }, 2500);
    updateCleaningButton();
    toast(`Cleaning mode: ${CLEANING_TEMP_F}°F for ${CLEANING_SECONDS}s`, 'info');
  }

  function stopCleaningMode(message = null) {
    if (cleaningTimer) {
      clearInterval(cleaningTimer);
      cleaningTimer = null;
    }
    send('stop');
    updateCleaningButton();
    if (message) toast(message, 'success');
  }

  function updateCleaningButton() {
    const btn = document.getElementById('btn-clean');
    if (!btn) return;
    const active = Boolean(cleaningTimer);
    btn.classList.toggle('cleaning-active', active);
    btn.textContent = active
      ? `Cleaning ${Math.max(0, Math.ceil((cleaningUntil - Date.now()) / 1000))}s`
      : 'Clean';
  }

  function heat() {
    if (heatCommandPending || isHeatActive(deviceState)) return false;
    heatCommandPending = 'heat';
    updateHeatControls();
    if (!send('heat')) {
      heatCommandPending = null;
      updateHeatControls();
      return false;
    }
    return true;
  }

  function stop(priority = false) {
    if (heatCommandPending && !priority) return false;
    heatCommandPending = 'stop';
    updateHeatControls();
    if (!send('stop')) {
      heatCommandPending = null;
      updateHeatControls();
      return false;
    }
    return true;
  }

  function boost() {
    if (heatCommandPending || !isHeatActive(deviceState)) return false;
    heatCommandPending = 'boost';
    updateHeatControls();
    if (!send('boost')) {
      heatCommandPending = null;
      updateHeatControls();
      return false;
    }
    return true;
  }

  function showBattery() {
    return send('show_battery');
  }

  function showVersion() {
    return send('show_version');
  }

  function power(cmd) {
    if (cmd === 'off' && !confirm('Power off the device?')) return false;
    return send('power', { cmd });
  }

  function factoryReset() {
    const confirmation = prompt('Type RESET to factory reset the device.');
    if (confirmation !== 'RESET') {
      toast('Factory reset canceled', 'info');
      return;
    }
    send('power', { cmd: 'factory_reset', confirm: confirmation });
  }

  function handleTemperatureObservation(data) {
    const promoted = data?.temperature_promoted;
    const top = data?.temperature_ranked?.[0];
    const automatic = !!data?.automatic;
    if (promoted) {
      toast('Live temperature path mapped', 'success');
      appendLog(`${automatic ? 'Auto-mapped' : 'Mapped'} live temp: ${promoted.path} (${promoted.encoding})`, 'success');
      send('status');
      return;
    }
    if (automatic) return;
    if (top) {
      appendLog(`Best temp candidate: ${top.path} ${top.last_f} F (${top.encoding}, ${top.trend}, range ${top.range_f} F)`, 'info');
      toast('Temperature candidate found; run while heating to promote', 'info');
    } else {
      appendLog('No live temperature candidate found in this sample window', 'warn');
      toast('No temperature path found yet', 'info');
    }
  }

  function handleDrawStrengthObservation(data) {
    const promoted = data?.promoted;
    const ranked = Array.isArray(data?.ranked) ? data.ranked : [];
    const automatic = !!data?.automatic;
    if (promoted) {
      const tag = automatic ? 'Auto-pinned' : 'Pinned';
      const mode = promoted.mode === 'dynamic_inhale' ? 'dynamic inhale' : promoted.mode || 'direct';
      toast(`Dynamic inhale: ${promoted.path}`, 'success');
      appendLog(`${tag} dynamic inhale source: ${promoted.path} · ${mode}`, 'success');
      send('status');
      return;
    }
    if (automatic) return; // Background tick without promotion — silent.
    if (ranked.length) {
      const top = ranked[0];
      appendLog(
        `Best dynamic inhale candidate: ${top.path} (score ${top.score}, spread ${top.spread}, ` +
          `${top.nonzero_hits}/${top.samples} non-zero samples)`,
        'info',
      );
      toast('Dynamic inhale candidate found; re-run with promote to pin it', 'info');
    } else {
      appendLog('No dynamic inhale candidate responded during the scan', 'warn');
      toast('No dynamic inhale response yet — try again while inhaling', 'info');
    }
  }

  // ---- Toast System ----

  // SVG icon set keyed by toast type
  const TOAST_ICON = {
    success: `<svg class="toast-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8.5l2 2 3-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    error: `<svg class="toast-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    warn: `<svg class="toast-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8 2.5L14.5 13.5H1.5L8 2.5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.75" fill="currentColor"/></svg>`,
    info: `<svg class="toast-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.5v4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="5.5" r="0.75" fill="currentColor"/></svg>`,
  };

  const TOAST_DISMISS_ICON = `<svg class="toast-dismiss-icon" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

  const TOAST_AUTO_DISMISS_MS = {
    info: 4000,
    warn: 6000,
    success: 4000,
    error: 0, // never auto-dismiss
  };

  const TOAST_MAX_STACK = 5;

  /**
   * Unified toast API — backward-compatible with toast(message, type).
   *
   * Usage:
   *   toast('Saved', 'success');                           // existing API
   *   toast('Processing…', { type: 'info' });               // options object
   *   toast('Uploading…', { type: 'info', progress: 0 });   // progress toast
   *   toast('Deleted', { type: 'success', undoLabel: 'Undo', onUndo: fn });
   *
   * Returns { updateProgress(pct), dismiss() } for progress toasts,
   * { dismiss() } for all others, or null for no-op calls.
   */
  function toast(message, typeOrOptions) {
    // Normalise arguments
    let type = 'info';
    let options = {};
    if (typeof typeOrOptions === 'string') {
      type = typeOrOptions;
    } else if (typeOrOptions && typeof typeOrOptions === 'object') {
      options = typeOrOptions;
      type = options.type || 'info';
    }

    // progress: 0-100 (special type — rendered as progress toast, type maps colour)
    // actions: [{ label, onClick }]
    // undoLabel + onUndo: shorthand for one undo action
    // duration: override auto-dismiss ms (0 = manual only)
    const {
      progress = null,
      actions = [],
      undoLabel = '',
      onUndo = null,
      duration = TOAST_AUTO_DISMISS_MS[type] ?? 4000,
    } = options;

    // Build actions list (undo shorthand)
    const actionList = [...actions];
    if (undoLabel && typeof onUndo === 'function') {
      actionList.unshift({ label: undoLabel, onClick: onUndo });
    }

    const container = document.getElementById('toast-container');
    if (!container) return null;

    // De-duplicate by exact message text
    const duplicate = [...container.children].find((child) => {
      const txt = child.querySelector('.toast-message');
      return txt && txt.textContent === message;
    });
    if (duplicate) {
      duplicate.remove();
    }

    // Enforce max stack
    while (container.children.length >= TOAST_MAX_STACK) {
      const oldest = container.children[0];
      oldest.remove();
    }

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

    // Icon
    const iconHtml = TOAST_ICON[type] || TOAST_ICON.info;

    // Progress bar
    const progressHtml =
      progress !== null
        ? `<div class="toast-progress-bar"><div class="toast-progress-fill" style="width:${Math.max(0, Math.min(100, progress))}%"></div></div>`
        : '';

    // Actions
    const actionsHtml = actionList.length
      ? `<div class="toast-actions">${actionList
          .map((a) => `<button class="toast-action-btn" data-label="${escAttr(a.label)}">${escHtml(a.label)}</button>`)
          .join('')}</div>`
      : '';

    // Dismiss button
    const dismissBtn = `<button class="toast-dismiss" aria-label="Dismiss">${TOAST_DISMISS_ICON}</button>`;

    el.innerHTML = `
      <span class="toast-icon-wrap">${iconHtml}</span>
      <span class="toast-message">${escHtml(message)}</span>
      ${progressHtml}
      ${actionsHtml}
      ${dismissBtn}
    `;

    container.appendChild(el);

    // Wire action buttons
    actionList.forEach((action, i) => {
      const btn = el.querySelectorAll('.toast-action-btn')[i];
      if (btn) {
        btn.addEventListener('click', () => {
          action.onClick();
          dismissToast(el);
        });
      }
    });

    // Wire dismiss button
    const dismissEl = el.querySelector('.toast-dismiss');
    if (dismissEl) dismissEl.addEventListener('click', () => dismissToast(el));

    // Progress update helper
    const updateProgress = progress !== null
      ? (pct) => {
          const fill = el.querySelector('.toast-progress-fill');
          if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        }
      : null;

    // Auto-dismiss timer
    let timer = null;
    if (duration > 0) {
      timer = setTimeout(() => dismissToast(el), duration);
    }

    function dismissToast(element) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      element.classList.add('exit');
      setTimeout(() => element.remove(), 300);
    }

    // Expose dismiss on the element so callers can call el.toastDismiss()
    el.toastDismiss = dismissToast;
    if (updateProgress) el.toastUpdateProgress = updateProgress;

    return { updateProgress, dismiss: dismissToast };
  }

  // ---- Activity Log ----

  function appendLog(message, type = 'info', options = {}) {
    const log = document.getElementById('activity-log');
    if (!log) return;

    if (!options.skipDebug) recordBrowserDebug(type, message);

    const empty = log.querySelector('.log-empty');
    if (empty) empty.remove();

    const row = document.createElement('div');
    const normalizedType = normalizeLogType(type);
    row.className = `log-row ${normalizedType}`;
    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const details = logDetails(message);
    row.innerHTML = `
      <span class="log-time">${escHtml(time)}</span>
      <span class="log-level">${escHtml(logLabel(normalizedType))}</span>
      <span class="log-message">${escHtml(details.main)}${details.meta ? `<small>${escHtml(details.meta)}</small>` : ''}</span>
    `;
    log.prepend(row);

    while (log.children.length > 80) {
      log.lastElementChild.remove();
    }
  }

  function handleWriteVerification(verification) {
    const target = verification.target || 'profile';
    if (verification.ok) {
      const mood = verification.actual_mood;
      if (mood?.official_compatible) {
        appendLog(`Verified ${target}: official app mood payload recognized (${mood.mood_name || mood.mood_type})`, 'success');
      } else {
        appendLog(`Verified ${target}: heat profile readback matched`, 'success');
      }
      return;
    }

    const reason = Array.isArray(verification.mismatches) && verification.mismatches.length
      ? verification.mismatches.join('; ')
      : 'readback did not match the requested write';
    appendLog(`Verification warning for ${target}: ${reason}`, 'warn');
    toast('Profile saved, but readback verification needs attention', 'warn');
  }

  // Routes a save-profile WebSocket response into the right UI state.
  // The modal's readback panel shows "Saving…" → "Saved" / "Error", and
  // the set_profile button is re-enabled as soon as we hear back.
  function handleProfileSaveResponse(msg, isError) {
    if (profileSaveInFlight == null) return;
    const index = profileSaveInFlight;
    profileSaveInFlight = null;
    setSaveButtonsPending(false);
    if (isError) {
      // Errors keep the modal open and cancel the auto-close timer so
      // the user has time to read the error and decide what to do next.
      if (pendingAutoCloseIndex === index) pendingAutoCloseIndex = null;
      markProfileReadbackError(msg?.message || 'Save failed');
      return;
    }
    const stamp = new Date().toLocaleTimeString();
    const verification = msg?.data?.write_verification;
    if (verification && verification.ok) {
      markProfileReadbackSaved(`Saved at ${stamp} — verified`);
    } else if (verification && !verification.ok) {
      const reason = Array.isArray(verification.mismatches) && verification.mismatches.length
        ? verification.mismatches.join('; ')
        : 'readback did not match';
      markProfileReadbackSaved(`Saved at ${stamp} — ${reason}`);
    } else {
      markProfileReadbackSaved(`Saved at ${stamp}`);
    }
    // On success the auto-close timer (set in saveProfile) will dismiss
    // the modal. We don't clear pendingAutoCloseIndex here so the timer
    // can do its job.
  }

  function normalizeLogType(type) {
    if (type === 'success' || type === 'error' || type === 'warn') return type;
    return 'info';
  }

  function logLabel(type) {
    return { success: 'OK', error: 'ERR', warn: 'WARN', info: 'INFO' }[type] || 'INFO';
  }

  function logDetails(message) {
    const text = String(message || '');
    const splitAt = text.search(/\. [A-Z]|\. Windows|\. Close|\. Retry|\. The /);
    if (splitAt > 20) {
      return {
        main: text.slice(0, splitAt + 1),
        meta: text.slice(splitAt + 2),
      };
    }
    return { main: text, meta: '' };
  }

  function rememberBackendMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type !== 'status') {
      recordBrowserDebug(msg.type === 'error' ? 'error' : 'info', `Message: ${msg.type}`, {
        message: msg.message || null,
        data: msg.data ?? 'No data returned',
      });
    }
    lastBackendMessage = {
      type: msg.type || 'unknown',
      message: msg.message || 'No message',
      received_at: new Date().toISOString(),
      data: msg.data ?? 'No data returned',
    };
    renderBackendMirror();
  }

  function handleConnectionStatus(data) {
    if (!data) return;
    lastConnectionStatus = data;
    const stage = data.stage || 'bluetooth';
    const message = data.message || 'Bluetooth status changed';
    const type = stage === 'failed' ? 'error' : stage === 'connected' || stage === 'synced' ? 'success' : 'info';
    appendLog(message, type);
    renderBackendMirror();

    if (connectPending) {
      const btn = document.getElementById('btn-connect');
      if (btn) btn.innerHTML = `<span class="spinner"></span> ${connectionButtonLabel(data)}`;
    }
    if (scanPending && stage === 'scanning') {
      const btn = document.getElementById('btn-scan');
      if (btn) btn.innerHTML = '<span class="spinner"></span> Scanning...';
    }
  }

  function connectionButtonLabel(data) {
    if (data.stage === 'retrying') return 'Retrying...';
    if (data.stage === 'resetting') return 'Resetting...';
    if (data.stage === 'connected' || data.stage === 'synced') return 'Syncing...';
    if (data.attempt && data.attempts) return `Connecting ${data.attempt}/${data.attempts}`;
    return 'Connecting...';
  }

  function renderConnectionAttempts(attempts) {
    if (!Array.isArray(attempts) || !attempts.length) return;
    attempts.forEach((attempt) => {
      const cacheMode = attempt.use_cached_services ? 'cached GATT' : 'fresh GATT';
      const hint = attempt.hint ? ` ${attempt.hint}` : '';
      appendLog(`BLE attempt ${attempt.attempt} (${cacheMode}) failed: ${attempt.error}.${hint}`, 'error');
    });
  }

  function friendlyErrorMessage(message) {
    const text = String(message || 'Unknown error');
    const lower = text.toLowerCase();
    if (/no chamber|chamber.*(missing|not detected|error|fault)/i.test(text)) return 'Chamber needs attention: check that it is installed and seated.';
    if (/overheat|over.?temp|too hot/i.test(text)) return 'Device is too hot. Let it cool before starting another session.';
    if (/low battery|battery.*low|soc/i.test(text)) return 'Battery is too low for this action.';
    if (/disconnected|gatt.*disconnect|link lost/i.test(text)) return 'Bluetooth disconnected. Wake the device and reconnect.';
    if (/write.*fail|ble write|gatt.*write|not permitted/i.test(text)) return 'BLE write failed. The feature may be locked, unsupported, or the device may be busy.';
    if (/unsupported|not implemented|not exposed|unknown command/i.test(text)) return 'Unsupported feature on this firmware or transport.';
    if (lower.includes('chooser was canceled')) return 'Bluetooth chooser was canceled.';
    return text;
  }

  function renderBackendMirror() {
    const snapshot = lastDeviceSnapshot || deviceState || null;
    const backend = snapshot?.backend || {};
    const official = snapshot?.official_attributes || {};
    const sources = snapshot?.official_sources || {};
    const readable = snapshot?.official_readable || {};
    const stage = lastConnectionStatus?.stage || (connected ? 'connected' : 'idle');
    const lastMessage = lastConnectionStatus?.message || lastBackendMessage?.message || lastBackendMessage?.type || '—';
    const updated = snapshot?.timestamp || lastConnectionStatus?.timestamp || lastBackendMessage?.received_at;

    setText('backend-stage', humanizeEnum(stage));
    setText('backend-last-message', lastMessage);
    setText('backend-updated', updated ? formatTimestamp(updated) : '—');
    setText('backend-ble-link', formatBooleanLabel(backend.ble_link_connected));
    setText('backend-connected', formatBooleanLabel(backend.device_connected_flag ?? snapshot?.connected));
    setText('backend-poll', formatPollingStatus(backend, snapshot));
    setText('backend-battery-raw', formatBackendValue(snapshot?.battery_raw || snapshot?.battery_source || snapshot?.battery));
    setText('backend-temp-source', formatTemperatureSource(snapshot, sources));

    setPreText('backend-snapshot-json', snapshot ? safeJsonStringify(snapshot) : 'No snapshot yet');
    setPreText(
      'backend-official-json',
      Object.keys(official).length
        ? safeJsonStringify({ attributes: official, readable, sources, errors: snapshot?.official_errors || {} })
        : 'No official attributes yet'
    );
    setPreText('backend-message-json', lastBackendMessage ? safeJsonStringify(lastBackendMessage) : 'No backend message yet');
  }

  function setPreText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = displayValue(value, 'No data yet');
  }

  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value, (_key, raw) => {
        if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
        return raw;
      }, 2);
    } catch (err) {
      return `Unable to render JSON: ${err.message}`;
    }
  }

  function friendlyJsonStringify(value) {
    try {
      return JSON.stringify(value, (_key, raw) => {
        if (raw === null || raw === undefined || raw === '') return 'Not available';
        if (typeof raw === 'number' && !Number.isFinite(raw)) return 'Not available';
        return raw;
      }, 2);
    } catch (err) {
      return `Unable to render JSON: ${err.message}`;
    }
  }

  function formatBackendValue(value) {
    if (value == null || value === '') return '—';
    if (typeof value === 'object') return safeJsonStringify(value);
    return String(value);
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatTemperatureSource(snapshot, sources = {}) {
    return formatBackendValue(
      snapshot?.live_temperature_source?.path
      || snapshot?.live_temperature?.path
      || snapshot?.live_temperature?.source
      || sources.currentTemperature
      || snapshot?.current_temperature_source
      || (snapshot?.transport === 'browser_ble' ? '/p/app/htr/temp' : null)
    );
  }

  function formatPollingStatus(backend, snapshot = null) {
    if (!backend || typeof backend !== 'object') {
      if (snapshot?.transport === 'browser_ble' || transportMode === 'browser_ble') {
        return connected ? `Browser poll, ${document.hidden ? HIDDEN_BLE_POLL_MS : VISIBLE_BLE_POLL_MS}ms` : 'Browser poll idle';
      }
      return '—';
    }
    if (backend.transport === 'browser_ble' || snapshot?.transport === 'browser_ble') {
      return connected ? `Browser poll, ${document.hidden ? HIDDEN_BLE_POLL_MS : VISIBLE_BLE_POLL_MS}ms` : 'Browser poll idle';
    }
    const enabled = formatBooleanLabel(backend.polling);
    const interval = Number(backend.poll_interval_s);
    const staleIgnored = Number(backend.ignored_disconnect_callbacks);
    const parts = [Number.isFinite(interval) ? `${enabled}, ${interval}s` : enabled];
    if (Number.isFinite(staleIgnored) && staleIgnored > 0) parts.push(`${staleIgnored} stale callback${staleIgnored === 1 ? '' : 's'} ignored`);
    if (backend.session_id != null) parts.push(`session ${backend.session_id}`);
    return parts.join(' / ');
  }

  function clearLog() {
    const log = document.getElementById('activity-log');
    if (!log) return;
    log.innerHTML = '<div class="log-empty">No activity yet</div>';
  }

  // ---- Utilities ----

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = displayValue(value);
  }

  function displayValue(value, fallback = '—') {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number' && !Number.isFinite(value)) return fallback;
    if (typeof value === 'string' && /^(null|undefined|nan)$/i.test(value.trim())) return fallback;
    return String(value);
  }

  function normalizePercent(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(100, Math.round(parsed)));
  }

  function formatMetric(value, fractionDigits = 0) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    return parsed.toLocaleString(undefined, {
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: 0,
    });
  }

  function formatDabsPerDay(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return '—';
    const digits = Math.abs(parsed) < 10 ? 2 : 1;
    return formatMetric(parsed, digits);
  }

  function formatTemperatureF(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return `${Math.round(parsed)} F`;
  }

  function validHeatTargetF(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 200 ? parsed : null;
  }

  function formatTargetTemperature(data, report = getHeatReport(data), readable = data?.official_readable || {}, selectedProfile = getSelectedProfile(data)) {
    const firmwareTarget = validHeatTargetF(report?.target_temp_f)
      ?? validHeatTargetF(readable?.targetTemperatureF)
      ?? validHeatTargetF(data?.target_temperature_f);
    const profileTarget = validHeatTargetF(selectedProfile?.temp_f) ?? validHeatTargetF(data?.active_profile_temp_f);
    const target = firmwareTarget ?? profileTarget;
    return formatTemperatureF(target);
  }

  function formatTemperatureDeltaF(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    const rounded = Math.round(parsed);
    return `${rounded > 0 ? '+' : ''}${rounded} F`;
  }

  function formatPercentLabel(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return `${Math.round(parsed)}%`;
  }

  function formatSecondsLabel(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    const total = Math.round(parsed);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes && seconds) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    if (minutes) return `${minutes}m`;
    return `${seconds}s`;
  }

  function formatBooleanLabel(value) {
    if (value === true) return 'On';
    if (value === false) return 'Off';
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed ? 'On' : 'Off';
    return humanizeEnum(value);
  }

  function formatBrightness(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') {
      const parts = Object.entries(value)
        .map(([key, raw]) => {
          const parsed = Number(raw);
          if (!Number.isFinite(parsed)) return null;
          const pct = Math.round((Math.max(0, Math.min(255, parsed)) / 255) * 100);
          return `${humanizeEnum(key)} ${pct}%`;
        })
        .filter(Boolean);
      return parts.join(', ') || null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return humanizeEnum(value);
    const clamped = Math.max(0, Math.min(255, parsed));
    return `${Math.round((clamped / 255) * 100)}%`;
  }

  function formatBoostSetting(data, readable) {
    const temp = formatTemperatureDeltaF(data.boost_temperature_delta_f) || readable.boostTemperature;
    const time = formatBoostTimeDelta(data.boost_time_s) || readable.boostTime;
    const active = isBoostActive(data);
    if (active && temp && time) return `Boosting ${temp} / ${time}`;
    if (active) return 'Boosting';
    if (temp && time) return `${temp} / ${time}`;
    return temp || time || 'Boost options unavailable';
  }

  function formatBoostTimeDelta(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return `+${Math.round(parsed)}s`;
  }

  function formatDeviceIdentity(data) {
    const model = data?.model || data?.device_model || data?.product_name || null;
    const name = data?.name || null;
    const serial = data?.serial ? ` · ${data.serial}` : '';
    if (model && name && model !== name) return `${name} · ${model}${serial}`;
    return `${name || model || 'Puffco'}${serial}`;
  }

  function formatRssi(data) {
    const value = data?.rssi ?? data?.last_rssi ?? data?.backend?.rssi;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'Not reported';
    return `${Math.round(parsed)} dBm`;
  }

  function normalizeSnapshotForUi(data) {
    if (!data || typeof data !== 'object') return data;
    const payload = { ...data };
    if (payload.state_elapsed_time_s == null && payload.state_elapsed_time != null) {
      payload.state_elapsed_time_s = payload.state_elapsed_time;
    }
    if (payload.state_total_time_s == null && payload.state_total_time != null) {
      payload.state_total_time_s = payload.state_total_time;
    }
    if (!payload.heat_report) {
      payload.heat_report = buildClientHeatReport(payload);
    }
    // Bridge mode keeps the OFFICIAL_ATTRIBUTE_SPECS reads under
    // data.official_attributes. Web Bluetooth mode flattens them at
    // read time. Unify the two so the rest of the app can stay transport-
    // agnostic and the new hardware-diagnostics stat-* fields always
    // see a flat payload.
    const official = payload.official_attributes;
    if (official && typeof official === 'object') {
      const map = {
        mode: 'mode',
        lowBatteryIndicator: 'low_battery_indicator',
        chargeSource: 'charge_source',
        chargeCurrent: 'charge_current_a',
        chargeElapsedTime: 'charge_elapsed_time_s',
        batteryCapacity: 'battery_capacity',
        batteryCurrent: 'battery_current_a',
        batteryVoltage: 'battery_voltage_v',
        batteryTemperature: 'battery_temperature_c',
        heaterPower: 'heater_power_w',
        heaterResistance: 'heater_resistance_ohm',
        heaterVoltage: 'heater_voltage_v',
        cableHandshakeDetected: 'cable_handshake_detected',
        faultEndIndex: 'fault_end_index',
        dateOfBirth: 'date_of_birth_unix',
        utcTime: 'utc_time_unix',
        dabTotalTime: 'dab_total_time_s',
        stateTotalTime: 'state_total_time_s',
        stateElapsedTime: 'state_elapsed_time_s',
        selectedHeatCycle: 'current_profile',
        chamberType: 'chamber',
      };
      Object.entries(map).forEach(([src, dst]) => {
        if (payload[dst] == null && official[src] != null) payload[dst] = official[src];
      });
      // BLE fault counts are nested objects: data.official_attributes.bleFault.absoluteCount
      if (official.bleFault && typeof official.bleFault === 'object') {
        if (payload.ble_fault_absolute_count == null && official.bleFault.absoluteCount != null) {
          payload.ble_fault_absolute_count = official.bleFault.absoluteCount;
        }
        if (payload.ble_fault_credit_count == null && official.bleFault.creditCount != null) {
          payload.ble_fault_credit_count = official.bleFault.creditCount;
        }
      }
    }
    // Derived fields computed from the flat payload. These are simple
    // honest derivations, not faked sensors.
    if (payload.battery_voltage_v != null && payload.battery_current_a != null && payload.charge_rate_w == null) {
      payload.charge_rate_w = Math.round(Math.abs(payload.battery_voltage_v * payload.battery_current_a) * 10) / 10;
    }
    if (payload.cable_handshake_detected != null && payload.cable_attached == null) {
      payload.cable_attached = payload.cable_handshake_detected !== 0;
    }
    if (payload.date_of_birth_unix != null && payload.date_of_birth_unix > 0 && payload.days_owned == null) {
      payload.days_owned = Math.max(0, Math.floor((Date.now() / 1000 - payload.date_of_birth_unix) / 86400));
    }
    if (payload.utc_time_unix != null && payload.utc_time_unix > 0 && payload.device_utc_time == null) {
      payload.device_utc_time = new Date(payload.utc_time_unix * 1000)
        .toISOString().replace('T', ' ').replace(/\..+$/, '');
    }
    if (payload.dab_total_time_s != null && payload.total_dabs > 0 && payload.avg_seconds_per_dab == null) {
      payload.avg_seconds_per_dab = Math.round(payload.dab_total_time_s / payload.total_dabs);
    }
    return payload;
  }

  function buildClientHeatReport(data) {
    const stateKey = normalizeStateKey(data?.state);
    const active = Boolean(data?.heat === 'HEATING' || ['HEAT_CYCLE_PREHEAT', 'HEAT_CYCLE_ACTIVE', 'HEAT_CYCLE_FADE'].includes(stateKey));
    const elapsed = secondsNumber(data?.state_elapsed_time_s);
    const total = secondsNumber(data?.state_total_time_s);
    const selectedProfile = getSelectedProfile(data);
    const profileDuration = secondsNumber(selectedProfile?.time_s) ?? secondsNumber(data?.active_profile_time_s);
    const durationCandidates = [profileDuration];
    if (active) durationCandidates.push(total);
    const duration = durationCandidates.filter(value => value != null).reduce((max, value) => Math.max(max, value), null);
    const activeTimer = active && stateKey === 'HEAT_CYCLE_ACTIVE';
    const remaining = activeTimer && elapsed != null && duration != null ? Math.max(0, duration - elapsed) : null;
    const timerConfidence = activeTimer && remaining != null ? 'firmware' : active ? 'preheating' : 'inactive';
    const current = data?.current_temperature_f;
    const target = validHeatTargetF(data?.target_temperature_f)
      ?? validHeatTargetF(selectedProfile?.temp_f)
      ?? validHeatTargetF(data?.active_profile_temp_f);
    return {
      active,
      phase: data?.labels?.heat || (active ? 'Heating' : 'Idle'),
      state: data?.state,
      selected_profile: data?.current_profile,
      target_temp_f: target,
      target_temp_label: formatTemperatureF(target),
      duration_s: duration,
      duration_label: formatSecondsLabel(duration),
      timer_active: activeTimer,
      firmware_elapsed_s: elapsed,
      firmware_total_s: total,
      timer_elapsed_s: activeTimer ? elapsed : null,
      timer_elapsed_label: activeTimer ? formatSecondsLabel(elapsed) : null,
      timer_remaining_s: remaining,
      timer_remaining_label: formatSecondsLabel(remaining),
      timer_confidence: timerConfidence,
      timer_source: remaining != null ? 'browser_ble_firmware_state_elapsed_and_total_time' : 'browser_ble_state',
      current_temp_f: current,
      current_temp_label: formatTemperatureF(current),
    };
  }

  function secondsNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, number) : null;
  }

  function isBoostActive(data) {
    const state = normalizeStateKey(data?.state);
    const reportPhase = normalizeStateKey(getHeatReport(data)?.phase);
    return Boolean(data?.boost_active || state.includes('BOOST') || reportPhase.includes('BOOST'));
  }

  function formatLanternStatus(data, readable) {
    const remaining = readable.lanternRemainingTime || formatSecondsLabel(data.lantern_remaining_time_s);
    const total = readable.lanternTime || formatSecondsLabel(data.lantern_time_s);
    if (data.lantern === true && remaining) return `On, ${remaining} left`;
    if (data.lantern === true) return total ? `On, ${total}` : 'On';
    if (data.lantern === false) return 'Off';
    return remaining || total || '—';
  }

  function formatBatterySource(source, sourceType) {
    if (!source) return '—';
    if (source === '/p/bat/soc') return 'Official SOC';
    if (source === '/p/bat/lev') return 'Battery level path';
    if (source === '/p/bat/cap') return sourceType === 'capacity_raw' ? 'Capacity telemetry' : 'Battery capacity';
    return String(source).replace(/^\/p\//, '');
  }

  function humanizeEnum(value) {
    if (value == null || value === '') return '—';
    return String(value)
      .replace(/^CHAMBER_TYPE_/i, '')
      .replace(/^HEAT_CYCLE_/i, '')
      .replace(/^CHARGE_/i, '')
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function numericCode(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isInteger(number) ? number : null;
  }

  function normalizeStateKey(value) {
    if (value == null || value === '') return '';
    const compact = String(value).trim().toUpperCase().replace(/[\s.\/-]+/g, '_');
    const noSep = compact.replace(/_/g, '');
    const aliases = {
      INITMEMORY: 'INIT_MEMORY',
      INITVERSION: 'INIT_VERSION',
      INITBATTERY: 'INIT_BATTERY',
      MASTEROFF: 'MASTER_OFF',
      TEMPSELECT: 'TEMP_SELECT',
      HEATCYCLEPREHEAT: 'HEAT_CYCLE_PREHEAT',
      HEATCYCLEACTIVE: 'HEAT_CYCLE_ACTIVE',
      HEATCYCLEFADE: 'HEAT_CYCLE_FADE',
      BATTLEVEL: 'BATT_LEVEL',
      FACTORYTEST: 'FACTORY_TEST',
      TEMPSTOP: 'TEMP_STOP',
      DONEDISCONNECTED: 'DONE_DISCONNECTED',
    };
    return aliases[noSep] || compact;
  }

  function formatCharge(value) {
    const code = numericCode(value);
    const codeLabels = {
      0: 'Charging',
      1: 'Charging',
      2: 'Full',
      3: 'Charging paused',
      4: 'Done/Disconnected',
    };
    if (codeLabels[code]) return codeLabels[code];
    const normalized = normalizeStateKey(value);
    const labels = {
      NOT_CHARGING: 'Not charging',
      CHARGING: 'Charging',
      BULK: 'Charging',
      TOPUP: 'Charging',
      FULLY_CHARGED: 'Full',
      FULL: 'Full',
      COMPLETE: 'Full',
      CHARGE_COMPLETE: 'Full',
      DISCHARGING: 'On battery',
      DONE_DISCONNECTED: 'Done/Disconnected',
      TEMP_STOP: 'Charging paused',
      TEMPSTOP: 'Charging paused',
    };
    return labels[normalized] || humanizeEnum(value);
  }

  function formatChargeEta(data = {}, readable = {}) {
    const chargeLabel = formatCharge(data.charge ?? readable.charge);
    const chargeKey = normalizeStateKey(chargeLabel);
    if (['ON_BATTERY', 'NOT_CHARGING', 'DONE_DISCONNECTED'].includes(chargeKey)) return 'Not charging';
    if (chargeKey === 'FULL') return 'Full';
    const readableEta = readable.chargeEstimatedTimeToFull;
    if (readableEta && !/inf/i.test(String(readableEta))) return readableEta;
    const seconds = Number(data.charge_estimated_time_to_full_s);
    return Number.isFinite(seconds) && seconds >= 0 ? formatSecondsLabel(seconds) : 'Not reported';
  }

  function chargeClass(value) {
    const code = numericCode(value);
    if (code === 0 || code === 1) return 'charging';
    if (code === 2) return 'full';
    if (code === 3) return 'paused';
    if (code === 4) return 'idle';
    const normalized = normalizeStateKey(value);
    if (['BULK', 'TOPUP', 'CHARGING'].includes(normalized)) return 'charging';
    if (normalized.includes('FULL') || normalized.includes('COMPLETE')) return 'full';
    if (normalized === 'TEMP_STOP' || normalized === 'TEMPSTOP') return 'paused';
    return 'idle';
  }

  function formatSecondsClock(value) {
    const total = Math.max(0, Math.round(Number(value) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  function getDynamicRemainingSeconds(report) {
    if (report?.timer_remaining_s == null) return null;
    if (report?.timer_confidence === 'firmware') return report.timer_remaining_s;
    const startedAt = report.timer_started_at ? Date.parse(report.timer_started_at) : NaN;
    const duration = Number(report.duration_s);
    if (!Number.isFinite(startedAt) || !Number.isFinite(duration)) {
      return report.timer_remaining_s;
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return Math.max(0, duration - elapsed);
  }

  function getHeatReport(data) {
    if (!data || typeof data !== 'object') return {};
    return data.heat_report || buildClientHeatReport(data);
  }

  function getSelectedProfile(data = deviceState) {
    const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
    if (!profiles.length) return null;
    const selected = data?.current_profile;
    // null/undefined current_profile is "no profile selected" — fall
    // through to the .active marker instead of accidentally matching
    // profile 0 via Number(null) === 0. Without this guard, a brief
    // window where the device snapshot has no current_profile (right
    // after reconnect, for example) would silently mark profile 0 as
    // "selected" in the UI.
    const selectedIndex = selected == null
      ? -1
      : profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(selected));
    if (selectedIndex >= 0) return profileWithVapor(profiles[selectedIndex], selectedIndex);
    const activeIndex = profiles.findIndex((profile) => profile?.active);
    return activeIndex >= 0 ? profileWithVapor(profiles[activeIndex], activeIndex) : null;
  }

  function formatChamber(value) {
    const code = numericCode(value);
    const codeLabels = {
      0: 'No chamber',
      1: 'Classic chamber',
      2: 'XL chamber',
      3: '3D chamber',
      4: 'Toad chamber',
    };
    if (codeLabels[code]) return codeLabels[code];
    const normalized = String(value || '').toUpperCase();
    if (!value) return '—';
    if (normalized.includes('3D') && normalized.includes('XL')) return '3D XL chamber';
    if (normalized.includes('3D')) return '3D chamber';
    if (normalized.includes('XL')) return 'XL chamber';
    return humanizeEnum(value);
  }

  function formatDeviceState(value) {
    const normalized = normalizeStateKey(value);
    const labels = {
      IDLE: 'Idle',
      HEAT_CYCLE_PREHEAT: 'Preheating',
      HEAT_CYCLE_ACTIVE: 'Heating',
      HEAT_CYCLE_FADE: 'Cooling down',
      MASTER_OFF: 'Off',
      SLEEP: 'Sleep',
      TEMP_SELECT: 'Temperature select',
      CHARGING: 'Charging',
    };
    return labels[normalized] || humanizeEnum(value);
  }

  function isHeatActive(data) {
    const state = normalizeStateKey(data?.state);
    return data?.heat === 'HEATING' || ['HEAT_CYCLE_PREHEAT', 'HEAT_CYCLE_ACTIVE', 'HEAT_CYCLE_FADE'].includes(state);
  }

  function heatStatusLabel(data) {
    if (!connected) return 'Idle';
    if (!data) return 'Idle';
    const label = data.labels?.heat;
    if (label) return isHeatActive(data) ? `${label}…` : label;
    if (isHeatActive(data)) return normalizeStateKey(data.state) === 'HEAT_CYCLE_PREHEAT' ? 'Preheating…' : 'Heating…';
    if (data.heat === 'other' && data.state) return formatDeviceState(data.state);
    return 'Idle';
  }

  function reconcileHeatPending() {
    if (!heatCommandPending || !deviceState) return;
    const heating = isHeatActive(deviceState);
    if ((heatCommandPending === 'heat' && heating) || (heatCommandPending === 'stop' && !heating)) {
      heatCommandPending = null;
    }
  }

  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Lorax Path Explorer ----

  function refreshLoraxRegistry() {
    const btn = document.getElementById('btn-reload-lorax');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
    requestLoraxRegistry(true);
  }

  // ---- Heater sensor path probes ----
  //
  // Quick-action helper that verifies these Lorax paths are actually
  // reachable on the connected device, not just present in the
  // registry — prints what came back so the user can see whether
  // their hardware exposes each sensor.
  const HEATER_SENSOR_TEST_PATHS = [
    { path: '/p/htr/pwr',  name: 'heater_power',        encoding: 'float32' },
    { path: '/p/htr/res',  name: 'heater_resistance',   encoding: 'float32' },
    { path: '/p/htr/vavg', name: 'heater_voltage',      encoding: 'float32' },
    { path: '/p/htr/temp', name: 'heater_temperature',  encoding: 'float32' },
    { path: '/p/htr/tcmd', name: 'heater_target_temperature', encoding: 'float32' },
  ];

  function setLoraxQuickActionsStatus(text, kind = '') {
    const el = document.getElementById('lorax-quick-actions-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'lorax-quick-actions-status' + (kind ? ' ' + kind : '');
  }

  function formatLoraxReadValue(data) {
    if (!data) return 'no response';
    if (data.error) return `error: ${data.error}`;
    if (data.value != null && data.value !== '') {
      const hex = Array.isArray(data.bytes)
        ? data.bytes.map(b => (b & 0xff).toString(16).padStart(2, '0')).join(' ')
        : null;
      return hex ? `${data.value} (bytes: ${hex})` : String(data.value);
    }
    if (data.raw != null) return `raw: ${data.raw}`;
    return 'no value returned';
  }

  // Latest run summary, kept around so the user can copy the full
  // path-by-path result set with a single click. Cleared at the start
  // of every test so a stale "last run" doesn't leak into the next.
  let latestLoraxTestSummary = '';
  let latestLoraxTestLabel = '';

  function buildLoraxTestSummary(label, rows) {
    const header = [
      `PuffcoBLE Lorax path test — ${label}`,
      `Time: ${new Date().toISOString()}`,
      `Transport: ${transportMode === 'browser_ble' ? 'Browser Bluetooth' : 'Local bridge'}`,
      '',
      ...rows.map((r) => {
        const result = r.result == null ? 'timeout' : formatLoraxReadValue(r.result);
        return `${r.path}  (${r.name}, ${r.encoding})  =  ${result}`;
      }),
    ];
    return header.join('\n');
  }

  function setLatestLoraxTestSummary(label, rows) {
    latestLoraxTestLabel = label;
    latestLoraxTestSummary = buildLoraxTestSummary(label, rows);
    // Reflect "ready to copy" state in the UI.
    const btn = document.getElementById('btn-lorax-test-copy');
    if (btn) {
      btn.disabled = !latestLoraxTestSummary;
      btn.classList.toggle('hidden', !latestLoraxTestSummary);
      btn.title = latestLoraxTestSummary
        ? `Copy the latest ${label} results to the clipboard`
        : '';
    }
  }

  // Sends a sequence of read requests and aggregates the results. Each
  // path test writes a row into the status line, then appends a single
  // summary row to the activity log so the user can see history.
  function runLoraxPathTests(paths, label) {
    if (!connected) {
      setLoraxQuickActionsStatus('Connect to a device first', 'warn');
      toast('Connect to a Puffco before running path tests', 'error');
      return;
    }
    setLoraxQuickActionsStatus(`Testing ${paths.length} ${label}…`, 'busy');
    // Clear the cached summary so a stale "last run" can't be copied
    // mid-test.
    latestLoraxTestSummary = '';
    const copyBtn = document.getElementById('btn-lorax-test-copy');
    if (copyBtn) {
      copyBtn.disabled = true;
      copyBtn.classList.add('hidden');
    }
    appendLog(`Probing ${label} on device:`, 'info');
    let outstanding = paths.length;
    const rows = paths.map((entry) => ({ ...entry, result: null }));
    // Guard finish() so the 4s timer and a late-arriving response can
    // never both call it. The previous code double-fired the "probe
    // complete" log + UI state toggle when a response arrived in the
    // same tick the timer was about to fire.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      const summary = rows.map((r) => `${r.path} = ${r.result == null ? 'timeout' : formatLoraxReadValue(r.result)}`).join('\n');
      setLoraxQuickActionsStatus(`${rows.length} tested`, 'done');
      appendLog(`${label} probe complete:\n${summary}`, rows.every((r) => r.result && !r.result.error) ? 'success' : 'warn');
      setLatestLoraxTestSummary(label, rows);
    };
    let timer = window.setTimeout(() => {
      outstanding = 0;
      finish();
    }, 4000);
    const tryFinish = () => {
      outstanding -= 1;
      if (outstanding <= 0) finish();
    };
    paths.forEach((entry, idx) => {
      const queued = send('lorax_read', { path: entry.path, size: 4, type: entry.encoding });
      if (!queued) {
        rows[idx].result = { error: 'send failed (no transport)' };
        tryFinish();
        return;
      }
      const onResponse = (data) => {
        if (!data || data.path !== entry.path) return false;
        rows[idx].result = data;
        tryFinish();
        return true;
      };
      pendingLoraxTestResponses.push(onResponse);
    });
  }

  async function copyLoraxTestResults() {
    if (!latestLoraxTestSummary) {
      toast('Run a path test first, then copy', 'info');
      return;
    }
    const text = latestLoraxTestSummary;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for non-secure contexts: a hidden textarea + execCommand.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      toast(`Copied ${latestLoraxTestLabel} results`, 'success');
      appendLog(`Copied ${latestLoraxTestLabel} results to clipboard (${text.length} chars)`, 'success');
    } catch (err) {
      toast('Clipboard copy failed', 'error');
      appendLog(`Clipboard copy failed: ${err?.message || err}`, 'error');
    }
  }

  const pendingLoraxTestResponses = [];

  // Force a fresh draw-strength path probe on the next snapshot.
  //
  // Why this exists: a stale `puffco_draw_strength_source` localStorage
  // pin (e.g. /p/app/htr/draw on older firmware, which is actually a
  // static config register that pins at 34% / 42%) used to keep the UI
  // reporting a constant value forever AND trip the dab-scoring debounce
  // with a fake "active" reading. Calling this clears the pin, kicks
  // the static-register detection window, and returns the ranked
  // observe result so the caller can show it to the user.
  async function redetectDrawStrengthSource() {
    const client = getBrowserBle();
    if (!client) {
      toast('Browser Bluetooth client is not ready', 'error');
      return null;
    }
    if (typeof client.redetectDrawStrength !== 'function') {
      toast('This build does not support draw-strength re-detect; reload the page', 'error');
      return null;
    }
    const result = await client.redetectDrawStrength();
    const ranked = result?.data?.ranked || [];
    const winner = ranked[0];
    const winnerLine = winner
      ? `Winner: ${winner.path} (score ${winner.score}, spread ${winner.spread}, ${winner.nonzero_hits}/${winner.samples} non-zero)`
      : 'No path responded';
    toast(`Re-detected draw-strength paths. ${winnerLine}`, winner ? 'success' : 'info');
    appendLog(`draw-strength re-detect: ${winnerLine}; ${ranked.length} path(s) probed`, 'info');
    // Force a fresh snapshot so the UI immediately reflects the new
    // resolved source / cleared pin.
    try { await getBrowserBle().handleCommand('status'); } catch (_) {}
    return result;
  }

  // Drop the saved draw-strength pin without re-probing. Use this when
  // the user wants the next snapshot to re-resolve from scratch (the
  // readDrawStrength walk will then pick the live path).
  function clearDrawStrengthPin() {
    const client = getBrowserBle();
    if (!client) {
      toast('Browser Bluetooth client is not ready', 'error');
      return;
    }
    if (typeof client.clearDrawStrengthPin !== 'function') {
      toast('This build does not support clearing the draw-strength pin', 'error');
      return;
    }
    client.clearDrawStrengthPin();
    toast('Cleared inhale-sensor pin. Next snapshot will re-detect.', 'info');
    appendLog('draw-strength pin cleared by user', 'info');
  }

  function testHeaterSensorPaths() {
    runLoraxPathTests(HEATER_SENSOR_TEST_PATHS, 'heater sensor paths');
  }

  // Called by the central message handler when a lorax_read response
  // arrives. Lets pending path tests match their target path and
  // remove themselves.
  function consumeLoraxTestResponse(data) {
    for (let i = 0; i < pendingLoraxTestResponses.length; i += 1) {
      if (pendingLoraxTestResponses[i](data)) {
        pendingLoraxTestResponses.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  function requestLoraxRegistry(force = false) {
    if (!force && (registryLoaded || registryRequestInFlight)) return false;
    if (transportMode === 'browser_ble' && !browserBleSupported()) return false;
    if (transportMode === 'bridge' && ws?.readyState !== WebSocket.OPEN) return false;
    registryRequestInFlight = true;
    const queued = send('lorax_registry');
    if (!queued) registryRequestInFlight = false;
    return queued;
  }

  function handleLoraxRegistry(data) {
    registryRequestInFlight = false;
    const btn = document.getElementById('btn-reload-lorax');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reload Registry';
    }
    if (!data || !data.paths) return;
    loraxPaths = data.paths;
    loraxActions = data.actions || {};
    registryLoaded = true;
    populateDevActionMenu();
    filterLoraxPaths();
    appendLog(`Loaded ${loraxPaths.length} Lorax paths from device registry`, 'info');
  }

  function populateDevActionMenu() {
    const select = document.getElementById('dev-lorax-action');
    if (!select) return;
    const entries = Object.entries(loraxActions || {});
    if (!entries.length) {
      select.innerHTML = '<option value="">No actions loaded</option>';
      return;
    }
    select.innerHTML = '<option value="">Select action</option>' + entries.map(([name, action]) => {
      const danger = action?.dangerous ? ' danger' : '';
      const label = `${humanizeEnum(name)} -> ${action?.path || 'unknown'}${danger}`;
      return `<option value="${escAttr(name)}">${escHtml(label)}</option>`;
    }).join('');
  }

  function filterLoraxPaths() {
    const search = document.getElementById('lorax-search').value.toLowerCase().trim();
    const category = document.getElementById('lorax-category-filter').value;
    const status = document.getElementById('lorax-status-filter').value;

    const filtered = loraxPaths.filter(p => {
      const matchSearch = !search || p.path.toLowerCase().includes(search) || p.name.toLowerCase().includes(search) || (p.function && p.function.toLowerCase().includes(search));
      const matchCategory = category === 'all' || p.category === category;
      const matchStatus = status === 'all' || p.status === status;
      return matchSearch && matchCategory && matchStatus;
    });

    renderLoraxPathList(filtered);
  }

  // Helper to escape HTML attributes safely
  function escAttr(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeHtml(str) {
    return escAttr(str);
  }

  function escHtml(str) {
    return escAttr(str);
  }

  // ---- Lorax folder tree ----
  // The explorer renders the path catalog as a real folder hierarchy
  // (like a file browser) instead of a flat fetch-results list. Native
  // <details> elements give expand/collapse for free; open state is
  // remembered across filter re-renders, and an active search expands
  // everything so matches are visible.
  const loraxTreeOpen = new Set();

  function loraxTreeCount(node) {
    let total = node.entries.length;
    node.children.forEach((child) => { total += loraxTreeCount(child); });
    return total;
  }

  function renderLoraxPathList(paths) {
    const list = document.getElementById('lorax-path-list');
    if (!list) return;
    list.innerHTML = '';

    if (paths.length === 0) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No paths found</div>';
      return;
    }

    // Build the tree: every intermediate segment is a folder, the
    // final segment is a leaf carrying the registry entry.
    const root = { children: new Map(), entries: [] };
    for (const p of paths) {
      const segs = String(p.path || '').split('/').filter(Boolean);
      let node = root;
      for (let i = 0; i < segs.length - 1; i += 1) {
        const seg = segs[i];
        if (!node.children.has(seg)) node.children.set(seg, { children: new Map(), entries: [] });
        node = node.children.get(seg);
      }
      node.entries.push(p);
    }

    const searching = Boolean(document.getElementById('lorax-search')?.value.trim());

    const buildLeaf = (p) => {
      const div = document.createElement('div');
      div.className = `lorax-path-item lorax-tree-leaf${selectedPathEntry && selectedPathEntry.path === p.path ? ' active' : ''}`;
      div.dataset.path = p.path;
      div.onclick = () => selectLoraxPath(p.path);
      const accessLabel = getAccessLabel(p.access);
      const accessClass = getAccessClass(p.access);
      const statusBadge = p.status === 'experimental' ? '<span class="lorax-badge lorax-badge-exp">exp</span>' : '';
      const leafName = String(p.path || '').split('/').filter(Boolean).pop() || p.path;
      div.innerHTML = `
        <div class="path-name" title="${escAttr(p.path)}">${escHtml(leafName)}</div>
        <div class="path-meta">
          ${statusBadge}
          <span class="lorax-badge ${accessClass}">${escHtml(accessLabel)}</span>
        </div>
      `;
      return div;
    };

    const build = (node, prefix, depth) => {
      const frag = document.createDocumentFragment();
      Array.from(node.children.keys()).sort().forEach((seg) => {
        const child = node.children.get(seg);
        const folderPath = `${prefix}/${seg}`;
        const details = document.createElement('details');
        details.className = 'lorax-tree-folder';
        if (searching || loraxTreeOpen.has(folderPath) || depth < 1) details.open = true;
        details.addEventListener('toggle', () => {
          if (details.open) loraxTreeOpen.add(folderPath);
          else loraxTreeOpen.delete(folderPath);
        });
        const summary = document.createElement('summary');
        summary.className = 'lorax-tree-summary';
        summary.innerHTML = `
          <svg class="lorax-tree-caret" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          <svg class="lorax-tree-foldericon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          <span class="lorax-tree-foldername">${escHtml(seg)}</span>
          <span class="lorax-tree-count">${loraxTreeCount(child)}</span>
        `;
        details.appendChild(summary);
        const inner = document.createElement('div');
        inner.className = 'lorax-tree-children';
        inner.appendChild(build(child, folderPath, depth + 1));
        details.appendChild(inner);
        frag.appendChild(details);
      });
      node.entries
        .slice()
        .sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .forEach((p) => frag.appendChild(buildLeaf(p)));
      return frag;
    };

    list.appendChild(build(root, '', 0));
  }

  function selectLoraxPath(pathStr) {
    const entry = loraxPaths.find(p => p.path === pathStr);
    if (!entry) return;
    selectedPathEntry = entry;

    // Highlight active in the tree (leaves carry the full path in a
    // data attribute since they display only the final segment).
    document.querySelectorAll('.lorax-path-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.path === pathStr);
    });

    renderLoraxDetails();
    readSelectedLoraxPath();
  }

  function renderLoraxDetails(readResult = null) {
    const panel = document.getElementById('lorax-details-panel');
    if (!panel || !selectedPathEntry) return;

    const entry = selectedPathEntry;
    const warning = entry.dangerous ? `
      <div class="lorax-warning-banner">
        <div><strong>⚠️ Warning:</strong> Writing to this path (${escHtml(entry.path)}) is marked as DANGEROUS! Proceed with caution.</div>
      </div>
    ` : '';

    const writeSection = (entry.access === 'write' || entry.access === 'read_write') ? `
      <div class="lorax-section">
        <span class="lorax-section-title">Write Value</span>
        <div class="lorax-write-form">
          <div class="lorax-write-inputs">
            <input type="text" id="lorax-write-value" placeholder="Value to write..." />
            <input type="number" id="lorax-write-offset" value="0" placeholder="Offset" />
            <select id="lorax-write-type">
              <option value="">Default (${escAttr(entry.data_type)})</option>
              <option value="bytes">bytes (hex space-separated)</option>
              <option value="text">text (string)</option>
              <option value="float32">float32</option>
              <option value="uint32">uint32</option>
              <option value="int32">int32</option>
              <option value="uint16">uint16</option>
              <option value="int16">int16</option>
              <option value="uint8">uint8</option>
              <option value="int8">int8</option>
              <option value="bool">bool</option>
            </select>
          </div>
          <button class="btn btn-primary" onclick="app.writeSelectedLoraxPath()">Write Value</button>
        </div>
      </div>
    ` : '';

    let readDataHtml = `
      <div class="lorax-placeholder-text" style="min-height:100px;">
        Click Read to fetch data.
      </div>
    `;

    if (readResult) {
      if (readResult.error) {
        readDataHtml = `
          <div class="lorax-read-results" style="border:1px solid rgba(239, 68, 68, 0.3);background:rgba(239, 68, 68, 0.05);color:#fca5a5;">
            Error: ${escHtml(readResult.error)}
          </div>
        `;
      } else {
        const parsedValue = readResult.value ?? readResult.decoded;
        const valueStr = parsedValue === null || parsedValue === undefined || parsedValue === '' ? 'No value returned' : parsedValue;
        const rawHex = readResult.raw || '';
        const interpretations = readResult.interpretations || {};

        let interpRows = '';
        if (interpretations) {
          const skipKeys = new Set(['length', 'raw_hex', 'temperature_candidates']);
          Object.entries(interpretations).forEach(([k, v]) => {
            if (skipKeys.has(k)) return;
            let valRepr = v;
            if (typeof v === 'boolean') valRepr = v ? 'true' : 'false';
            if (typeof v === 'object' && v !== null) valRepr = JSON.stringify(v);
            interpRows += `
              <div class="lorax-result-row">
                <span class="lorax-result-label">${escHtml(k)}</span>
                <span class="lorax-result-value">${escHtml(String(valRepr))}</span>
              </div>
            `;
          });
        }

        readDataHtml = `
          <div class="lorax-read-results">
            <div class="lorax-result-row">
              <span class="lorax-result-label" style="font-weight:600;color:var(--text-accent);">Parsed Value</span>
              <span class="lorax-result-value" style="font-weight:600;color:var(--text-accent);">${escHtml(String(valueStr))}</span>
            </div>
            <div class="lorax-result-row">
              <span class="lorax-result-label">Raw Hex</span>
              <span class="lorax-result-value">${escHtml(rawHex)}</span>
            </div>
            ${interpRows}
          </div>
        `;
      }
    }

    panel.innerHTML = `
      <div class="lorax-detail-header">
        <h3>${escHtml(entry.path)}</h3>
        <div class="lorax-detail-desc">${escHtml(entry.function || 'No description available')}</div>
        <div class="inline-actions mt-sm">
          <button class="btn btn-sm btn-secondary" onclick="app.useSelectedPathAsTemperatureSource()">Use as Temp Source</button>
          <button class="btn btn-sm btn-secondary" onclick="app.copySelectedLoraxPath()">Copy Path</button>
        </div>
      </div>

      <div class="lorax-detail-grid">
        <div class="lorax-detail-item">
          <span class="lorax-detail-label">Name</span>
          <span class="lorax-detail-val">${escHtml(entry.name)}</span>
        </div>
        <div class="lorax-detail-item">
          <span class="lorax-detail-label">Category</span>
          <span class="lorax-detail-val">${escHtml(entry.category)}</span>
        </div>
        <div class="lorax-detail-item">
          <span class="lorax-detail-label">Data Type</span>
          <span class="lorax-detail-val">${escHtml(entry.data_type)}</span>
        </div>
        <div class="lorax-detail-item">
          <span class="lorax-detail-label">Access</span>
          <span class="lorax-detail-val">${escHtml(entry.access)}</span>
        </div>
      </div>

      ${warning}

      <div class="lorax-section">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="lorax-section-title">Read Path</span>
          <div style="display:flex;gap:6px;align-items:center;">
            <label class="text-sm text-muted">Offset <input type="number" id="lorax-read-offset" value="${escAttr(entry.offset || 0)}" style="width:50px;padding:2px 4px;font-size:0.75rem;background:var(--bg-input);border:1px solid var(--border-subtle);color:var(--text-primary);border-radius:4px;" /></label>
            <label class="text-sm text-muted">Size <input type="number" id="lorax-read-size" value="${escAttr(entry.size || '')}" style="width:50px;padding:2px 4px;font-size:0.75rem;background:var(--bg-input);border:1px solid var(--border-subtle);color:var(--text-primary);border-radius:4px;" /></label>
            <button class="btn btn-sm btn-secondary" onclick="app.readSelectedLoraxPath()">Read</button>
          </div>
        </div>
        <div id="lorax-read-container">
          ${readDataHtml}
        </div>
      </div>

      ${writeSection}
    `;
  }

  function readSelectedLoraxPath() {
    if (!selectedPathEntry) return;
    const offsetEl = document.getElementById('lorax-read-offset');
    const sizeEl = document.getElementById('lorax-read-size');
    const offset = offsetEl ? parseInt(offsetEl.value) || 0 : 0;
    const size = sizeEl && sizeEl.value ? parseInt(sizeEl.value) || null : selectedPathEntry.size;

    const container = document.getElementById('lorax-read-container');
    if (container) {
      container.innerHTML = `
        <div class="lorax-placeholder-text" style="min-height:100px;">
          <span class="spinner"></span> Reading...
        </div>
      `;
    }

    send('lorax_read', {
      path: selectedPathEntry.path,
      offset,
      size,
      type: selectedPathEntry.data_type
    });
  }

  function writeSelectedLoraxPath() {
    if (!selectedPathEntry) return;

    const valEl = document.getElementById('lorax-write-value');
    const offsetEl = document.getElementById('lorax-write-offset');
    const typeEl = document.getElementById('lorax-write-type');

    if (!valEl) return;
    const rawVal = valEl.value.trim();
    if (rawVal === '') {
      toast('Please enter a value to write', 'error');
      return;
    }

    const offset = offsetEl ? parseInt(offsetEl.value) || 0 : 0;
    const typeOverride = typeEl ? typeEl.value : '';
    const dataType = typeOverride || selectedPathEntry.data_type;

    // Convert value according to type
    let parsedVal = rawVal;
    try {
      if (dataType === 'bool') {
        parsedVal = rawVal.toLowerCase() === 'true' || rawVal === '1';
      } else if (dataType === 'float32') {
        parsedVal = parseFloat(rawVal);
        if (isNaN(parsedVal)) throw new Error('Invalid float');
      } else if (dataType !== 'bytes' && dataType !== 'text') {
        parsedVal = parseInt(rawVal);
        if (isNaN(parsedVal)) throw new Error('Invalid integer');
      }
    } catch (e) {
      toast(`Invalid value for type ${dataType}: ${e.message}`, 'error');
      return;
    }

    const params = {
      path: selectedPathEntry.path,
      value: parsedVal,
      offset,
      type: dataType
    };

    if (selectedPathEntry.dangerous) {
      const confirmMsg = `WARNING: Writing to ${selectedPathEntry.path} (${selectedPathEntry.name}) is marked as DANGEROUS!\n\nAre you sure you want to write "${rawVal}" to this path?`;
      if (!confirm(confirmMsg)) {
        appendLog(`Write to ${selectedPathEntry.path} aborted by user`, 'info');
        return;
      }
      params.confirm = 'WRITE';
    }

    send('lorax_write', params);
  }

  async function copySelectedLoraxPath() {
    if (!selectedPathEntry) return;
    try {
      await navigator.clipboard.writeText(selectedPathEntry.path);
      toast('Path copied', 'success');
      appendLog(`Copied ${selectedPathEntry.path}`, 'success');
    } catch (err) {
      toast('Could not copy path', 'error');
      appendLog(`Copy path failed: ${err?.message || err}`, 'error');
    }
  }

  function useSelectedPathAsTemperatureSource() {
    if (!selectedPathEntry) return;
    const pathEl = document.getElementById('dev-temp-path');
    const encodingEl = document.getElementById('dev-temp-encoding');
    if (pathEl) pathEl.value = selectedPathEntry.path;
    if (encodingEl) {
      const type = String(selectedPathEntry.data_type || '').toLowerCase();
      if (type.includes('float')) encodingEl.value = 'float32_c';
      else if (type.includes('uint16')) encodingEl.value = 'uint16_c_x10';
      else if (type.includes('uint8')) encodingEl.value = 'uint8_c';
    }
    toast('Temperature source fields filled', 'success');
    appendLog(`Prepared temp source ${selectedPathEntry.path}`, 'info');
  }

  function handleLoraxRead(data) {
    if (!data) return;
    // Quick-action path tests (testHeaterSensorPaths) register a
    // one-shot listener before sending the read. If a test
    // claimed this response, skip the global handler.
    if (typeof consumeLoraxTestResponse === 'function' && consumeLoraxTestResponse(data)) {
      return;
    }
    const normalized = {
      ...data,
      value: data.value ?? data.decoded,
    };
    if (selectedPathEntry && selectedPathEntry.path === data.path) {
      renderLoraxDetails(normalized);
    }
    appendLog(`Read ${data.path}: ${normalized.value !== null && normalized.value !== undefined && normalized.value !== '' ? normalized.value : 'No parsed value'}`, 'info');
  }

  function renderDevResult(type, data) {
    const output = document.getElementById('dev-command-output');
    if (!output) return;
    const payload = {
      type,
      received_at: new Date().toISOString(),
      data: data ?? 'No data returned',
    };
    output.textContent = friendlyJsonStringify(payload);
  }

  function clearDevOutput() {
    const output = document.getElementById('dev-command-output');
    if (output) output.textContent = 'Developer command output will appear here.';
  }

  function numericInput(id, fallback) {
    const el = document.getElementById(id);
    const parsed = Number(el?.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function selectValue(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
  }

  function devOfficialAttrs() {
    send('official_attributes');
  }

  // ---- Inhale sensor tools ----
  function devDrawObserve(promote = false) {
    const sent = send('draw_strength_observe', { samples: 6, interval: 0.5, promote: Boolean(promote) });
    if (sent) renderDevResult('draw_strength_observe', { started: true, promote: Boolean(promote), hint: 'Take a draw during the scan.' });
  }

  function devDrawClearPin() {
    try {
      const client = transportMode === 'browser_ble' ? getBrowserBle() : null;
      if (client) client.clearDrawStrengthPin();
    } catch { /* bridge mode */ }
    send('draw_strength_source', { clear: true });
    renderDevResult('draw_strength_pin', { cleared: true, hint: 'Next snapshot re-resolves the inhale source.' });
  }

  function devDrawState() {
    renderDevResult('inhale_sensor_state', {
      source: deviceState?.draw_strength_source ?? null,
      mode: deviceState?.draw_strength_mode ?? null,
      raw_percent: deviceState?.draw_strength_percent ?? null,
      normalized_percent: Math.round(dabNormalizePercent(Number(deviceState?.draw_strength_percent) || 0)),
      learned_max_raw: Math.round(dabLearnedMaxPct * 10) / 10,
      pinned: deviceState?.draw_strength_source_mapping ?? null,
    });
  }

  // ---- Dab scoring harness ----
  function devDabState() {
    renderDevResult('dab_scoring_state', {
      dabState,
      enabled: dabEnabled,
      threshold_pct: dabThreshold,
      difficulty: dabDifficulty,
      samples: dabSamples.length,
      fast_sampler_running: Boolean(dabFastTimer),
      fast_sample_ms: DAB_FAST_SAMPLE_MS,
      drop_timeout_ms: dabDropTimeoutMs,
      max_duration_ms: dabMaxDurationMs,
      preheat_offset_s: Math.round(dabPreheatOffset * 100) / 100,
      learned_max_raw: Math.round(dabLearnedMaxPct * 10) / 10,
      session_peak_raw: Math.round(dabSessionPeakRaw * 10) / 10,
    });
  }

  // Quick gate self-test: replays the PREHEAT -> ACTIVE flow through
  // the real dabOnStatus pipeline and reports whether the session
  // started. Restores prior state when done.
  function devDabGateTest() {
    const before = { dabState, dabLastStateKey, dabEnabled, samples: dabSamples.length };
    const wasEnabled = dabEnabled;
    const results = [];
    try {
      dabEnabled = true;
      const fire = (state, pct) => {
        dabOnStatus({ connected: true, heat: state === 'IDLE' ? 'IDLE' : 'HEATING', state, draw_strength_percent: pct });
        results.push({ sent: state, pct, dabState });
      };
      closeDabPanel();
      fire('HEAT_CYCLE_PREHEAT', 0);
      const armed = dabState === 'preheating';
      fire('HEAT_CYCLE_ACTIVE', 5);
      const started = dabState === 'active';
      closeDabPanel();
      renderDevResult('dab_gate_self_test', {
        pass: armed && started,
        armed_on_preheat: armed,
        started_on_active_edge: started,
        trace: results,
      });
    } finally {
      dabEnabled = wasEnabled;
      dabLastStateKey = before.dabLastStateKey;
    }
  }

  function devDabSynthetic() {
    try {
      window.__puffcoTest?.startDabDiagnostic({ durationMs: 8000, stepMs: 100 });
      renderDevResult('dab_synthetic_diagnostic', { started: true, duration_ms: 8000, hint: 'Watch the dab panel — IDLE -> PREHEAT -> ACTIVE -> FADE replay.' });
    } catch (e) {
      renderDevResult('dab_synthetic_diagnostic', { started: false, error: e?.message || String(e) });
    }
  }

  // ---- Raw path read ----
  function devReadPath() {
    const path = document.getElementById('dev-read-path')?.value?.trim();
    const type = document.getElementById('dev-read-type')?.value || 'float32';
    if (!path || !path.startsWith('/')) {
      renderDevResult('lorax_read', { error: 'Enter a lorax path starting with /' });
      return;
    }
    send('lorax_read', { path, type, size: type === 'text' ? 32 : 4 });
    renderDevResult('lorax_read', { requested: path, type, hint: 'Result lands in the activity log / explorer details.' });
  }

  // ---- Calibration tools ----
  function devCalibrationState() {
    const history = readPeakHistory();
    renderDevResult('calibration_state', {
      preheat_offset_s: Math.round(dabPreheatOffset * 100) / 100,
      draw_learned_max_raw: Math.round(dabLearnedMaxPct * 10) / 10,
      draw_recent_peaks_raw: history.map((n) => Math.round(n * 10) / 10),
      draw_recent_max_raw: history.length ? Math.round(Math.max(...history) * 10) / 10 : null,
      hint: 'Reset either from Settings > Dab, or app.resetDabPreheatCalibration() / app.resetDabDrawCalibration().',
    });
  }

  function devHeatProbe() {
    send('heat_probe', {
      status: 'experimental',
      limit: numericInput('dev-lorax-limit', 40),
      size: 4,
    });
  }

  function devHeatObserve() {
    send('heat_observe', {
      status: 'experimental',
      limit: numericInput('dev-lorax-limit', 40),
      samples: 16,
      interval: 0.75,
      promote: document.getElementById('dev-promote-temp')?.checked === true,
      require_change: true,
    });
  }

  function devLoraxProbe() {
    const params = {
      limit: numericInput('dev-lorax-limit', 40),
      size: 4,
    };
    const category = selectValue('dev-lorax-category');
    const status = selectValue('dev-lorax-status');
    if (category) params.category = category;
    if (status) params.status = status;
    send('lorax_probe', params);
  }

  function devLoraxObserve() {
    const params = {
      limit: numericInput('dev-lorax-limit', 40),
      size: 4,
      samples: 8,
      interval: 0.75,
    };
    const category = selectValue('dev-lorax-category');
    const status = selectValue('dev-lorax-status');
    if (category) params.category = category;
    if (status) params.status = status;
    send('lorax_observe', params);
  }

  function devSetTemperatureSource() {
    const path = document.getElementById('dev-temp-path')?.value.trim();
    const encoding = selectValue('dev-temp-encoding');
    if (!path || !encoding) {
      toast('Choose a Lorax path and encoding first', 'error');
      return;
    }
    send('temperature_source', { path, encoding });
  }

  function devClearTemperatureSource() {
    send('temperature_source', { clear: true });
  }

  // ---- Maxed-out dev deck additions ----
  // These round out the deck with the highest-value dev/testing
  // operations a power user needs: backups, vapor mass-edit, time
  // sync, dab history export, profile duplication, snapshot dump,
  // local storage wipe, and a lorax path regex search.
  function devProfileExport() {
    const profiles = Array.isArray(deviceState?.profiles)
      ? applySavedProfileOrder(deviceState.profiles).map((profile, i) => profileWithVapor(profile, i))
      : [];
    if (!profiles.length) {
      renderDevResult('profile_export', { error: 'No profiles on the device yet.' });
      return;
    }
    const payload = {
      kind: 'puffco_profile_export',
      version: 1,
      exported_at: new Date().toISOString(),
      device: {
        name: deviceState?.name || null,
        serial: deviceState?.serial || null,
        current_profile: deviceState?.current_profile ?? null,
      },
      profiles,
    };
    const text = safeJsonStringify(payload);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `puffco-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    renderDevResult('profile_export', { ok: true, count: profiles.length, file: link.download });
  }

  function devProfileImport() {
    const input = document.getElementById('dev-profile-import-file');
    if (!input) {
      renderDevResult('profile_import', { error: 'No file input wired.' });
      return;
    }
    input.click();
  }

  // Read the file picked by devProfileImport and write any profiles
  // it contains into the device, preserving slot order.
  function devProfileImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ''));
        const profiles = Array.isArray(data?.profiles) ? data.profiles : null;
        if (!profiles) throw new Error('No profiles array in file');
        renderDevResult('profile_import', {
          ok: true,
          received: profiles.length,
          hint: 'Profiles staged — call app.applyImportedProfiles() from devtools to push them to the device.',
        });
        window.__lastProfileImport = data;
      } catch (err) {
        renderDevResult('profile_import', { error: err?.message || String(err) });
      }
    };
    reader.readAsText(file);
  }

  function applyImportedProfiles() {
    const data = window.__lastProfileImport;
    if (!data || !Array.isArray(data?.profiles)) {
      toast('No staged import available', 'error');
      return;
    }
    const ok = saveProfileBackup('pre-import');
    if (ok) toast('Backup saved, writing profiles…', 'info');
    saveProfileBackup('pre-import');
    // Use the same payload shape the device expects. Each profile's
    // vapor field is normalized so the reorder-stomp bug can't recur.
    const next = data.profiles.slice(0, 4).map((profile, slotIndex) => profilePayloadForDevice(profile, slotIndex));
    send('set_profiles', { profiles: next });
    toast('Imported profiles sent to device', 'success');
    renderDevResult('profile_import', { ok: true, applied: next.length });
  }

  function devVaporSetAll() {
    const vapor = document.getElementById('dev-vapor-mode')?.value || 'standard';
    const profiles = Array.isArray(deviceState?.profiles)
      ? applySavedProfileOrder(deviceState.profiles).map((profile, i) => ({ ...profileWithVapor(profile, i), vapor }))
      : [];
    if (!profiles.length) {
      renderDevResult('vapor_set_all', { error: 'No profiles on the device.' });
      return;
    }
    const next = profiles.map((profile, slotIndex) => profilePayloadForDevice(profile, slotIndex));
    // Persist the per-slot vapor in localStorage so it sticks after a
    // reorder (the same fix that landed for commitDeviceProfileOrder).
    profiles.forEach((profile, fallbackIndex) => {
      const index = Number(profile?.index ?? fallbackIndex);
      writeProfileVaporOverride(index, vapor);
    });
    send('set_profiles', { profiles: next });
    renderDevResult('vapor_set_all', { ok: true, vapor, applied: next.length });
  }

  function devTimeSync() {
    const now = new Date();
    const utc = now.getTime();
    const iso = now.toISOString();
    // The device accepts a unix timestamp via this path; we also stamp
    // the local clock in the activity log so a missing time-write
    // still shows up in the user's flow.
    appendLog(`Time sync requested: ${iso}`, 'info');
    send('lorax_write', { path: '/u/app/sys/time', value: utc, type: 'uint32' });
    renderDevResult('time_sync', { sent: true, utc_ms: utc, iso });
  }

  function devDabHistoryExport() {
    const history = getDabHistory();
    if (!history.length) {
      renderDevResult('dab_history_export', { error: 'No dab history recorded yet.' });
      return;
    }
    const payload = {
      kind: 'puffco_dab_history',
      version: 1,
      exported_at: new Date().toISOString(),
      count: history.length,
      sessions: history,
    };
    const blob = new Blob([safeJsonStringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `puffco-dab-history-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    renderDevResult('dab_history_export', { ok: true, count: history.length, file: link.download });
  }

  function devBrightnessQuickSet() {
    const pct = numericInput('dev-brightness-pct', 80);
    const clamped = Math.max(1, Math.min(100, Math.round(pct)));
    const sent = setAllBrightnessPercent(clamped);
    renderDevResult('brightness_set', { sent, percent: clamped });
  }

  function devProfileDuplicate() {
    const from = numericInput('dev-profile-dup-from', 0);
    const to = numericInput('dev-profile-dup-to', 0);
    const profiles = Array.isArray(deviceState?.profiles)
      ? applySavedProfileOrder(deviceState.profiles).map((profile, i) => profileWithVapor(profile, i))
      : [];
    if (!profiles.length || from < 0 || to < 0 || from >= profiles.length || to >= profiles.length) {
      renderDevResult('profile_duplicate', { error: 'Bad source/target slot.' });
      return;
    }
    const next = profiles.slice();
    next[to] = { ...next[from], id: next[to]?.id || next[to]?.name, name: next[to]?.name || next[from].name };
    const payload = next.map((profile, slotIndex) => profilePayloadForDevice(profile, slotIndex));
    send('set_profiles', { profiles: payload });
    renderDevResult('profile_duplicate', { ok: true, from, to, hint: `Copied profile ${from + 1} → slot ${to + 1}` });
  }

  // Wipe all puffco:* localStorage keys. Useful when state is wedged
  // or after a major version bump. Keeps the cache/snapshots the
  // user explicitly asked to keep by tag.
  function devResetLocalSettings() {
    const before = { ...localStorage };
    const kept = new Set(['puffco:profile-library']); // user library is sacred
    const removed = [];
    for (const key of Object.keys(before)) {
      if (!key.startsWith('puffco:')) continue;
      if (kept.has(key)) continue;
      try { localStorage.removeItem(key); removed.push(key); }
      catch { /* ignore */ }
    }
    renderDevResult('reset_local_settings', {
      ok: true,
      removed_count: removed.length,
      kept: Array.from(kept),
      hint: 'Reload the page for the wipe to fully apply.',
    });
    toast(`Wiped ${removed.length} local settings`, 'success');
  }

  function devFullSnapshot() {
    const snapshot = {
      connected,
      transport_mode: transportMode,
      device_name: deviceState?.name || null,
      serial: deviceState?.serial || null,
      firmware: deviceState?.firmware || null,
      bootloader: deviceState?.bootloader || null,
      state: deviceState?.state || null,
      heat: deviceState?.heat || null,
      chamber_temp_c: deviceState?.chamber_temp_c ?? null,
      target_temp_c: deviceState?.target_temp_c ?? null,
      battery_pct: deviceState?.battery_pct ?? null,
      battery_volts: deviceState?.battery_volts ?? null,
      profile_count: Array.isArray(deviceState?.profiles) ? deviceState.profiles.length : 0,
      current_profile: deviceState?.current_profile ?? null,
      brightness: deviceState?.brightness ?? null,
      lantern: deviceState?.lantern ?? null,
      stealth: deviceState?.stealth ?? null,
      last_snapshot_at: lastDeviceSnapshot?.received_at || null,
    };
    renderDevResult('full_snapshot', snapshot);
  }

  function devSessionInfo() {
    renderDevResult('session_info', {
      transport: transportMode,
      connected,
      voice_intent: Boolean(voiceIntentRunning),
      voice_listening: Boolean(voiceListening),
      voice_prefix: voicePrefix,
      voice_last_action: voiceLastAction ? { ...voiceLastAction } : null,
      customize_mode: Boolean(customizeMode),
      advanced_user: document.body.classList.contains('advanced-user'),
      theme: document.documentElement.getAttribute('data-theme'),
      accent: document.documentElement.getAttribute('data-accent') || 'teal',
      settings_count: readAllSettingsLocalStorageKeys().length,
      local_storage_bytes: (() => {
        try { return Object.keys(localStorage).reduce((n, k) => n + (localStorage.getItem(k) || '').length, 0); }
        catch { return null; }
      })(),
    });
  }

  // Search the loaded lorax registry by free-text regex, useful when
  // scanning for a path the user half-remembers ("/p/app/htr/...something").
  function devLoraxSearch() {
    const raw = document.getElementById('dev-lorax-search')?.value || '';
    let pattern = raw;
    if (!pattern) { renderDevResult('lorax_search', { error: 'Enter a search pattern.' }); return; }
    let re;
    try { re = new RegExp(pattern, 'i'); }
    catch (err) { renderDevResult('lorax_search', { error: `Invalid regex: ${err.message}` }); return; }
    const matches = (loraxPaths || []).filter((p) =>
      re.test(String(p.path || '')) || re.test(String(p.name || '')) || re.test(String(p.function || ''))
    );
    renderDevResult('lorax_search', { pattern, count: matches.length, sample: matches.slice(0, 25) });
  }

  // Quick "is everything reachable" probe — used by the dev console
  // to confirm the localStorage layer + device snapshot path are
  // alive before running a longer test.
  function devSystemCheck() {
    const checks = [];
    const probe = (label, fn) => {
      const t0 = performance.now();
      try { fn(); checks.push({ label, ok: true, ms: Math.round((performance.now() - t0) * 100) / 100 }); }
      catch (err) { checks.push({ label, ok: false, error: err?.message || String(err) }); }
    };
    probe('localStorage.getItem', () => localStorage.getItem('puffco:theme'));
    probe('localStorage.setItem', () => localStorage.setItem('puffco:system-check', String(Date.now())));
    probe('loraxPaths', () => Array.isArray(loraxPaths));
    probe('deviceState', () => Boolean(deviceState));
    probe('voiceRecognition', () => Boolean(voiceRecognition || voiceSupportConstructor()));
    probe('dabSamples', () => Array.isArray(dabSamples));
    probe('dabHistory', () => Array.isArray(getDabHistory()));
    probe('Sortable', () => typeof Sortable !== 'undefined');
    probe('audioContext', () => Boolean(window.AudioContext || window.webkitAudioContext));
    renderDevResult('system_check', { ok: checks.every((c) => c.ok), checks });
  }

  function readAllSettingsLocalStorageKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith('puffco:')) out.push(k);
      }
    } catch { /* ignore */ }
    return out;
  }

  function voiceSupportConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // ---- Voice prefix (wake word) + intent persistence ----
  //
  // The "prefix" gates voice commands: when set, transcripts only fire
  // a command if the wake word is detected. The remainder of the
  // transcript (after the wake word) is sent to the matcher. The
  // wake word can be anywhere in the transcript, but is stripped
  // before matching so the matcher sees a clean command string.
  //
  // The "intent" remembers whether the user had voice on across
  // page reloads. Browsers require a user gesture to start mic
  // capture, so we can't truly auto-resume — but we can surface
  // a "Voice was on" re-arm prompt that gets the user back to
  // listening with one click.

  function loadVoicePrefix() {
    try {
      const raw = localStorage.getItem(VOICE_PREFIX_KEY);
      if (raw == null) return VOICE_DEFAULT_PREFIX; // default ON with "puffco"
      const trimmed = String(raw).trim();
      return trimmed || ''; // empty string = explicitly disabled
    } catch {
      return VOICE_DEFAULT_PREFIX;
    }
  }

  function getVoicePrefix() {
    return voicePrefix;
  }

  function setVoicePrefix(value) {
    const next = String(value || '').trim();
    voicePrefix = next;
    try {
      if (next) localStorage.setItem(VOICE_PREFIX_KEY, next);
      else localStorage.removeItem(VOICE_PREFIX_KEY);
    } catch { /* ignore quota / private mode */ }
    syncVoicePrefixUI();
    updateVoiceUI();
  }

  function loadVoiceIntent() {
    try { return localStorage.getItem(VOICE_INTENT_KEY) === '1'; }
    catch { return false; }
  }

  function setVoiceIntent(on) {
    try {
      if (on) localStorage.setItem(VOICE_INTENT_KEY, '1');
      else localStorage.removeItem(VOICE_INTENT_KEY);
    } catch { /* ignore */ }
  }

  // True when the user wants voice on and the wake word is set, so
  // the UI can show "Armed · listening for [prefix]" instead of the
  // generic "Listening" state.
  function isVoiceArmed() {
    return voiceIntentRunning && voiceListening && Boolean(voicePrefix);
  }

  // Build a regex that matches the wake word as a whole word, in any
  // position in the transcript. Backslash-escapes any regex specials
  // in the user's prefix so "puff.co" doesn't act as a regex. Returns
  // null when there's no prefix to gate on.
  function voicePrefixRegex() {
    if (!voicePrefix) return null;
    const escaped = voicePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, 'i');
  }

  // Pull the wake word out of the transcript and return the remainder
  // trimmed of leading / trailing filler words ("hey", "ok", "please",
  // "now") so the matcher sees a clean command. Returns null when the
  // transcript doesn't contain the wake word, signalling the caller to
  // ignore the result.
  function stripVoicePrefix(transcript) {
    const regex = voicePrefixRegex();
    if (!regex) return transcript; // no gate configured
    if (!regex.test(transcript)) return null; // wake word not heard
    // Drop the wake word itself, leaving the rest.
    let remainder = transcript.replace(regex, ' ').replace(/\s+/g, ' ').trim();
    // Filler words that the user often trails before a command when
    // using a wake word. Stripped from the front of the remainder so
    // "puffco hey start heat" -> "start heat".
    remainder = remainder.replace(/^(?:hey|ok(?:ay)?|please|now|um+|uh+|erm+)\b[\s,]*/i, '').trim();
    return remainder;
  }

  // Wire the wake-word input to the state. Called from init() and
  // after the DOM is rebuilt. Idempotent: repeated calls just re-sync
  // the input value to the current state.
  function syncVoicePrefixUI() {
    const input = document.getElementById('voice-prefix-input');
    if (!input) return;
    if (document.activeElement !== input) {
      input.value = voicePrefix || '';
    }
    input.placeholder = `Wake word (default: ${VOICE_DEFAULT_PREFIX})`;
    input.classList.toggle('is-active', Boolean(voicePrefix));
  }

  // Show / hide the "Voice was on — click to resume" prompt. Only
  // visible when the user previously had voice on AND the mic
  // permission hasn't been re-granted this session (i.e. we can't
  // auto-restart because of the user-gesture requirement).
  function syncVoiceRearmPrompt() {
    const prompt = document.getElementById('voice-rearm');
    if (!prompt) return;
    const wantsVoice = loadVoiceIntent();
    const canListen = voiceIntentRunning && voiceListening;
    const showPrompt = wantsVoice && !canListen && !voiceIntentRunning;
    prompt.classList.toggle('hidden', !showPrompt);
  }

  function handleVoiceRearmClick() {
    setVoiceIntent(true);
    startVoiceCommands();
  }

  function updateVoiceUI(message = null) {
    const button = document.getElementById('btn-voice');
    const state = document.getElementById('voice-state');
    if (button) button.textContent = voiceIntentRunning ? 'Stop Voice' : 'Enable Voice';
    if (state) {
      // Build a sensible default state label that reflects the wake-word
      // mode. When a prefix is set and we're actually listening, the
      // label says "Listening for [prefix]" so the user knows the
      // system is armed but waiting for the wake word. Transient
      // messages (passed in as `message`) always take precedence.
      let label = null;
      if (!message) {
        if (isVoiceArmed()) label = `Armed · say "${voicePrefix}"`;
        else if (voiceListening) label = 'Listening';
        else if (voicePermissionGranted) label = 'Ready';
        else label = 'Permission required';
      }
      state.textContent = message || label || 'Idle';
      state.classList.toggle('listening', voiceListening);
      state.classList.toggle('armed', isVoiceArmed());
      const dataState = !voicePermissionGranted
        ? 'no-permission'
        : voiceBluetoothPending
          ? 'queued'
          : voiceListening
            ? (voicePrefix ? 'armed' : 'listening')
            : 'idle';
      state.dataset.state = dataState;
    }
    syncVoiceRearmPrompt();
  }

  function setVoiceBluetoothPrompt(visible, message = null) {
    voiceBluetoothPending = Boolean(visible);
    const prompt = document.getElementById('voice-bluetooth-prompt');
    const note = document.getElementById('voice-bluetooth-note');
    if (prompt) prompt.classList.toggle('hidden', !voiceBluetoothPending);
    if (note && message) note.textContent = message;
  }

  function updateVoicePreview(text = null, confidence = null) {
    const heard = document.getElementById('voice-heard-preview');
    const conf = document.getElementById('voice-confidence');
    if (heard && text != null) heard.textContent = `Heard: ${text || '—'}`;
    if (conf && confidence != null) {
      const pct = Number.isFinite(Number(confidence)) ? `${Math.round(Number(confidence) * 100)}%` : '—';
      conf.textContent = `Confidence: ${pct}`;
    }
  }

  function setVoiceTranscript(text, handled = null) {
    const transcript = document.getElementById('voice-transcript');
    if (transcript) {
      const suffix = handled == null ? '' : handled ? ' · sent' : ' · not sent';
      transcript.textContent = `${text || 'No command heard yet'}${suffix}`;
    }
  }

  function updateVoiceMeter(level) {
    const meter = document.querySelector('.voice-meter');
    if (meter) meter.style.setProperty('--voice-level', String(Math.max(0, Math.min(100, Math.round(level)))));
  }

  async function ensureVoiceMic() {
    if (voiceStream) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      updateVoiceUI('Mic API unavailable');
      return false;
    }
    try {
      voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voicePermissionGranted = true;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (AudioContextCtor) {
        voiceAudioContext = new AudioContextCtor();
        const source = voiceAudioContext.createMediaStreamSource(voiceStream);
        voiceAnalyser = voiceAudioContext.createAnalyser();
        voiceAnalyser.fftSize = 512;
        source.connect(voiceAnalyser);
        runVoiceMeter();
      }
      return true;
    } catch (err) {
      voicePermissionGranted = false;
      updateVoiceUI(err?.name === 'NotAllowedError' ? 'Mic permission denied' : 'Mic unavailable');
      setVoiceTranscript(`Mic error: ${err?.message || err}`, false);
      return false;
    }
  }

  function runVoiceMeter() {
    if (!voiceAnalyser) return;
    const samples = new Uint8Array(voiceAnalyser.fftSize);
    const tick = () => {
      if (!voiceListening || !voiceAnalyser) {
        updateVoiceMeter(0);
        return;
      }
      voiceAnalyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = sample - 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      updateVoiceMeter(Math.min(100, rms * 5.6));
      voiceMeterFrame = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(voiceMeterFrame);
    tick();
  }

  function voiceProfileIndex(text) {
    const words = { one: 0, first: 0, blue: 0, two: 1, second: 1, green: 1, three: 2, third: 2, red: 2, four: 3, fourth: 3, gold: 3 };
    const numberMatch = text.match(/\bprofile\s*([1-4])\b/);
    if (numberMatch) return Number(numberMatch[1]) - 1;
    const word = Object.keys(words).find((key) => new RegExp(`\\b(profile\\s+)?${key}\\b`).test(text));
    return word == null ? null : words[word];
  }

  function runVoiceConnect(text) {
    if (connectPending) {
      updateVoiceUI('Chooser already opening');
      setVoiceTranscript(`Heard: ${text}`, true);
      return true;
    }
    if (connected) {
      setVoiceBluetoothPrompt(false);
      updateVoiceUI('Already connected');
      setVoiceTranscript(`Heard: ${text}`, true);
      return true;
    }
    if (transportMode !== 'browser_ble') {
      setTransportMode('browser_ble');
    }
    const hasUserActivation = window.navigator?.userActivation ? window.navigator.userActivation.isActive === true : true;
    if (!hasUserActivation) {
      const message = 'Chrome requires one page tap before it can show Bluetooth devices.';
      setVoiceBluetoothPrompt(true, message);
      updateVoiceUI('Tap Find Device');
      setVoiceTranscript(`Heard: ${text} · find device queued`, true);
      appendLog('Voice queued Find Device; browser requires a trusted tap to open it.', 'warn');
      return true;
    }
    setVoiceBluetoothPrompt(false);
    updateVoiceUI('Finding device');
    setVoiceTranscript('Finding Puffco device', true);
    connectDevice();
    return true;
  }

  function openBluetoothFromVoice() {
    const text = voiceBluetoothPending ? 'queued find device' : 'find device';
    lastVoiceCommandText = '';
    lastVoiceCommandAt = 0;
    updateVoicePreview(text, null);
    return runVoiceConnect(text);
  }

  // ---- Voice command matcher ----
  //
  // Each entry is tried top-to-bottom; the first match wins. Order matters —
  // more specific patterns come first. Each entry exposes:
  //   id, label, icon         — UI metadata for the "last action" chip
  //   match                   — RegExp OR (text) => RegExpMatch|null
  //   run(text, match)        — perform the action; return { ok, detail?, blocked? }
  //
  // Returning { ok: false, blocked: 'why' } from run() surfaces the reason in
  // the transcript without firing the action.
  const VOICE_COMMANDS = [
    {
      id: 'find_device',
      label: 'Find device',
      icon: 'bt',
      match: (text) => (
        /\b(?:find|scan|search)\b.*\b(?:peak|peak\s*pro|puffco|device)\b/.test(text)
        || /\b(?:scan|find|search)\s*(?:devices?|peak|puffco)?\b/.test(text)
      ) ? [text] : null,
      run: (text) => {
        const accepted = runVoiceConnect(text);
        return { ok: accepted, detail: accepted ? 'Find device started' : 'Find device blocked' };
      },
    },
    {
      id: 'disconnect',
      label: 'Disconnect',
      icon: 'bt-off',
      match: /\b(?:disconnect|unpair|forget(?:\s+device)?|drop(?:\s+device)?)\b/,
      run: () => {
        if (!connected) return { ok: false, blocked: 'Not connected' };
        disconnectDevice();
        return { ok: true, detail: 'Disconnect sent' };
      },
    },
    {
      id: 'resync',
      label: 'Resync device',
      icon: 'refresh',
      match: /\b(?:resync|reconnect|re-?sync|refresh(?:\s+ble)?)\b/,
      run: () => {
        resyncDevice();
        return { ok: true, detail: 'Resync requested' };
      },
    },
    {
      // Placed before 'stop' so "stop cleaning" cancels the cleaning
      // cycle (timer + heat) instead of only sending a bare stop.
      id: 'clean',
      label: 'Cleaning mode',
      icon: 'heat',
      match: /\b(?:clean(?:ing)?(?:\s+(?:mode|cycle|the\s+chamber))?|burn[\s-]?off|self[\s-]?clean)\b/,
      run: (text) => {
        if (/\b(stop|cancel|end|abort)\b/.test(text)) {
          stopCleaningMode('Cleaning cancelled');
          return { ok: true, detail: 'Cleaning cancelled' };
        }
        startCleaningMode();
        return { ok: true, detail: `Cleaning ${CLEANING_TEMP_F}°F / ${CLEANING_SECONDS}s` };
      },
    },
    {
      // Dab scoring panel: "score my dab", "dab score", "start scoring",
      // "open scoring", "rate my dab".
      id: 'dab_score',
      label: 'Dab scoring',
      icon: 'status',
      match: /\b(?:score|rate)\b[^.]{0,12}\bdab\b|\bdab\s+scor(?:e|ing)\b|\b(?:open|start|show)\s+scor(?:e|ing)\b/,
      run: () => {
        startDab();
        return { ok: true, detail: 'Scoring panel opened' };
      },
    },
    {
      id: 'stop',
      label: 'Stop heat',
      icon: 'stop',
      match: /\b(?:please\s+)?(?:stop|cancel|end|abort|kill)(?:\s+(?:it|the\s+heat|heat|session|cycle|dab|now))?\b|\bcool\s+(?:it|down)\b|\bthat'?s\s+enough\b/,
      run: () => {
        const sent = stop(true);
        return sent ? { ok: true, detail: 'Stop sent' } : { ok: false, blocked: 'No active heat to stop' };
      },
    },
    {
      id: 'boost',
      label: 'Boost',
      icon: 'boost',
      match: /\bboost(?:\s+it)?\b|\bturn\s+up(?:\s+the)?\s+(?:heat|temp)|\b(?:hotter|more\s+heat|bump\s+it(?:\s+up)?|crank\s+it)\b/,
      run: () => {
        const sent = boost();
        return sent ? { ok: true, detail: 'Boost sent' } : { ok: false, blocked: 'Boost needs active heat' };
      },
    },
    {
      id: 'heat',
      label: 'Start heat',
      icon: 'heat',
      match: /\b(?:start|begin|run|do|fire|initiate)\b[^.]{0,20}\b(?:heat|session|cycle|dab)\b|\bheat\s*(?:it\s*)?up\b|\b(?:get|go)\s+hot\b|\b(?:start|begin|fire)\b\s+(?:it|the)\b|\blight\s+(?:it|her)\s+up\b|\bwarm\s+(?:it\s+)?up\b|\btorch\s+it\b|\bspark\s+it\b|\brip\s+it\b|\blet'?s\s+dab\b|\bsend\s+it\b/,
      run: () => {
        const sent = heat();
        return sent ? { ok: true, detail: 'Heat sent' } : { ok: false, blocked: isHeatActive(deviceState) ? 'Heat already running' : 'Heat unavailable' };
      },
    },
    {
      id: 'battery',
      label: 'Show battery',
      icon: 'battery',
      match: /\b(?:battery(?:\s+level)?|show\s+battery|charge\s+level|how\s+much\s+(?:battery|charge|juice)|power\s+level)\b/,
      run: () => {
        const sent = showBattery();
        return sent ? { ok: true, detail: 'Battery sent' } : { ok: false, blocked: 'Battery readback blocked' };
      },
    },
    {
      id: 'version',
      label: 'Show version',
      icon: 'version',
      match: /\b(?:firmware|version|show\s+version)\b/,
      run: () => {
        const sent = showVersion();
        return sent ? { ok: true, detail: 'Version sent' } : { ok: false, blocked: 'Version readback blocked' };
      },
    },
    {
      id: 'lantern',
      label: 'Toggle lantern',
      icon: 'lantern',
      match: /\blantern\b/,
      run: (text) => {
        const off = /\b(off|disable|disabled)\b/.test(text);
        const on = /\b(on|enable|enabled)\b/.test(text);
        const desired = off ? false : on ? true : !lanternOn;
        const sent = setLanternState(desired);
        return sent
          ? { ok: true, detail: `Lantern ${desired ? 'on' : 'off'}` }
          : { ok: false, blocked: 'Lantern unavailable' };
      },
    },
    {
      id: 'stealth',
      label: 'Toggle stealth',
      icon: 'stealth',
      match: /\bstealth\b/,
      run: (text) => {
        const off = /\b(off|disable|disabled)\b/.test(text);
        const on = /\b(on|enable|enabled)\b/.test(text);
        const desired = off ? false : on ? true : !stealthOn;
        const sent = setStealthState(desired);
        return sent
          ? { ok: true, detail: `Stealth ${desired ? 'on' : 'off'}` }
          : { ok: false, blocked: 'Stealth unavailable' };
      },
    },
    {
      id: 'brightness',
      label: 'Set brightness',
      icon: 'brightness',
      match: (text) => {
        const wordToNumber = { ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
        const direct = text.match(/\b(?:brightness|lights?|leds?)\s*(?:to|at|set\s*to|set\s*at)?\s*(\d{1,3})\s*(?:percent|%)?\b/);
        if (direct) return direct;
        const word = text.match(/\b(?:brightness|lights?|leds?)\s*(?:to|at)?\s*(ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/);
        if (word) {
          return [text, wordToNumber[word[1]], word[0]];
        }
        const phrase = text.match(/\b(?:set|make|put)\s+(?:the\s+)?(?:brightness|lights?|leds?)\s*(?:to|at)?\s*(\d{1,3})\s*(?:percent|%)?\b/);
        if (phrase) return phrase;
        return null;
      },
      run: (text, match) => {
        const percent = match[2] != null ? Number(match[2]) : Number(match[1]);
        if (!Number.isFinite(percent)) return { ok: false, blocked: 'No brightness number heard' };
        const sent = setAllBrightnessPercent(percent);
        const value = Math.max(1, Math.min(100, Math.round(percent)));
        return sent
          ? { ok: true, detail: `Brightness ${value}%` }
          : { ok: false, blocked: 'Brightness blocked' };
      },
    },
    {
      // Relative brightness — "brighter", "dim it", "a little darker".
      // Resolves to a +- step from the current brightness; clamps 5–100.
      id: 'brightness_relative',
      label: 'Brightness relative',
      icon: 'brightness',
      match: /\b(?:brighter|louder|lighter|more\s+light|dim(?:mer)?|darker|less\s+(?:light|bright))\b|\b(?:turn\s+(?:it|the\s+lights?)\s+(?:up|down))\b/,
      run: (text) => {
        const up = /\b(?:brighter|louder|lighter|more\s+light|turn\s+(?:it|the\s+lights?)\s+up)\b/.test(text);
        const cur = Number(deviceState?.brightness) || 80;
        const step = /\b(?:a\s+(?:little|bit)|slightly|marginally)\b/.test(text) ? 5 : 15;
        const next = Math.max(5, Math.min(100, cur + (up ? step : -step)));
        const sent = setAllBrightnessPercent(next);
        return sent
          ? { ok: true, detail: `Brightness ${next}% (${up ? '+' : '-'}${step})` }
          : { ok: false, blocked: 'Brightness blocked' };
      },
    },
    {
      id: 'profile_next',
      label: 'Next profile',
      icon: 'profile',
      match: /\b(?:next|cycle\s+to)\s+profile\b|\bprofile\s+up\b|\bswitch\s+(?:to\s+the\s+)?next\b/,
      run: () => {
        const count = Array.isArray(deviceState?.profiles) ? deviceState.profiles.length : 0;
        if (!count) return { ok: false, blocked: 'No profiles loaded' };
        const cur = Number.isFinite(Number(deviceState?.current_profile)) ? Number(deviceState.current_profile) : 0;
        const next = (cur + 1) % count;
        const sent = selectProfile(next);
        const profile = findProfile(next);
        return sent
          ? { ok: true, detail: profile?.name ? `Profile ${next + 1} · ${profile.name}` : `Profile ${next + 1}` }
          : { ok: false, blocked: 'Profile switch blocked' };
      },
    },
    {
      id: 'profile_prev',
      label: 'Previous profile',
      icon: 'profile',
      match: /\b(?:previous|prev|last)\s+profile\b|\bprofile\s+down\b|\b(?:go\s+)?back\s+a\s+profile\b/,
      run: () => {
        const count = Array.isArray(deviceState?.profiles) ? deviceState.profiles.length : 0;
        if (!count) return { ok: false, blocked: 'No profiles loaded' };
        const cur = Number.isFinite(Number(deviceState?.current_profile)) ? Number(deviceState.current_profile) : 0;
        const prev = (cur - 1 + count) % count;
        const sent = selectProfile(prev);
        const profile = findProfile(prev);
        return sent
          ? { ok: true, detail: profile?.name ? `Profile ${prev + 1} · ${profile.name}` : `Profile ${prev + 1}` }
          : { ok: false, blocked: 'Profile switch blocked' };
      },
    },
    {
      id: 'difficulty',
      label: 'Set dab difficulty',
      icon: 'status',
      match: /\b(?:set\s+)?difficulty\s*(?:to|=|as)?\s*(casual|standard|beast|easy|normal|hard|hardcore)\b|\b(?:casual|standard|beast|easy|normal|hard|hardcore)\s+mode\b/,
      run: (text) => {
        const m = text.match(/\b(casual|standard|beast|easy|normal|hard|hardcore)\b/);
        if (!m) return { ok: false, blocked: 'Difficulty not heard' };
        const word = m[1].toLowerCase();
        const map = { casual: 'casual', easy: 'casual', standard: 'standard', normal: 'standard', beast: 'beast', hard: 'beast', hardcore: 'beast' };
        const next = map[word];
        try { settingsApi.set('dabDifficulty', next); return { ok: true, detail: `Difficulty ${next}` }; }
        catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; }
      },
    },
    {
      id: 'dab_threshold',
      label: 'Set dab threshold',
      icon: 'status',
      match: /\b(?:set\s+)?(?:sensitivity|threshold)\s*(?:to|=|at)?\s*(\d{1,2})\b|\b(?:sensitivity|threshold)\s+(\d{1,2})\s*(?:percent|%)?\b/,
      run: (text) => {
        const m = text.match(/\b(\d{1,2})\b/);
        const n = m ? Number(m[1]) : NaN;
        if (!Number.isFinite(n)) return { ok: false, blocked: 'No threshold number heard' };
        const v = Math.max(1, Math.min(30, Math.round(n)));
        try { settingsApi.set('dabThreshold', v); return { ok: true, detail: `Threshold ${v}%` }; }
        catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; }
      },
    },
    {
      id: 'theme',
      label: 'Set theme',
      icon: 'status',
      match: /\b(?:theme|mode)\s+(?:to\s+|is\s+|=\s*)?(light|dark|auto)\b|\b(?:switch|turn)\s+(?:to\s+)?(light|dark)\s+mode\b|\b(dark|light)\s+mode\b/,
      run: (text) => {
        const m = text.match(/\b(light|dark|auto)\b/);
        if (!m) return { ok: false, blocked: 'Theme not heard' };
        try { settingsApi.set('theme', m[1].toLowerCase()); return { ok: true, detail: `Theme ${m[1]}` }; }
        catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; }
      },
    },
    {
      id: 'auto_arm',
      label: 'Toggle auto-arm',
      icon: 'status',
      match: /\b(?:auto[\s-]?arm|auto[\s-]?open)\s*(?:on|off)?\b|\b(?:toggle|flip)\s+auto[\s-]?arm\b/,
      run: (text) => {
        const want = !/\boff\b/.test(text);
        try { settingsApi.set('dabAutoArm', want); return { ok: true, detail: `Auto-arm ${want ? 'on' : 'off'}` }; }
        catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; }
      },
    },
    {
      id: 'open_settings',
      label: 'Open settings',
      icon: 'status',
      match: /\b(?:open|show|launch|bring\s+up)\s+(?:the\s+)?settings?\b|\bsettings\s+(?:open|please)\b/,
      run: () => { try { openSettingsPanel(); return { ok: true, detail: 'Settings opened' }; } catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; } },
    },
    {
      id: 'close_settings',
      label: 'Close settings',
      icon: 'status',
      match: /\b(?:close|hide|dismiss)\s+(?:the\s+)?settings?\b|\bsettings\s+(?:close|done)\b/,
      run: () => { try { closeSettingsPanel(); return { ok: true, detail: 'Settings closed' }; } catch (e) { return { ok: false, blocked: e?.message || 'Settings blocked' }; } },
    },
    {
      id: 'dab_end',
      label: 'End dab',
      icon: 'status',
      match: /\b(?:end|finish|stop)\s+(?:the\s+|my\s+)?(?:dab|draw|session)\b|\b(?:i\s+)?done\b/,
      run: () => {
        const ok = typeof stopDab === 'function' ? stopDab() : true;
        return ok ? { ok: true, detail: 'Dab ended' } : { ok: false, blocked: 'No active dab' };
      },
    },
    {
      // Color hint — covers the common "change to red" / "set color
      // blue" patterns. Opens the editor with the named color
      // pre-selected so the user can confirm or tweak.
      id: 'profile_color',
      label: 'Set profile color',
      icon: 'profile',
      match: /\b(?:set|change|make|put)\s+(?:the\s+)?(?:profile\s+)?color\s+(?:to\s+)?(red|blue|green|yellow|orange|purple|pink|cyan|white|black|gold|teal|violet|magenta)\b|\bcolor\s+(red|blue|green|yellow|orange|purple|pink|cyan|white|black|gold|teal|violet|magenta)\b/,
      run: (text) => {
        const m = text.match(/\b(red|blue|green|yellow|orange|purple|pink|cyan|white|black|gold|teal|violet|magenta)\b/);
        if (!m) return { ok: false, blocked: 'Color not heard' };
        try {
          editProfile(Number(deviceState?.current_profile) || 0);
          const colorInput = document.getElementById('modal-color');
          if (colorInput) {
            const namedColors = {
              red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308',
              orange: '#f97316', purple: '#a855f7', pink: '#ec4899', cyan: '#06b6d4',
              white: '#f8fafc', black: '#0f172a', gold: '#eab308', teal: '#14b8a6',
              violet: '#8b5cf6', magenta: '#d946ef',
            };
            const hex = namedColors[m[1].toLowerCase()] || '#ef4444';
            colorInput.value = hex;
            colorInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return { ok: true, detail: `Color ${m[1]}` };
        } catch (e) { return { ok: false, blocked: e?.message || 'Color edit blocked' }; }
      },
    },
    {
      id: 'sleep',
      label: 'Sleep',
      icon: 'sleep',
      match: /\b(?:go\s+to\s+sleep|sleep\s+mode|sleep)\b/,
      run: () => {
        const sent = power('sleep');
        return sent ? { ok: true, detail: 'Sleep sent' } : { ok: false, blocked: 'Sleep blocked' };
      },
    },
    {
      id: 'power_off',
      label: 'Power off',
      icon: 'power',
      match: /\b(?:power\s+off|turn\s+(?:the\s+)?(?:device|it)\s+off|shut\s+(?:down|off))\b/,
      run: () => {
        const sent = power('off');
        return sent ? { ok: true, detail: 'Power off sent' } : { ok: false, blocked: 'Power off canceled' };
      },
    },
    {
      id: 'profile',
      label: 'Select profile',
      icon: 'profile',
      match: voiceProfileCommandMatch,
      run: (text, match) => {
        const index = match && match.profileIndex != null ? match.profileIndex : null;
        if (index == null) return { ok: false, blocked: 'Profile not recognized' };
        const sent = selectProfile(index);
        const profile = findProfile(index);
        const label = profile?.name ? `Profile ${index + 1} · ${profile.name}` : `Profile ${index + 1}`;
        return sent
          ? { ok: true, detail: label }
          : { ok: false, blocked: 'Profile switch blocked' };
      },
    },
    {
      id: 'status',
      label: 'Refresh status',
      icon: 'status',
      match: /\b(?:status|state|read\s+state|refresh|sync)\b/,
      run: () => {
        const sent = refreshStatus();
        return sent ? { ok: true, detail: 'Status sent' } : { ok: false, blocked: 'Status blocked' };
      },
    },
  ];

  function voiceProfileCommandMatch(text) {
    // Number words and color hints. Keep this list small so STT errors don't
    // accidentally fire a profile switch.
    const words = { one: 0, first: 0, blue: 0, two: 1, second: 1, green: 1, three: 2, third: 2, red: 2, four: 3, fourth: 3, gold: 3 };
    if (/\bprofile\s*([1-4])\b/.test(text)) {
      const index = Number(/\bprofile\s*([1-4])\b/.exec(text)[1]) - 1;
      return { profileIndex: index, profileMatchType: 'number' };
    }
    const word = Object.keys(words).find((key) => new RegExp(`\\b(profile\\s+)?${key}\\b`).test(text));
    if (word != null) return { profileIndex: words[word], profileMatchType: `word:${word}` };
    // Match against actual device profile names ("profile evening", "select daily").
    const profiles = Array.isArray(deviceState?.profiles) ? deviceState.profiles : [];
    if (!profiles.length) return null;
    const lower = text.replace(/^.*?\b(?:select|switch\s+to|use|go\s+to|set)\s+/, '');
    for (let i = 0; i < profiles.length; i += 1) {
      const name = String(profiles[i]?.name || '').trim().toLowerCase();
      if (!name) continue;
      if (lower.includes(name)) return { profileIndex: i, profileMatchType: `name:${name}` };
    }
    return null;
  }

  function voiceProfileIndex(text) {
    // Legacy helper — kept for any external callers; new code should use the matcher.
    const match = voiceProfileCommandMatch(text);
    return match ? match.profileIndex : null;
  }

  function showVoiceLastAction() {
    const chip = document.getElementById('voice-last-action');
    if (!chip) return;
    cancelAnimationFrame(voiceLastActionFrame);
    const render = () => {
      if (!voiceLastAction) {
        chip.className = 'voice-last-action empty';
        chip.textContent = 'No command sent yet';
        return;
      }
      const ageMs = Date.now() - voiceLastAction.at;
      const ageLabel = ageMs < 1500 ? 'just now'
        : ageMs < 60000 ? `${Math.round(ageMs / 1000)}s ago`
        : `${Math.round(ageMs / 60000)}m ago`;
      chip.className = `voice-last-action ${voiceLastAction.ok ? 'ok' : 'blocked'}`;
      chip.textContent = `Last: ${voiceLastAction.label}${voiceLastAction.detail ? ` · ${voiceLastAction.detail}` : ''} · ${ageLabel}`;
      if (Date.now() - voiceLastAction.at < 60000) {
        voiceLastActionFrame = requestAnimationFrame(render);
      }
    };
    render();
  }

  function recordVoiceAction(command, result) {
    voiceLastAction = {
      id: command.id,
      label: command.label,
      detail: result.detail,
      ok: result.ok,
      at: Date.now(),
    };
    showVoiceLastAction();
  }

  function runVoiceMatcher(text) {
    for (const command of VOICE_COMMANDS) {
      let match;
      try {
        match = typeof command.match === 'function' ? command.match(text) : text.match(command.match);
      } catch {
        match = null;
      }
      if (!match) continue;
      let result;
      try {
        result = command.run(text, match) || {};
      } catch (err) {
        result = { ok: false, blocked: `Error: ${err?.message || err}` };
      }
      if (result.ok === undefined) result.ok = true;
      return { command, text, result };
    }
    return null;
  }

  function handleVoiceCommand(transcript) {
    const raw = String(transcript || '').toLowerCase().trim();
    if (!raw) return false;
    // Wake-word gate. When a prefix is configured, transcripts that
    // don't contain it are ignored — the user hasn't asked for a
    // command. We still update the heard/transcript preview so the
    // user can see the mic is alive; we just don't fire commands.
    const gated = stripVoicePrefix(raw);
    if (gated === null) {
      updateVoicePreview(raw, null);
      setVoiceTranscript(`Heard: ${raw}`, false);
      // The user spoke but didn't say the wake word. Don't log —
      // that would flood the activity log with "Voice heard: …"
      // for every stray word.
      return false;
    }
    // The wake word was heard. Stamp the time so the UI can flash
    // a brief "Puffco:" indicator.
    if (voicePrefix && raw !== gated) voiceWakeFiredAt = Date.now();
    const text = gated;
    if (!text) {
      // Wake word was heard but nothing after it. Surface as a
      // "Puffco: …" prompt so the user knows the wake word was
      // caught and the system is waiting for the rest.
      updateVoicePreview(raw, null);
      setVoiceTranscript(`Heard: ${raw} · say a command`, false);
      updateVoiceUI(`${voicePrefix}?`);
      return false;
    }
    const now = Date.now();
    if (text === lastVoiceCommandText && now - lastVoiceCommandAt < VOICE_DEDUPE_MS) return false;
    lastVoiceCommandText = text;
    lastVoiceCommandAt = now;
    updateVoicePreview(text, null);
    setVoiceTranscript(`Heard: ${text}`);
    appendLog(`Voice heard: ${text}`, 'info');
    const match = runVoiceMatcher(text);
    if (!match) {
      updateVoiceUI('Command not matched');
      setVoiceTranscript(`Heard: ${text}`, false);
      return false;
    }
    const { command, result } = match;
    if (result.ok) {
      updateVoiceUI(result.detail || command.label);
      setVoiceTranscript(`Heard: ${text} · ${command.label}`, true);
    } else {
      updateVoiceUI(result.blocked || `${command.label} blocked`);
      setVoiceTranscript(`Heard: ${text} · ${result.blocked || command.label}`, false);
    }
    recordVoiceAction(command, result);
    // Brief flash on the chip whose data-voice-cmd is the longest substring
    // of the transcript. For "stop heat" → "stop" chip; for direct chip clicks
    // (e.g. "brightness 70") the exact chip matches itself.
    const chips = document.querySelectorAll('#voice-card [data-voice-cmd]');
    let bestChip = null;
    let bestLen = 0;
    for (const candidate of chips) {
      const cmd = candidate.dataset.voiceCmd;
      if (cmd && text.includes(cmd) && cmd.length > bestLen) {
        bestChip = candidate;
        bestLen = cmd.length;
      }
    }
    if (bestChip) {
      bestChip.classList.remove('fired', 'ok', 'blocked');
      // force reflow so the animation re-fires
      void bestChip.offsetWidth;
      bestChip.classList.add('fired', result.ok ? 'ok' : 'blocked');
      setTimeout(() => bestChip.classList.remove('fired', 'ok', 'blocked'), 700);
    }
    return result.ok;
  }

  function testVoiceCommand() {
    const input = document.getElementById('voice-test-command');
    const value = input?.value?.trim();
    if (!value) {
      updateVoiceUI('Enter a command');
      toast('Enter a voice command to test', 'info');
      return false;
    }
    return handleVoiceCommand(value);
  }

  async function startVoiceCommands() {
    const Recognition = voiceSupportConstructor();
    updateVoiceUI('Requesting mic');
    if (!(await ensureVoiceMic())) return;
    voiceIntentRunning = true;
    // Persist intent so a page reload (or new tab) can offer a
    // one-click re-arm prompt. Browsers require a user gesture
    // to start the mic, so we can't auto-resume — but the
    // prompt is one tap away from getting the user back to
    // listening.
    setVoiceIntent(true);
    syncVoiceRearmPrompt();
    if (!Recognition) {
      voiceListening = true;
      runVoiceMeter();
      toast('Mic enabled, but speech-to-text is not supported in this browser', 'warn');
      updateVoiceUI('Mic only');
      setVoiceTranscript('Mic meter is active; use Chrome/Edge for speech-to-text', false);
      return;
    }
    if (!voiceRecognition) {
      voiceRecognition = new Recognition();
      voiceRecognition.continuous = true;
      voiceRecognition.interimResults = true;
      voiceRecognition.lang = 'en-US';
      voiceRecognition.onstart = () => {
        voiceListening = true;
        updateVoiceUI('Listening');
        setVoiceTranscript('Speech recognition started');
      };
      voiceRecognition.onaudiostart = () => updateVoiceUI('Mic active');
      voiceRecognition.onsoundstart = () => updateVoiceUI('Sound detected');
      voiceRecognition.onspeechstart = () => updateVoiceUI('Speech detected');
      voiceRecognition.onspeechend = () => updateVoiceUI('Processing speech');
      voiceRecognition.onresult = (event) => {
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const alternative = result[0];
          const heard = alternative?.transcript;
          if (!heard) continue;
          const confidence = Number.isFinite(Number(alternative?.confidence)) ? Number(alternative.confidence) : null;
          updateVoicePreview(heard.trim(), confidence);
          setVoiceTranscript(`Hearing: ${heard.trim()}`);
          // Final results always run. Interim results are gated by confidence so
          // a low-confidence whisper doesn't fire a "stop" or "boost".
          if (result.isFinal) {
            handleVoiceCommand(heard);
            continue;
          }
          if (confidence != null && confidence >= VOICE_INTERIM_CONFIDENCE) {
            handleVoiceCommand(heard);
          }
        }
      };
      voiceRecognition.onerror = (event) => {
        if (event.error === 'not-allowed') voicePermissionGranted = false;
        setVoiceTranscript(`Speech error: ${event.error}`, false);
        const labels = {
          'not-allowed': 'Speech permission denied',
          'audio-capture': 'No microphone found',
          network: 'Speech network error — using online speech recognition',
          'no-speech': 'No speech heard',
          aborted: 'Speech aborted',
        };
        updateVoiceUI(labels[event.error] || `Speech error: ${event.error}`);
        // 'no-speech' / 'aborted' are routine — keep intent and restart.
        // Permission errors should NOT auto-restart.
        if (event.error === 'not-allowed' || event.error === 'audio-capture') {
          voiceIntentRunning = false;
        }
      };
      voiceRecognition.onend = () => {
        voiceListening = false;
        if (voiceIntentRunning) {
          // Intent is still on, so auto-restart. Use a slightly longer delay
          // when the tab is hidden so we don't fight Chrome's throttling.
          setTimeout(() => {
            if (!voiceIntentRunning) return;
            try { voiceRecognition.start(); } catch {}
          }, document.hidden ? VOICE_RESTART_DELAY_HIDDEN_MS : VOICE_RESTART_DELAY_MS);
        } else {
          updateVoiceUI();
        }
      };
    }
    voicePermissionGranted = true;
    updateVoiceUI('Starting speech');
    runVoiceMeter();
    // Guard against double-start. A fast double-click (or a quick
    // user-toggle that overlaps with the auto-restart setTimeout) can
    // call startVoiceCommands() while a previous start is still in
    // flight or while the engine is already running. speechRecognition.
    // start() throws an InvalidStateError in both cases, and the old
    // catch handler would tear down the entire session — clobbering
    // voiceIntentRunning and forcing the user to re-arm voice. A
    // no-op-start should be a no-op, not a session kill.
    if (voiceListening) return;
    try {
      voiceRecognition.start();
      toast('Voice commands listening', 'success');
    } catch (err) {
      const benignState = /already.started|aborted|InvalidState/i.test(err?.message || String(err));
      if (benignState) {
        updateVoiceUI('Listening');
        return;
      }
      voiceListening = false;
      voiceIntentRunning = false;
      updateVoiceUI('Speech start failed');
      setVoiceTranscript(`Speech start failed: ${err?.message || err}`, false);
      updateVoiceMeter(0);
    }
  }

  function stopVoiceCommands() {
    // Order matters: clear intent FIRST so onend's auto-restart short-circuits.
    voiceIntentRunning = false;
    voiceListening = false;
    // Clear the persisted intent only if the user explicitly stopped.
    // The page-load "Voice was on" prompt reads from this same key.
    setVoiceIntent(false);
    try { voiceRecognition?.stop(); } catch {}
    cancelAnimationFrame(voiceMeterFrame);
    updateVoiceMeter(0);
    updateVoiceUI();
  }

  function toggleVoiceCommands() {
    if (voiceIntentRunning) stopVoiceCommands();
    else startVoiceCommands();
  }

  function devRunLoraxAction() {
    const action = selectValue('dev-lorax-action');
    if (!action) {
      toast('Choose a Lorax action first', 'error');
      return;
    }
    const params = { action };
    const confirmText = document.getElementById('dev-action-confirm')?.value.trim();
    if (confirmText) params.confirm = confirmText;
    const definition = loraxActions?.[action] || {};
    if (definition.dangerous && !params.confirm) {
      toast(`This action requires confirmation: ${definition.confirm || 'WRITE'}`, 'error');
      return;
    }
    send('lorax_action', params);
  }

  function getAccessLabel(access) {
    if (access === 'read') return 'R';
    if (access === 'write') return 'W';
    if (access === 'read_write') return 'RW';
    return access;
  }

  function getAccessClass(access) {
    if (access === 'read') return 'lorax-badge-read';
    if (access === 'write') return 'lorax-badge-write';
    if (access === 'read_write') return 'lorax-badge-rw';
    return '';
  }

  // ---- Init ----

  function initServiceWorker() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        recordBrowserDebug('info', 'App shell service worker ready', { scope: registration.scope });
        registration.update().catch(() => {});
      })
      .catch((err) => {
        recordBrowserDebug('warn', `Service worker registration failed: ${err?.message || err}`);
      });
  }

  // ---- Theme System (Mac-style light / dark / auto) ----

  // Theme key uses the `puffco:*` colon style to match the inline
  // pre-paint script in <head> (index.html line 36). A legacy
  // underscore variant `puffco_theme` was used in earlier builds;
  // readSavedTheme() migrates it once and removes the old key.
  // ---- Full Settings Panel ----
  // Centralised settings store. Persisted to localStorage under puffco:settings.
  // Reads from legacy keys on first boot so existing preferences survive.
  // Exposed as window.app.settings (get / set / getAll / reset).
  const SETTINGS_STORAGE_KEY = 'puffco:settings';
  const SETTINGS_DEFAULTS = {
    // Connection
    deviceName: 'Puffco',
    useMacAddress: false,
    transportMode: null,      // null = use browser-ble default (set at runtime)
    bridgeUrl: '',
    // Display
    theme: 'auto',
    accent: 'teal',
    fontSize: 'medium',        // 'small' | 'medium' | 'large'
    density: 'comfortable',   // 'compact' | 'comfortable' | 'spacious'
    // Behavior
    autoReconnect: true,
    confirmDialogs: true,
    soundEnabled: true,
    voiceEnabled: false,
    // Voice (separate from the puffco:voice-* keys)
    voicePrefix: '',
    // Dab Scoring
    dabEnabled: false,
    dabDifficulty: 'standard',    // 'casual' | 'standard' | 'beast'
    dabThreshold: 12,            // airflow % required to start a dab — raised from 6 to filter preheat noise
    dabAutoArm: true,            // auto-open the preheat view when a heat cycle starts
    dabFastSampler: true,        // 4Hz sensor reads during a live session (browser BLE)
    dabFastSampleMs: 150,        // fast sampler interval (as live as BLE allows)
    dabDropTimeoutMs: 1200,      // below-threshold time that ends the dab
    dabMaxDurationS: 90,         // hard session cap, seconds
    dabUiAirflowMax: 150,        // chart/readout ceiling for raw airflow %
    // Cleaning reminder: after this many qualifying dabs (>5s, no
    // cleaning cycles), the status card counts up to the threshold
    // then prompts the user to run a burn-off. 0 disables the
    // reminder entirely — the status card shows "—".
    cleaningThreshold: 0,
  };

  function getAppSetting(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
      const merged = saved && typeof saved === 'object' ? { ...SETTINGS_DEFAULTS, ...saved } : { ...SETTINGS_DEFAULTS };
      return merged[key];
    } catch {
      return SETTINGS_DEFAULTS[key];
    }
  }

  function setAppSetting(key, value) {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
      const current = (saved && typeof saved === 'object') ? saved : {};
      current[key] = value;
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(current));
    } catch { /* ignore */ }
  }

  function getAllSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null');
      const merged = saved && typeof saved === 'object' ? { ...SETTINGS_DEFAULTS, ...saved } : { ...SETTINGS_DEFAULTS };
      // runtime defaults not stored in the JSON
      if (merged.transportMode === null) {
        merged.transportMode = browserBleSupported() ? 'browser_ble' : 'bridge';
      }
      return merged;
    } catch {
      return { ...SETTINGS_DEFAULTS, transportMode: browserBleSupported() ? 'browser_ble' : 'bridge' };
    }
  }

  function resetAllSettings() {
    try { localStorage.removeItem(SETTINGS_STORAGE_KEY); } catch { /* ignore */ }
    // also wipe legacy keys
    localStorage.removeItem('puffco:voice-prefix');
    localStorage.removeItem('puffco:voice-intent');
    localStorage.removeItem('puffco:advanced-user');
    // re-apply defaults
    applyTheme('auto');
    applyAccent('teal');
    applyFontSize('medium');
    applyDensity('comfortable');
    document.getElementById('advanced-user-toggle')?.removeAttribute('checked');
    setAdvancedUser(false);
    // The customize-layout toggle is a display setting, but it's
    // stored under its own key. Reset it too so "Reset all settings"
    // gives the user the same calm default the page ships with.
    setCustomizeMode(false);
    renderSettingsPanel();
    toast('Settings reset to defaults', 'success');
  }

  function applyFontSize(size) {
    document.documentElement.style.setProperty('--font-size-scale', {
      small: '0.875', medium: '1', large: '1.125',
    }[size] || '1');
    setAppSetting('fontSize', size);
  }

  function applyDensity(density) {
    const valid = ['compact', 'comfortable', 'spacious'].includes(density) ? density : 'comfortable';
    const gap = { compact: '8px', comfortable: '12px', spacious: '20px' }[valid];
    document.documentElement.style.setProperty('--card-gap', gap);
    // A body class drives the rest: card padding, section spacing,
    // control sizes, and type scale all respond (see density rules in
    // style.css), so the setting visibly changes the layout instead of
    // only nudging the grid gap.
    document.body.classList.remove('density-compact', 'density-comfortable', 'density-spacious');
    document.body.classList.add(`density-${valid}`);
    setAppSetting('density', valid);
  }

  function openSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    const backdrop = document.getElementById('settings-backdrop');
    if (!panel) return;
    panel.removeAttribute('inert');
    panel.setAttribute('aria-hidden', 'false');
    panel.classList.add('settings-panel-open');
    if (backdrop) {
      backdrop.classList.add('settings-backdrop-visible');
      backdrop.removeAttribute('inert');
    }
    document.body.style.overflow = 'hidden';
    renderSettingsPanel();
    // focus first interactive element
    panel.querySelector('button, [href], input, select')?.focus();
  }

  function closeSettingsPanel() {
    const panel = document.getElementById('settings-panel');
    const backdrop = document.getElementById('settings-backdrop');
    if (!panel) return;
    panel.setAttribute('inert', '');
    panel.setAttribute('aria-hidden', 'true');
    panel.classList.remove('settings-panel-open');
    if (backdrop) {
      backdrop.classList.remove('settings-backdrop-visible');
      backdrop.setAttribute('inert', '');
    }
    document.body.style.overflow = '';
    document.getElementById('btn-settings')?.focus();
  }

  function renderSettingsPanel() {
    const all = getAllSettings();
    // Connection
    setRadioGroup('settings-transport', all.transportMode || (browserBleSupported() ? 'browser_ble' : 'bridge'));
    document.getElementById('settings-device-name').value = all.deviceName;
    document.getElementById('settings-use-mac').checked = Boolean(all.useMacAddress);
    document.getElementById('settings-bridge-url').value = all.bridgeUrl;

    // Display
    setRadioGroup('settings-theme', all.theme);
    setRadioGroup('settings-accent', all.accent);
    setRadioGroup('settings-font-size', all.fontSize);
    setRadioGroup('settings-density', all.density);
    document.getElementById('advanced-user-toggle').checked = isAdvancedUser();
    // Customize-layout toggle mirrors the live customizeMode state so
    // opening the settings panel after entering customize mode (via
    // the header popover, keyboard shortcut, or a previous session)
    // shows the right checked state.
    const customizeToggle = document.getElementById('settings-customize-mode');
    if (customizeToggle) customizeToggle.checked = Boolean(customizeMode);

    // Behavior
    document.getElementById('settings-auto-reconnect').checked = Boolean(all.autoReconnect);
    document.getElementById('settings-confirm-dialogs').checked = Boolean(all.confirmDialogs);
    document.getElementById('settings-sound').checked = Boolean(all.soundEnabled);
    document.getElementById('settings-voice-enabled').checked = Boolean(all.voiceEnabled);
    document.getElementById('settings-voice-prefix').value = all.voicePrefix || '';

    // Dab Scoring
    document.getElementById('settings-dab-enabled').checked = Boolean(all.dabEnabled);
    setRadioGroup('settings-dab-difficulty', all.dabDifficulty || 'standard');
    document.getElementById('settings-dab-threshold').value = Number(all.dabThreshold || 12);
    document.getElementById('dab-threshold-val').textContent = Number(all.dabThreshold || 12) + '%';
    const setIf = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
    setIf('settings-dab-auto-arm', (el) => { el.checked = all.dabAutoArm !== false; });
    setIf('settings-dab-fast-sampler', (el) => { el.checked = all.dabFastSampler !== false; });
    setIf('settings-dab-fast-ms', (el) => { el.value = Number(all.dabFastSampleMs || 150); });
    setIf('dab-fast-ms-val', (el) => { el.textContent = Number(all.dabFastSampleMs || 150) + 'ms'; });
    setIf('settings-dab-idle-bar-ms', (el) => { el.value = Number(all.dabIdleBarSampleMs || 100); });
    setIf('dab-idle-bar-ms-val', (el) => { el.textContent = Number(all.dabIdleBarSampleMs || 100) + 'ms'; });
    setIf('settings-dab-draw-max', (el) => {
      el.textContent = `${Math.round(dabLearnedMaxPct)} raw = 100%`;
    });
    setIf('settings-dab-drop-timeout', (el) => { el.value = Number(all.dabDropTimeoutMs || 1200); });
    setIf('dab-drop-timeout-val', (el) => { el.textContent = (Number(all.dabDropTimeoutMs || 1200) / 1000).toFixed(1) + 's'; });
    setIf('settings-dab-max-duration', (el) => { el.value = Number(all.dabMaxDurationS || 90); });
    setIf('dab-max-duration-val', (el) => { el.textContent = Number(all.dabMaxDurationS || 90) + 's'; });
    setIf('settings-dab-ui-max', (el) => { el.value = Number(all.dabUiAirflowMax || 150); });
    setIf('dab-ui-max-val', (el) => { el.textContent = Number(all.dabUiAirflowMax || 150) + '%'; });
    setIf('settings-dab-preheat-offset', (el) => {
      el.textContent = `${dabPreheatOffset >= 0 ? '+' : ''}${dabPreheatOffset.toFixed(1)}s learned`;
    });
    setIf('settings-cleaning-threshold', (el) => {
      el.value = Number(all.cleaningThreshold || 0);
    });

    // update accent swatch ring on each swatch
    document.querySelectorAll('.settings-accent-swatch').forEach((btn) => {
      btn.setAttribute('aria-checked', btn.dataset.accent === all.accent ? 'true' : 'false');
    });
  }

  function setRadioGroup(name, value) {
    document.querySelectorAll(`[name="${name}"]`).forEach((input) => {
      const isChecked = input.value === value || (input.dataset?.value === value);
      input.checked = isChecked;
      if (input.classList.contains('theme-option')) {
        input.setAttribute('aria-checked', isChecked ? 'true' : 'false');
      }
    });
  }

  function handleSettingsChange(key, value) {
    setAppSetting(key, value);
    switch (key) {
      case 'theme':
        applyTheme(value);
        break;
      case 'accent':
        applyAccent(value);
        break;
      case 'fontSize':
        applyFontSize(value);
        break;
      case 'density':
        applyDensity(value);
        break;
      case 'deviceName':
        break;
      case 'transportMode':
        setTransportMode(value);
        break;
      case 'bridgeUrl':
        bridgeUrl = normalizeBridgeUrl(value);
        try { localStorage.setItem('puffco_bridge_url', bridgeUrl); } catch { /* ignore */ }
        renderBridgeUI();
        break;
      case 'useMacAddress':
        break;
      case 'autoReconnect':
      case 'confirmDialogs':
      case 'soundEnabled':
        break;
      case 'voiceEnabled':
        break;
      case 'voicePrefix':
        voicePrefix = String(value || '').trim();
        try { localStorage.setItem(VOICE_PREFIX_KEY, voicePrefix); } catch (_) { /* ignore */ }
        break;
      case 'dabEnabled':
        dabSession.setEnabled(Boolean(value));
        break;
      case 'dabDifficulty':
        dabSession.setDifficulty(String(value));
        break;
      case 'dabThreshold':
        dabSession.setThreshold(Number(value));
        break;
      case 'dabAutoArm':
      case 'dabFastSampler':
      case 'dabFastSampleMs':
      case 'dabDropTimeoutMs':
      case 'dabMaxDurationS':
      case 'dabUiAirflowMax':
        applyDabTuning(getAllSettings());
        break;
      case 'cleaningThreshold':
        // Cleaning reminder count re-renders to show the new cap.
        updateCleaningReminder();
        break;
    }
    renderSettingsPanel();
  }

  function exportSettingsJson() {
    const all = getAllSettings();
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `puffco-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Settings exported', 'success');
  }

  function importSettingsJson() {
    const input = document.getElementById('settings-import-file');
    if (!input) return;
    input.click();
  }

  function processSettingsImport(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid format');
        // Validate known keys
        const validKeys = Object.keys(SETTINGS_DEFAULTS);
        const merged = {};
        validKeys.forEach((key) => {
          if (parsed[key] !== undefined) merged[key] = parsed[key];
        });
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
        // Apply
        applyTheme(merged.theme || 'auto');
        applyAccent(merged.accent || 'teal');
        applyFontSize(merged.fontSize || 'medium');
        applyDensity(merged.density || 'comfortable');
        renderSettingsPanel();
        toast('Settings imported — applied', 'success');
      } catch {
        toast('Import failed: invalid JSON', 'error');
      }
    };
    reader.readAsText(file);
  }

  function requireConfirm(message, action) {
    if (!getAppSetting('confirmDialogs')) {
      action();
      return;
    }
    if (confirm(message)) action();
  }

  // Expose settings API
  const settingsApi = {
    get: (key) => {
      const defaults = SETTINGS_DEFAULTS;
      const runtime = { transportMode: browserBleSupported() ? 'browser_ble' : 'bridge' };
      const map = { ...defaults, ...runtime, ...getAllSettings() };
      return map[key];
    },
    set: (key, value) => {
      handleSettingsChange(key, value);
    },
    getAll: () => getAllSettings(),
    reset: () => {
      requireConfirm('Reset all settings to defaults?', resetAllSettings);
    },
  };

  // ---- Theme System ----
  const THEME_STORAGE_KEY = 'puffco:theme';
  const THEME_STORAGE_KEY_LEGACY = 'puffco_theme';
  const ACCENT_STORAGE_KEY = 'puffco_accent';
  const ACCENT_SWATCHES = {
    teal:   { base: '#00d6b4', light: '#0d9488' },
    orange: { base: '#f6a623', light: '#ea580c' },
    violet: { base: '#7c3aed', light: '#7c3aed' },
    pink:   { base: '#f43f5e', light: '#be185d' },
    cyan:   { base: '#38bdf8', light: '#0284c7' },
    gold:   { base: '#f6d365', light: '#b45309' },
  };
  const THEME_OPTIONS = ['light', 'dark', 'auto'];
  const THEME_HINTS = {
    light: 'Light mode is always on.',
    dark: 'Dark mode is always on.',
    auto: 'Auto follows your system theme.',
  };

  function readSavedTheme() {
    try {
      // New key first.
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (THEME_OPTIONS.includes(stored)) return stored;
      // One-time migration from the old underscore key.
      const legacy = localStorage.getItem(THEME_STORAGE_KEY_LEGACY);
      if (THEME_OPTIONS.includes(legacy)) {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, legacy);
          localStorage.removeItem(THEME_STORAGE_KEY_LEGACY);
        } catch { /* ignore quota / private mode */ }
        return legacy;
      }
      return 'auto';
    } catch {
      return 'auto';
    }
  }

  function readSavedAccent() {
    try {
      const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
      return ACCENT_SWATCHES[stored] ? stored : 'teal';
    } catch {
      return 'teal';
    }
  }

  function isAdvancedUser() {
    try {
      return localStorage.getItem(ADVANCED_USER_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setAdvancedUser(enabled) {
    const active = Boolean(enabled);
    try { localStorage.setItem(ADVANCED_USER_KEY, active ? '1' : '0'); } catch { /* ignore */ }
    document.body.classList.toggle('advanced-user', active);
    document.querySelectorAll('[data-advanced-only]').forEach((el) => {
      el.classList.toggle('hidden', !active);
      if (!active && el.id === 'advanced-panel') el.removeAttribute('open');
    });
    const toggle = document.getElementById('advanced-user-toggle');
    if (toggle) toggle.checked = active;
    if (!active && transportMode !== defaultTransportMode()) {
      setTransportMode(defaultTransportMode());
    } else {
      renderBridgeUI();
    }
  }

  function toggleAdvancedUser() {
    setAdvancedUser(Boolean(document.getElementById('advanced-user-toggle')?.checked));
  }

  function applyTheme(theme) {
    const next = THEME_OPTIONS.includes(theme) ? theme : 'auto';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* ignore */ }
    syncThemeUI();
  }

  function applyAccent(accent) {
    if (!ACCENT_SWATCHES[accent]) return;
    const swatch = ACCENT_SWATCHES[accent];
    const style = document.documentElement.style;
    // Apply the swatch as the active accent for both themes. CSS variables
    // --accent-teal-base / --accent-teal-light are read by style.css to
    // override the theme defaults when the user picks a non-default accent.
    style.setProperty('--accent-teal-base', swatch.base);
    style.setProperty('--accent-teal-light', swatch.light);
    style.setProperty('--accent-teal', swatch.base);
    try { localStorage.setItem(ACCENT_STORAGE_KEY, accent); } catch { /* ignore */ }
    syncThemeUI();
  }

  function syncThemeUI() {
    const current = document.documentElement.getAttribute('data-theme') || 'auto';
    document.querySelectorAll('[data-theme-option]').forEach((btn) => {
      const isActive = btn.getAttribute('data-theme-option') === current;
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
    const accent = readSavedAccent();
    document.querySelectorAll('[data-accent]').forEach((btn) => {
      const isActive = btn.getAttribute('data-accent') === accent;
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
    });
    const hint = document.getElementById('theme-popover-hint');
    if (hint) hint.textContent = THEME_HINTS[current] || THEME_HINTS.auto;
    const advancedToggle = document.getElementById('advanced-user-toggle');
    if (advancedToggle) advancedToggle.checked = isAdvancedUser();
  }

  function toggleSettings(forceState) {
    const panel = document.getElementById('settings-panel');
    if (!panel) return; // no full panel on this page
    const isOpen = panel.getAttribute('aria-hidden') === 'false';
    const next = typeof forceState === 'boolean' ? forceState : !isOpen;
    if (next) openSettingsPanel();
    else closeSettingsPanel();
  }

  function initThemeSystem() {
    const theme = readSavedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    applyAccent(readSavedAccent());
    setAdvancedUser(isAdvancedUser());
    // Apply full settings panel defaults
    const fontSize = getAppSetting('fontSize') || 'medium';
    const density = getAppSetting('density') || 'comfortable';
    applyFontSize(fontSize);
    applyDensity(density);
    syncThemeUI();

    // Close settings panel on click-outside (only if panel exists)
    document.addEventListener('click', (event) => {
      const panel = document.getElementById('settings-panel');
      const button = document.getElementById('btn-settings');
      if (!panel || !button) return;
      if (panel.getAttribute('aria-hidden') === 'false'
          && !panel.contains(event.target)
          && !button.contains(event.target)) {
        closeSettingsPanel();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const panel = document.getElementById('settings-panel');
        if (panel && panel.getAttribute('aria-hidden') === 'false') {
          closeSettingsPanel();
        }
      }
    });
    // Settings tab navigation
    document.querySelectorAll('[data-settings-section]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sectionId = btn.dataset.settingsSection;
        document.querySelectorAll('[data-settings-section]').forEach((b) => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
        });
        document.querySelectorAll('.settings-section').forEach((sec) => {
          sec.classList.toggle('hidden', sec.id !== `settings-section-${sectionId}`);
        });
        // Sync theme/accent buttons with current settings
        renderSettingsPanel();
      });
    });
    // Wire import button → file input
    const importBtn = document.getElementById('btn-import-settings');
    const importInput = document.getElementById('settings-import-file');
    if (importBtn && importInput) {
      importBtn.addEventListener('click', () => importInput.click());
      importInput.addEventListener('change', () => {
        if (importInput.files && importInput.files.length) {
          processSettingsImport(importInput.files[0]);
          importInput.value = '';
        }
      });
    }
    if (window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: light)');
      const handler = () => {
        if ((document.documentElement.getAttribute('data-theme') || 'auto') === 'auto') {
          // CSS already handles the swap via @media. Just keep the meta-color in sync.
        }
      };
      if (mql.addEventListener) mql.addEventListener('change', handler);
      else if (mql.addListener) mql.addListener(handler);
    }
  }

  // ---- Round 2 polish: draggable card order with localStorage ----
  // The container (.app-container) is the drop target. Children that
  // carry a data-card-id attribute are the drag handles. We don't
  // re-render the page; we move nodes via insertBefore and write the
  // resulting id list to localStorage. Reset is symmetric and uses
  // a toast (no OS confirm() dialog).

  function getCardOrderContainer() {
    return document.querySelector('.app-container[data-card-order-key]');
  }

  // Captured once at init time, before the saved order is applied,
  // so resetCardOrder can roll the page back to the actual markup
  // default rather than the user's current (possibly-mutated) order.
  let capturedDefaultCardOrder = null;

  function captureDefaultCardOrder() {
    // The markup-defined default lives on the container's
    // data-default-order attribute so it does not depend on the
    // current DOM order (which the pre-paint script may have
    // already rearranged). If the attribute is missing, fall back
    // to a live read — better than nothing.
    const container = getCardOrderContainer();
    if (container) {
      const attr = container.getAttribute('data-default-order');
      if (attr) {
        const ids = attr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (ids.length) {
          capturedDefaultCardOrder = ids.slice();
          return ids;
        }
      }
    }
    if (!container) return [];
    const ids = Array.from(container.children)
      .map((el) => el.getAttribute('data-card-id'))
      .filter(Boolean);
    capturedDefaultCardOrder = ids.slice();
    return ids;
  }

  function readSavedCardOrder() {
    try {
      const raw = localStorage.getItem(CARD_ORDER_KEY);
      if (!raw) return null;
      const order = JSON.parse(raw);
      if (!Array.isArray(order)) return null;
      return order.filter((id) => typeof id === 'string' && id.length);
    } catch (_) {
      return null;
    }
  }

  function writeCardOrder(ids) {
    try {
      localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(ids));
    } catch (_) { /* ignore quota / private mode */ }
  }

  function defaultCardOrder() {
    const container = getCardOrderContainer();
    if (!container) return [];
    return Array.from(container.children)
      .map((el) => el.getAttribute('data-card-id'))
      .filter(Boolean);
  }

  function applyCardOrder(order) {
    const container = getCardOrderContainer();
    if (!container) return;
    if (!Array.isArray(order) || !order.length) return;
    const byId = {};
    Array.from(container.children).forEach((el) => {
      const id = el.getAttribute('data-card-id');
      if (id) byId[id] = el;
    });
    order.forEach((id) => {
      const node = byId[id];
      if (node && node.parentNode === container) {
        container.appendChild(node); // moves existing node
      }
    });
  }

  function persistCardOrderFromDom() {
    const container = getCardOrderContainer();
    if (!container) return;
    const ids = Array.from(container.children)
      .map((el) => el.getAttribute('data-card-id'))
      .filter(Boolean);
    writeCardOrder(ids);
  }

  function flashCardSnap(node) {
    if (!node) return;
    node.classList.remove('flash-snap');
    // Force a reflow so the animation restarts.
    void node.offsetWidth;
    node.classList.add('flash-snap');
    setTimeout(() => node.classList.remove('flash-snap'), CARD_DRAG_INDICATOR_MS);
  }

  function updateCardMoveButtonStates() {
    // No-op: the up/down move buttons were removed (too small, ugly).
    // Kept as a stub so existing call sites don't break.
  }

  function wireCardDragHandlers() {
    const container = getCardOrderContainer();
    if (!container) return;
    if (typeof Sortable === 'undefined') return;
    // Idempotent: if a previous init already wired Sortable on this
    // container, do nothing.
    if (container.__sortableCardInstance) return;
    // Only the elements that carry data-card-id are draggable. The
    // sort guide, header, nav, and other siblings stay put. We use
    // the explicit `.reorder-handle` selector so the user can only
    // pick up a card by its handle — that's how the macOS app
    // organizer behaves and it keeps text selection inside cards
    // working in the default (non-customize) state.
    //
    // The filter is a function (not a CSS selector) so we can also
    // ignore `.reorder-handle` nodes that belong to a NESTED
    // `[data-card-item-list]` inside the card. Without this guard a
    // mousedown on a small item's handle (e.g. a brightness slider)
    // would activate both this card-level Sortable AND the inner
    // item-list Sortable, producing a "phantom" of the entire card
    // following the cursor. The fix: the card-level Sortable only
    // owns handles that are direct children of the card itself; the
    // item-level Sortable owns the rest.
    //
    // The non-handle selectors from the original filter (`.app-header`,
    // `.sort-guide`, `.app-menu`, etc.) are static siblings of the
    // cards inside `.app-container` — they don't carry `data-card-id`
    // so Sortable's `draggable` selector would never match them, but
    // we keep matching them in the filter anyway as a belt-and-braces
    // guard.
    const NON_DRAGGABLE_STATIC_SELECTOR = '.sort-guide, .app-header, .app-menu, .app-footer, script, style';
    const cardLevelFilter = (event, target) => {
      if (event && event.target) {
        // 1) Reject nested item-handle mousedowns so the card-level
        //    Sortable doesn't try to grab the parent card.
        if (typeof event.target.closest === 'function') {
          const handle = event.target.closest('.reorder-handle');
          if (handle && handle.parentElement !== target) return true;
        }
        // 2) Reject clicks on static siblings of the cards.
        if (typeof event.target.matches === 'function' &&
            event.target.matches(NON_DRAGGABLE_STATIC_SELECTOR)) {
          return true;
        }
      }
      return false;
    };
    const instance = Sortable.create(container, {
      animation: 220,
      draggable: '[data-card-id]',
      handle: '.reorder-handle',
      filter: cardLevelFilter,
      preventOnFilter: true,
      ghostClass: 'card-drag-ghost',
      chosenClass: 'card-drag-chosen',
      dragClass: 'card-drag-active',
      forceFallback: true,
      fallbackOnBody: true,
      fallbackTolerance: 4,
      delay: 80,
      delayOnTouchOnly: true,
      touchStartThreshold: 6,
      // Disabled until the user enters customize mode. The handle is
      // hidden in the default state, so the disabled flag is mostly
      // a belt-and-braces guard against programmatic reorders.
      disabled: !customizeMode,
      onStart(evt) {
        container.classList.add('is-dragging');
        document.body.classList.add('sortable-active');
        try { evt.item.setAttribute('data-dragging', 'true'); } catch (_) { /* ignore */ }
      },
      onEnd(evt) {
        container.classList.remove('is-dragging');
        document.body.classList.remove('sortable-active');
        try { evt.item.removeAttribute('data-dragging'); } catch (_) { /* ignore */ }
        // Persist the new order and flash the moved card.
        persistCardOrderFromDom();
        flashCardSnap(evt.item);
        updateCardMoveButtonStates();
        if (typeof announceSortChange === 'function') {
          const names = Array.from(container.children)
            .filter((el) => el.getAttribute && el.getAttribute('data-card-id'))
            .map((el, i) => `${i + 1}. ${el.getAttribute('data-card-id')}`);
          announceSortChange(`Card order updated. ${names.join(', ')}`);
        }
      },
    });
    container.__sortableCardInstance = instance;
  }

  function initCardOrder() {
    // Capture the markup-defined default order BEFORE applying the
    // saved order, so resetCardOrder can restore the original layout.
    captureDefaultCardOrder();
    // Pre-paint script in <head> already applied the saved order.
    // Here we just verify it matches and finish wiring up interactions.
    const saved = readSavedCardOrder();
    if (saved && saved.length) {
      applyCardOrder(saved);
    }
    ensureCardMoveButtons();
    wireCardDragHandlers();
    updateCardMoveButtonStates();
  }

  // Stub: the move-up / move-down buttons were removed because
  // they were too small and visually noisy. The drag handle on the
  // card surface is the only reorder affordance now. Kept as a
  // no-op so init() can still call it without a guard.
  function ensureCardMoveButtons() { /* drag-handle only now */ }

  function resetCardOrder() {
    // No confirm() dialog — show a toast instead and reorder the DOM
    // in place. Reload isn't needed; the source of truth is the DOM.
    // We restore the markup-defined default (captured at init time),
    // not the current (possibly-mutated) order.
    if (resetCardOrder._inFlight) return;
    resetCardOrder._inFlight = true;
    setTimeout(() => { resetCardOrder._inFlight = false; }, 500);
    try { localStorage.removeItem(CARD_ORDER_KEY); } catch (_) { /* ignore */ }
    const container = getCardOrderContainer();
    if (!container) return;
    const defaults = capturedDefaultCardOrder && capturedDefaultCardOrder.length
      ? capturedDefaultCardOrder
      : defaultCardOrder();
    applyCardOrder(defaults);
    persistCardOrderFromDom();
    updateCardMoveButtonStates();
    // Re-show the sort guide so the user knows how the feature works
    // again after a reset.
    showSortGuide();
    if (typeof toast === 'function') {
      toast('Card layout reset to default', 'success');
    }
  }

  // ---- Customize-layout mode ----
  // The mode is the single entry point for reordering anything on the
  // page: cards AND items within cards. Toggling it:
  //   1. Adds the .is-customizing class to <body> (drives jiggle +
  //      dim + handle visibility in CSS).
  //   2. Injects .reorder-handle elements into every card and every
  //      [data-card-item-list] child, so Sortable has something to
  //      attach to.
  //   3. Flips the disabled flag on all registered Sortable instances.
  //   4. Shows/hides the floating "Done" toolbar.
  // Exiting the mode hides the handles and disables Sortable again,
  // restoring the calm default look. Persistence happens on every
  // onEnd of a Sortable, so reloading the page restores both card
  // and item orders.

  function readCustomizeMode() {
    try { return localStorage.getItem(CUSTOMIZE_MODE_KEY) === '1'; }
    catch (_) { return false; }
  }
  function writeCustomizeMode(on) {
    try {
      if (on) localStorage.setItem(CUSTOMIZE_MODE_KEY, '1');
      else localStorage.removeItem(CUSTOMIZE_MODE_KEY);
    } catch (_) { /* ignore */ }
  }

  function setCustomizeMode(on, { persist = true } = {}) {
    customizeMode = Boolean(on);
    document.body.classList.toggle('is-customizing', customizeMode);
    const bar = document.getElementById('customize-bar');
    if (bar) {
      if (customizeMode) bar.removeAttribute('hidden');
      else bar.setAttribute('hidden', '');
    }
    const btn = document.getElementById('btn-customize-layout');
    if (btn) btn.setAttribute('aria-pressed', customizeMode ? 'true' : 'false');
    // Keep the settings-panel toggle in sync with the current mode so
    // both entry points (header popover + Display settings) read the
    // same state. If the user is mid-toggle from the settings panel
    // the change handler already wrote the right value, but a
    // programmatic flip from anywhere should still reflect here.
    const settingsToggle = document.getElementById('settings-customize-mode');
    if (settingsToggle && settingsToggle.checked !== customizeMode) {
      settingsToggle.checked = customizeMode;
    }
    if (customizeMode) {
      injectReorderHandles();
      applyDraggableToStatusItems(true);
    } else {
      removeReorderHandles();
      applyDraggableToStatusItems(false);
    }
    syncAllSortableDisabled();
    if (persist) writeCustomizeMode(customizeMode);
    if (customizeMode && typeof toast === 'function') {
      toast('Customize mode on — drag the handles to rearrange', 'info');
    }
  }

  function toggleCustomizeMode() {
    setCustomizeMode(!customizeMode);
  }

  // Builds a single drag-handle DOM node. The same shape is used for
  // cards and items so the CSS just needs one selector.
  function buildReorderHandle() {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'reorder-handle';
    handle.setAttribute('aria-label', 'Drag to reorder');
    handle.setAttribute('tabindex', '-1');
    handle.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="9" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/>
        <circle cx="15" cy="6" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="15" cy="18" r="1.3"/>
      </svg>
    `;
    return handle;
  }

  function injectReorderHandles() {
    document.querySelectorAll('.app-container [data-card-id]').forEach((el) => {
      if (el.querySelector(':scope > .reorder-handle')) return;
      el.appendChild(buildReorderHandle());
    });
    document.querySelectorAll('[data-card-item-list] > [data-item-id]').forEach((el) => {
      if (el.querySelector(':scope > .reorder-handle')) return;
      el.appendChild(buildReorderHandle());
    });
  }

  function removeReorderHandles() {
    document.querySelectorAll('.reorder-handle').forEach((el) => el.remove());
  }

  function syncAllSortableDisabled() {
    // Mac-home-screen behavior: while customizing, the WHOLE card /
    // item is a drag surface (handle selector dropped), interactive
    // children are made inert via CSS pointer-events, and everything
    // wiggles. Outside customize mode the sortables are disabled and
    // the handle selector is restored as a guard.
    const handleOpt = customizeMode ? null : '.reorder-handle';
    const container = getCardOrderContainer();
    if (container && container.__sortableCardInstance) {
      container.__sortableCardInstance.option('disabled', !customizeMode);
      try { container.__sortableCardInstance.option('handle', handleOpt); } catch (_) { /* older Sortable */ }
    }
    document.querySelectorAll('[data-card-item-list]').forEach((list) => {
      if (list.__sortableItemInstance) {
        list.__sortableItemInstance.option('disabled', !customizeMode);
        try { list.__sortableItemInstance.option('handle', handleOpt); } catch (_) { /* older Sortable */ }
      }
    });
  }

  // ---- Item-list sortables (Brightness, Power, Voice, ...) ----
  // Each container marked with data-card-item-list gets its own
  // Sortable instance, persisted under ITEM_ORDER_KEY_PREFIX + list.
  // The Sortable is created disabled and only enabled when the user
  // enters customize mode, matching the card-level behavior.

  function wireItemSortables() {
    if (typeof Sortable === 'undefined') return;
    document.querySelectorAll('[data-card-item-list]').forEach((list) => {
      // Skip lorax-tabs: uses native HTML5 drag-and-drop instead.
      if (list.id === 'lorax-tabs') return;
      // Skip status-content: uses native HTML5 drag-and-drop instead.
      if (list.id === 'status-content') return;
      if (list.__sortableItemInstance) return;
      const listId = list.getAttribute('data-card-item-list') || list.id || `list-${Math.random().toString(36).slice(2, 8)}`;
      const instance = Sortable.create(list, {
        animation: 180,
        draggable: '[data-item-id]',
        handle: '.reorder-handle',
        filter: 'input, select, textarea, button:not(.reorder-handle)',
        preventOnFilter: true,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 4,
        delay: 80,
        delayOnTouchOnly: true,
        touchStartThreshold: 6,
        disabled: !customizeMode,
        onStart() {
          document.body.classList.add('sortable-active');
        },
        onEnd() {
          document.body.classList.remove('sortable-active');
          persistItemOrder(listId, list);
          flashCardSnap(list);
          if (typeof announceSortChange === 'function') {
            const names = Array.from(list.children)
              .filter((el) => el.getAttribute && el.getAttribute('data-item-id'))
              .map((el, i) => `${i + 1}. ${el.getAttribute('data-item-id')}`);
            announceSortChange(`${listId} updated. ${names.join(', ')}`);
          }
        },
      });
      list.__sortableItemInstance = instance;
      list.__itemListId = listId;
      // Apply the saved order to the DOM if any.
      applyItemOrder(listId, list);
    });
  }

  function itemOrderKey(listId) {
    return `${ITEM_ORDER_KEY_PREFIX}${listId}`;
  }

  function readItemOrder(listId) {
    try {
      const raw = localStorage.getItem(itemOrderKey(listId));
      if (!raw) return null;
      const order = JSON.parse(raw);
      if (!Array.isArray(order)) return null;
      return order.filter((id) => typeof id === 'string' && id.length);
    } catch (_) { return null; }
  }

  function writeItemOrder(listId, ids) {
    try { localStorage.setItem(itemOrderKey(listId), JSON.stringify(ids)); }
    catch (_) { /* ignore */ }
  }

  function applyItemOrder(listId, list) {
    if (!list) return;
    const order = readItemOrder(listId);
    if (!order || !order.length) return;
    const byId = {};
    Array.from(list.children).forEach((el) => {
      const id = el.getAttribute('data-item-id');
      if (id) byId[id] = el;
    });
    order.forEach((id) => {
      const node = byId[id];
      if (node && node.parentNode === list) list.appendChild(node);
    });
  }

  function persistItemOrder(listId, list) {
    const ids = Array.from(list.children)
      .map((el) => el.getAttribute('data-item-id'))
      .filter(Boolean);
    writeItemOrder(listId, ids);
  }

  function resetItemOrders() {
    // The DOM is the source of truth at init time — we re-apply the
    // original markup order by clearing the storage key and forcing
    // a re-init of the lists. Easiest: reload the page so all the
    // saved item orders are ignored and the markup order is back.
    try {
      const prefix = ITEM_ORDER_KEY_PREFIX;
      for (let i = localStorage.length - 1; i >= 0; i -= 1) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) localStorage.removeItem(key);
      }
    } catch (_) { /* ignore */ }
    // Reload to restore markup order for the item lists.
    window.location.reload();
  }

  function resetAllLayouts() {
    // Wipes both card-order and every item-order, then reloads. This
    // is the "factory reset" for layout — used by the floating
    // toolbar's Reset button and the appearance popover's link.
    if (!confirm('Reset all card and item layout to defaults? This will reload the page.')) {
      return;
    }
    try { localStorage.removeItem(CARD_ORDER_KEY); } catch (_) { /* ignore */ }
    try {
      const prefix = ITEM_ORDER_KEY_PREFIX;
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && (key.startsWith(prefix) || key === STATUS_ITEMS_VISIBILITY_KEY || key === STATUS_ITEMS_ORDER_KEY || key === LORAX_TABS_ORDER_KEY)) {
          localStorage.removeItem(key);
        }
      }
    } catch (_) { /* ignore */ }
    if (typeof toast === 'function') toast('Layout reset — restoring defaults', 'info');
    setTimeout(() => window.location.reload(), 350);
  }

  function initCustomizeMode() {
    wireItemSortables();
    initStatusItems();
    wireStatusItemsHtml5Drag();
    initLoraxTabs();
    if (readCustomizeMode()) {
      setCustomizeMode(true, { persist: false });
    } else {
      syncAllSortableDisabled();
    }
  }

  // ---- Status panel info items (toggle + reorder) ----
  // Each item in the status-card has a data-item-id attribute and lives
  // inside #status-content (data-card-item-list="status-items"). Sortable
  // handles drag-to-reorder via the existing wireItemSortables() path.
  // Visibility is separate: each item can be hidden via the eye toggle,
  // and that preference is persisted to localStorage.

  const STATUS_ITEMS_VISIBILITY_KEY = 'puffco:status-items-visibility';
  const STATUS_ITEMS_ORDER_KEY = 'puffco:status-items-order';
  const LORAX_TABS_ORDER_KEY = 'puffco:lorax-tabs-order';

  // Default order of status items (used when no saved order exists).
  const STATUS_ITEMS_DEFAULT_ORDER = [
    'device-stage', 'heat-control', 'battery', 'diagnostics', 'capabilities',
  ];

  // Load visibility state: { [itemId]: true|false }. Defaults to all visible.
  function loadStatusItemsVisibility() {
    try {
      const raw = localStorage.getItem(STATUS_ITEMS_VISIBILITY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* ignore */ }
    return {};
  }

  // Save visibility state to localStorage.
  function saveStatusItemsVisibility(visibility) {
    try {
      localStorage.setItem(STATUS_ITEMS_VISIBILITY_KEY, JSON.stringify(visibility));
    } catch (_) { /* ignore */ }
  }

  // Apply visibility state from localStorage to the DOM on load.
  function applyStatusItemsVisibility() {
    const visibility = loadStatusItemsVisibility();
    const ids = Object.keys(visibility);
    ids.forEach((id) => {
      const el = document.querySelector(`[data-item-id="${id}"]`);
      if (!el) return;
      const isVisible = visibility[id] !== false;
      el.classList.toggle('status-item-hidden', !isVisible);
      // Mark content (non-header children) as hidden so the toggle
      // button inside .status-item-header stays interactive.
      Array.from(el.children).forEach((child) => {
        if (!child.classList.contains('status-item-header')) {
          child.setAttribute('aria-hidden', String(!isVisible));
          if ('inert' in child) child.inert = !isVisible;
        }
      });
      // Update the eye toggle button.
      const btn = document.querySelector(`[data-toggle-btn="${id}"]`);
      if (btn) {
        btn.setAttribute('aria-pressed', String(isVisible));
        const eyeIcon = btn.querySelector('.toggle-eye-icon');
        if (eyeIcon) {
          if (isVisible) {
            eyeIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
          } else {
            eyeIcon.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
          }
        }
      }
    });
  }

  // Toggle visibility of a single status item.
  function toggleStatusItem(itemId) {
    const el = document.querySelector(`[data-item-id="${itemId}"]`);
    if (!el) return;
    const visibility = loadStatusItemsVisibility();
    // Default to visible if not yet stored.
    const currentlyVisible = visibility[itemId] !== false;
    const newVisible = !currentlyVisible;
    visibility[itemId] = newVisible;
    saveStatusItemsVisibility(visibility);
    applyStatusItemsVisibility();
    // Update the popover checkboxes if the popover is open.
    updateStatusItemsPopover();
  }

  // Show or hide the status items popover in the theme popover.
  function toggleStatusItemsPanel() {
    const panel = document.getElementById('status-items-popover');
    if (!panel) return;
    const isHidden = panel.getAttribute('aria-hidden') === 'true';
    if (isHidden) {
      panel.removeAttribute('aria-hidden');
      updateStatusItemsPopover();
    } else {
      panel.setAttribute('aria-hidden', 'true');
    }
  }

  // Build the popover body with toggle checkboxes for each status item.
  function updateStatusItemsPopover() {
    const body = document.getElementById('status-items-popover-body');
    if (!body) return;
    const visibility = loadStatusItemsVisibility();
    const items = document.querySelectorAll('[data-item-id][data-status-item]');
    if (!items.length) return;
    body.innerHTML = Array.from(items).map((el) => {
      const id = el.getAttribute('data-item-id');
      const label = el.getAttribute('data-status-label') || id;
      const isVisible = visibility[id] !== false;
      return `
        <label class="status-item-popover-row">
          <input type="checkbox" ${isVisible ? 'checked' : ''}
                 onchange="app.toggleStatusItem('${escAttr(id)}')"
                 aria-label="Show ${escAttr(label)}" />
          <span>${escHtml(label)}</span>
          <span class="status-item-popover-hint" aria-hidden="true">drag to reorder</span>
        </label>
      `;
    }).join('');
  }

  // Called on DOMContentLoaded to apply saved visibility and order.
  function initStatusItems() {
    applyStatusItemsVisibility();
    applyStatusItemsOrder();
  }

  // ---- Status items: native HTML5 drag-and-drop ----
  // Mirrors the wireLoraxTabsDrag pattern. Each .status-item gets
  // draggable="true" in customize mode and is reordered via native
  // drag events. No Sortable dependency here.

  let _draggingStatusItemId = null;

  function wireStatusItemsHtml5Drag() {
    const container = document.getElementById('status-content');
    if (!container) return;

    container.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.status-item');
      if (!item) return;
      _draggingStatusItemId = item.getAttribute('data-item-id');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', _draggingStatusItemId);
      item.classList.add('status-item-dragging');
      // Use a transparent 1x1 pixel drag image so the native ghost
      // doesn't show a weird empty box on some browsers.
      const ghost = document.createElement('div');
      ghost.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:1px;height:1px;background:transparent;';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 0, 0);
      requestAnimationFrame(() => { ghost.remove(); });
    });

    container.addEventListener('dragend', () => {
      _draggingStatusItemId = null;
      container.querySelectorAll('.status-item-dragging, .status-item-drag-over').forEach((el) => {
        el.classList.remove('status-item-dragging', 'status-item-drag-over');
      });
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const afterEl = getDragAfterElement(container, e.clientY);
      const dragging = container.querySelector('.status-item-dragging');
      if (!dragging) return;
      // Highlight the drop target.
      container.querySelectorAll('.status-item-drag-over').forEach((el) => el.classList.remove('status-item-drag-over'));
      if (afterEl === null) {
        container.appendChild(dragging);
      } else {
        container.insertBefore(dragging, afterEl);
        afterEl.classList.add('status-item-drag-over');
      }
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      persistStatusItemsOrder();
    });

    container.addEventListener('dragenter', (e) => {
      e.preventDefault();
    });
  }

  function applyDraggableToStatusItems(draggable) {
    const container = document.getElementById('status-content');
    if (!container) return;
    container.querySelectorAll('.status-item').forEach((item) => {
      item.setAttribute('draggable', draggable ? 'true' : 'false');
      if (!draggable) item.removeAttribute('draggable');
    });
  }

  function persistStatusItemsOrder() {
    const container = document.getElementById('status-content');
    if (!container) return;
    const order = Array.from(container.children)
      .map((el) => el.getAttribute && el.getAttribute('data-item-id'))
      .filter(Boolean);
    try {
      localStorage.setItem(STATUS_ITEMS_ORDER_KEY, JSON.stringify(order));
    } catch (_) { /* ignore */ }
  }


  // Apply saved status items order from localStorage.
  function applyStatusItemsOrder() {
    let order;
    try {
      const raw = localStorage.getItem(STATUS_ITEMS_ORDER_KEY);
      if (raw) order = JSON.parse(raw);
    } catch (_) { /* ignore */ }
    if (!order || !Array.isArray(order) || !order.length) return;
    const container = document.getElementById('status-content');
    if (!container) return;
    const byId = {};
    Array.from(container.children).forEach((el) => {
      const id = el.getAttribute && el.getAttribute('data-item-id');
      if (id) byId[id] = el;
    });
    order.forEach((id) => {
      const node = byId[id];
      if (node && node.parentNode === container) {
        container.appendChild(node);
      }
    });
  }

  // ---- Advanced panel sections (collapse toggle) ----
  // Each advanced section (#backend-card, etc.) has a .section-collapse-btn
  // in its card-header. The button toggles a .section-collapsed class on
  // the section, collapsing its body while keeping the card visible.

  function toggleAdvancedSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;
    const collapsed = section.classList.toggle('section-collapsed');
    // Update the collapse button icon.
    const btn = section.querySelector('.section-collapse-btn');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
      const icon = btn.querySelector('.collapse-icon');
      if (icon) {
        icon.innerHTML = collapsed
          ? '<polyline points="6 9 12 15 18 9"/>'
          : '<polyline points="18 15 12 9 6 15"/>';
      }
    }
    if (collapsed) {
      section.setAttribute('aria-expanded', 'false');
    } else {
      section.removeAttribute('aria-expanded');
    }
  }

  // ---- Lorax tabs (reorderable tabs) ----
  // The lorax-card has a tab bar (#lorax-tabs) with category tabs.
  // Tabs are reorderable via drag-and-drop and the active tab filters
  // the Lorax path list. Order is persisted to localStorage.

  let currentLoraxTab = 'all';

  function setLoraxTab(tabId) {
    currentLoraxTab = tabId;
    document.querySelectorAll('.lorax-tab').forEach((btn) => {
      const isActive = btn.getAttribute('data-lorax-tab') === tabId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
    // Sync tabs with the existing filter dropdowns and re-filter.
    const categorySelect = document.getElementById('lorax-category-filter');
    const statusSelect = document.getElementById('lorax-status-filter');
    if (tabId === 'all') {
      if (categorySelect) categorySelect.value = 'all';
      if (statusSelect) statusSelect.value = 'all';
    } else if (tabId === 'experimental') {
      // "Experimental" tab shows all experimental-status paths.
      if (categorySelect) categorySelect.value = 'all';
      if (statusSelect) statusSelect.value = 'experimental';
    } else {
      // Named category tabs set the category filter.
      if (categorySelect) categorySelect.value = tabId;
      if (statusSelect) statusSelect.value = 'all';
    }
    // Trigger the existing filterLoraxPaths to apply the tab filter.
    if (typeof filterLoraxPaths === 'function') {
      filterLoraxPaths();
    }
  }

  function initLoraxTabs() {
    applyLoraxTabsOrder();
    // Wire native HTML5 drag-and-drop on the tab bar.
    wireLoraxTabsDrag();
    // Sync the active tab to match the dropdown state on load.
    syncLoraxDropdownToTab();
  }

  // Sync the active tab indicator when the dropdown is changed directly.
  function syncLoraxDropdownToTab() {
    const categorySelect = document.getElementById('lorax-category-filter');
    const statusSelect = document.getElementById('lorax-status-filter');
    if (!categorySelect) return;
    const cat = categorySelect.value;
    const status = statusSelect ? statusSelect.value : 'all';
    let tabId = 'all';
    if (status === 'experimental') {
      tabId = 'experimental';
    } else if (cat !== 'all') {
      tabId = cat;
    }
    currentLoraxTab = tabId;
    document.querySelectorAll('.lorax-tab').forEach((btn) => {
      const isActive = btn.getAttribute('data-lorax-tab') === tabId;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });
  }

  function applyLoraxTabsOrder() {
    let order;
    try {
      const raw = localStorage.getItem(LORAX_TABS_ORDER_KEY);
      if (raw) order = JSON.parse(raw);
    } catch (_) { /* ignore */ }
    if (!order || !Array.isArray(order) || !order.length) return;
    const container = document.getElementById('lorax-tabs');
    if (!container) return;
    const byId = {};
    Array.from(container.children).forEach((el) => {
      const id = el.getAttribute && el.getAttribute('data-item-id');
      if (id) byId[id] = el;
    });
    order.forEach((id) => {
      const node = byId[id];
      if (node && node.parentNode === container) {
        container.appendChild(node);
      }
    });
  }

  // HTML5 native drag-and-drop for Lorax tabs.
  function wireLoraxTabsDrag() {
    const container = document.getElementById('lorax-tabs');
    if (!container) return;

    container.addEventListener('dragstart', (e) => {
      const tab = e.target.closest('[data-item-id]');
      if (!tab) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tab.getAttribute('data-item-id'));
      tab.classList.add('lorax-tab-dragging');
    });

    container.addEventListener('dragend', (e) => {
      const tab = e.target.closest('[data-item-id]');
      if (tab) tab.classList.remove('lorax-tab-dragging');
    });

    container.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const afterEl = getDragAfterElement(container, e.clientX);
      const dragging = container.querySelector('.lorax-tab-dragging');
      if (!dragging) return;
      if (afterEl === null) {
        container.appendChild(dragging);
      } else {
        container.insertBefore(dragging, afterEl);
      }
    });

    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const order = Array.from(container.children)
        .map((el) => el.getAttribute('data-item-id'))
        .filter(Boolean);
      try {
        localStorage.setItem(LORAX_TABS_ORDER_KEY, JSON.stringify(order));
      } catch (_) { /* ignore */ }
    });
  }

  // Helper: determine which element to insert before during drag.
  function getDragAfterElement(container, x) {
    const draggableElements = Array.from(container.querySelectorAll('.lorax-tab:not(.lorax-tab-dragging)'));
    return draggableElements.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element || null;
  }


  // ---- Sort guide banner ----
  // The banner tells the user they can drag cards to reorder. The
  // dismissed state is persisted in localStorage so the tip doesn't
  // come back on every page load once the user has seen it.

  const SORT_GUIDE_KEY = 'puffco:sort-guide-dismissed';

  function isSortGuideDismissed() {
    try { return localStorage.getItem(SORT_GUIDE_KEY) === '1'; }
    catch (_) { return false; }
  }

  function setSortGuideDismissed(value) {
    try {
      if (value) localStorage.setItem(SORT_GUIDE_KEY, '1');
      else localStorage.removeItem(SORT_GUIDE_KEY);
    } catch (_) { /* ignore */ }
  }

  function syncSortGuideVisibility() {
    const el = document.getElementById('sort-guide');
    if (!el) return;
    el.classList.toggle('is-hidden', isSortGuideDismissed());
  }

  function dismissSortGuide() {
    setSortGuideDismissed(true);
    syncSortGuideVisibility();
    if (typeof toast === 'function') {
      toast('Sort guide dismissed — drag the cards any time', 'info');
    }
  }

  function showSortGuide() {
    setSortGuideDismissed(false);
    syncSortGuideVisibility();
  }

  // Polite live region for screen-reader announcements about
  // reordering. Created lazily so the DOM stays clean until the
  // first reorder happens.
  let sortAnnounceRegion = null;
  function ensureSortAnnounceRegion() {
    if (sortAnnounceRegion && document.body.contains(sortAnnounceRegion)) {
      return sortAnnounceRegion;
    }
    const el = document.createElement('div');
    el.id = 'sort-announce';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.cssText = 'position:fixed;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);';
    document.body.appendChild(el);
    sortAnnounceRegion = el;
    return el;
  }
  function announceSortChange(message) {
    const el = ensureSortAnnounceRegion();
    // Toggle textContent to retrigger the live region announcement
    // even when the new value is the same as the old.
    el.textContent = '';
    setTimeout(() => { el.textContent = String(message || ''); }, 30);
  }

  // ---- Round 2 polish: draw-sensor presentation ----
  // The draw-strength panel already exposes --draw-strength and a
  // .active class. We add a small inline chip in the device title
  // row and a glowing ring on the device-stage, both driven from
  // the same data.draw_strength_* fields. The handler is wired
  // for both idle and active heating states (the upstream
  // updateDrawStrengthUI runs on every status message).

  function updateDrawSensorChip(data) {
    const chip = document.getElementById('draw-sensor-chip');
    const label = document.getElementById('draw-sensor-chip-label');
    if (!chip || !label) return;
    if (!data || !data.connected) {
      chip.dataset.state = 'hidden';
      chip.classList.remove('is-live', 'is-unsupported');
      label.textContent = '—';
      return;
    }
    const hasSensor = Boolean(data.draw_strength_source);
    const active = Boolean(data.draw_strength_active || (Number(data.draw_strength_percent) || 0) >= 8);
    const dynamicInhale = data.draw_strength_mode === 'dynamic_inhale' || data.draw_strength_source === '/p/app/htr/inh';
    const count = readDrawSessionCount();
    if (!hasSensor) {
      chip.dataset.state = 'unsupported';
      chip.classList.add('is-unsupported');
      chip.classList.remove('is-live');
      label.textContent = 'Scanning';
    } else {
      chip.dataset.state = active ? 'live' : 'idle';
      chip.classList.add('is-live');
      chip.classList.remove('is-unsupported');
      label.textContent = active
        ? `${data.draw_strength_percent || 0}% ${dynamicInhale ? 'inhale' : 'draw'}`
        : `${dynamicInhale ? 'Inhales' : 'Draws'}: ${count}`;
    }
  }

  function updateDrawSensorRing(data) {
    const stage = document.querySelector('.device-stage');
    if (!stage) return;
    let ring = stage.querySelector('.draw-ring');
    if (!ring) {
      ring = document.createElement('div');
      ring.className = 'draw-ring';
      ring.setAttribute('aria-hidden', 'true');
      stage.appendChild(ring);
    }
    if (!data || !data.connected) {
      ring.style.setProperty('--draw-active', '0');
      ring.classList.remove('is-supported');
      return;
    }
    const hasSensor = Boolean(data.draw_strength_source);
    const active = Boolean(data.draw_strength_active || (Number(data.draw_strength_percent) || 0) >= 8);
    if (hasSensor) {
      ring.classList.add('is-supported');
      ring.style.setProperty('--draw-active', active ? '0.85' : '0.18');
    } else {
      ring.classList.remove('is-supported');
      ring.style.setProperty('--draw-active', '0');
    }
  }

  function readDrawSessionCount() {
    try {
      const raw = localStorage.getItem(DRAW_SESSION_KEY);
      const n = raw == null ? 0 : Number.parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (_) { return 0; }
  }

  function writeDrawSessionCount(n) {
    try { localStorage.setItem(DRAW_SESSION_KEY, String(n)); } catch (_) { /* ignore */ }
  }

  function bumpDrawSessionCount() {
    const next = readDrawSessionCount() + 1;
    writeDrawSessionCount(next);
    return next;
  }

  // Reset the per-session draw counter; surfaced as a small button
  // next to the chip when a draw is active so the user can wipe
  // between sessions without reloading.
  function resetDrawSessionCount() {
    writeDrawSessionCount(0);
  }

  function init() {
    // Restore saved values
    syncShellClasses();
    window.addEventListener('resize', syncShellClasses, { passive: true });
    window.addEventListener('orientationchange', syncShellClasses, { passive: true });
    document.addEventListener('visibilitychange', () => {
      restartBrowserBlePolling();
      // If the user asked voice to be on, restart recognition when the tab
      // becomes visible again. Voice intent (not the engine state) drives this.
      if (voiceIntentRunning && voiceRecognition && !voiceListening) {
        setTimeout(() => {
          if (!voiceIntentRunning) return;
          try { voiceRecognition.start(); } catch {}
        }, document.hidden ? VOICE_MIC_RESTART_DELAY_HIDDEN_MS : VOICE_RESTART_DELAY_MS);
      }
      if (!document.hidden && connected) {
        if (transportMode === 'bridge' && ws?.readyState === WebSocket.OPEN) {
          send('status');
        } else if (transportMode === 'browser_ble') {
          pollBrowserBleStatus();
        }
      }
    });
    restoreBrowserDebugLog();
    const savedName = localStorage.getItem('puffco_device_name');
    const savedMac = localStorage.getItem('puffco_device_mac');
    bridgeUrl = normalizeBridgeUrl(localStorage.getItem('puffco_bridge_url'));
    transportMode = normalizeTransportMode(localStorage.getItem('puffco_transport_mode') || defaultTransportMode());
    initThemeSystem();
    const savedMacMode = localStorage.getItem('puffco_use_mac_address') === '1';
    const macToggle = document.getElementById('use-mac-address');
    if (macToggle) macToggle.checked = savedMacMode;
    if (macToggle) macToggle.addEventListener('change', toggleMacAddressMode);
    const identityInput = document.getElementById('device-name');
    if (identityInput) {
      identityInput.value = savedMacMode ? (savedMac || '') : (savedName || 'Puffco');
    }
    syncIdentityModeUI();
    localMoodPresets = readMoodLibrary();
    updateConnectionUI(false);
    renderBridgeUI();
    renderProfileLibrary();
    updateVoiceUI();
    updateVoicePreview('—', null);
    showVoiceLastAction();

    // Wire the wake-word (voice command prefix) input. The input is
    // plain text — empty means "no prefix" (fire on any command),
    // any other value is the wake word. Persisted on every change.
    syncVoicePrefixUI();
    const prefixInput = document.getElementById('voice-prefix-input');
    if (prefixInput) {
      prefixInput.addEventListener('input', (event) => {
        setVoicePrefix(event.target.value);
      });
    }
    const rearmBtn = document.getElementById('btn-voice-rearm');
    if (rearmBtn) {
      rearmBtn.addEventListener('click', handleVoiceRearmClick);
    }
    // If the user previously had voice on, surface a one-tap
    // re-arm prompt now (browsers require a user gesture for mic
    // access, so we can't auto-resume — but we can be one tap
    // away from listening again).
    if (loadVoiceIntent() && !voiceIntentRunning) {
      syncVoiceRearmPrompt();
    }

    initAppNavigation();
    initLabelTooltips();
    initColorControls();
    syncSortGuideVisibility();
    const profileImport = document.getElementById('profile-import-file');
    if (profileImport) {
      profileImport.addEventListener('change', () => importProfileFile(profileImport.files?.[0]));
    }
    const moodImport = document.getElementById('mood-import-file');
    if (moodImport) {
      moodImport.addEventListener('change', () => importMoodFile(moodImport.files?.[0]));
    }
    const devProfileImport = document.getElementById('dev-profile-import-file');
    if (devProfileImport) {
      devProfileImport.addEventListener('change', () => devProfileImportFile(devProfileImport.files?.[0]));
    }
    // Cleaning-reminder counter: rebuild from history on boot so
    // imported/cleared histories stay in sync, then render. Cheap
    // (a single O(n) pass over localStorage history).
    rebuildCleaningCounterFromHistory();
    updateCleaningReminder();
    if (transportMode === 'bridge') {
      initWebSocket(bridgeUrl);
    } else {
      setBridgeNote('Browser Bluetooth is active. Press Connect to open the browser Bluetooth chooser.', 'online');
      requestLoraxRegistry();
    }
    const advancedPanel = document.getElementById('advanced-panel');
    if (advancedPanel) {
      advancedPanel.addEventListener('toggle', () => {
        if (advancedPanel.open) requestLoraxRegistry();
      });
    }
    // Round 2: draggable card order — runs after DOM is ready and
    // after the pre-paint script in <head> has applied the saved order.
    initCardOrder();
    // Customize-layout mode: wires per-card item-list sortables and
    // restores the saved customize-mode state. This is the entry
    // point for reordering both cards and items within cards.
    initCustomizeMode();
    renderTimer = setInterval(() => {
      if (deviceState) updateHeatLiveUI(deviceState);
    }, 1000);
    initServiceWorker();
    // Dab scoring: restore dab settings and update history summary
    const allSettings = getAllSettings();
    dabEnabled = Boolean(allSettings.dabEnabled);
    dabDifficulty = allSettings.dabDifficulty || 'standard';
    // Default raised from 6 -> 12 so a single preheat pulse of 6%
    // can't kick off a false-positive dab session. Existing localStorage
    // values are left alone — the user can lower the threshold manually
    // if their hardware produces a different noise floor.
    dabThreshold = Number(allSettings.dabThreshold || 12);
    applyDabTuning(allSettings);
    updateDabHistorySummary();
  }

  // Boot
  document.addEventListener('DOMContentLoaded', init);

  // Public API
  return {
    setTransportMode,
    connectBridge,
    toggleBleCapability,
    toggleMacAddressMode,
    connect: connectDevice,
    disconnect: disconnectDevice,
    resyncDevice,
    scanDevices,
    refreshStatus,
    resetCardOrder,
    dismissSortGuide,
    showSortGuide,
    // Customize-layout mode: opt-in drag-and-drop for cards AND items
    // within cards, in the spirit of the macOS app organizer. The
    // appearance popover has a "Customize layout…" button that calls
    // toggleCustomizeMode; resetAllLayouts wipes every saved order
    // (card + per-list item) and reloads the page to the markup
    // default.
    toggleCustomizeMode,
    resetAllLayouts,
    // Status panel info items: toggle visibility + reorder
    toggleStatusItem,
    toggleStatusItemsPanel,
    toggleAdvancedSection,
    // Lorax tabs
    setLoraxTab,
    syncLoraxDropdownToTab,
    resetDrawSessionCount,
    toggleSettings,
    openSettingsPanel,
    closeSettingsPanel,
    renderSettingsPanel,
    // Customize-layout entry points — exposed so the new Settings >
    // Display > "Customize layout" checkbox can drive the same state
    // machine the header popover's "Customize layout…" button uses.
    setCustomizeMode,
    toggleCustomizeMode,
    exportSettingsJson,
    importSettingsJson,
    processSettingsImport,
    settings: settingsApi,
    selectProfile,
    editProfile,
    addNewProfile,
    resetCurrentProfile,
    deleteCurrentProfile,
    closeModal,
    saveProfile,
    exportProfiles,
    openProfileImport,
    saveDeviceProfileToLibrary,
    editLocalProfile,
    duplicateLocalProfile,
    archiveLocalProfile,
    copyLocalProfileToDevice,
    restoreProfileBackup,
    restoreDefaultProfiles,
    toggleLantern,
    toggleStealth,
    applyColorToProfile,
    applyLanternColor,
    setMoodPreset,
    addMoodColor,
    saveMoodPreset,
    deleteMoodPreset,
    exportMoods,
    openMoodImport,
    restoreDefaultMoods,
    applyMoodToProfile,
    applyMoodToLantern,
    applyBrightness,
    updateSliderLabel,
    updateAllBrightness,
    toggleBoostOptions,
    saveBoostOptions,
    toggleVoiceCommands,
    openBluetoothFromVoice,
    toggleAdvancedUser,
    handleVoiceCommand,
    testVoiceCommand,
    setVoicePrefix,
    getVoicePrefix,
    handleVoiceRearmClick,
    heat,
    stop,
    boost,
    startCleaningMode,
    showBattery,
    showVersion,
    power,
    factoryReset,
    clearLog,
    // Lorax Explorer API
    refreshLoraxRegistry,
    filterLoraxPaths,
    selectLoraxPath,
    readSelectedLoraxPath,
    writeSelectedLoraxPath,
    copySelectedLoraxPath,
    useSelectedPathAsTemperatureSource,
    clearDevOutput,
    clearBrowserDebugLog,
    devOfficialAttrs,
    devDrawObserve,
    devDrawClearPin,
    devDrawState,
    devDabState,
    devDabGateTest,
    devDabSynthetic,
    devReadPath,
    devCalibrationState,
    devHeatProbe,
    devHeatObserve,
    devLoraxProbe,
    devLoraxObserve,
    devSetTemperatureSource,
    devClearTemperatureSource,
    devRunLoraxAction,
    // Maxed-out dev deck additions: profile backup/restore, vapor
    // mass-edit, time sync, dab history export, brightness quick-set,
    // profile duplicate, local storage wipe, full snapshot, session
    // info, lorax regex search, system check.
    devProfileExport,
    devProfileImport,
    devProfileImportFile,
    applyImportedProfiles,
    devVaporSetAll,
    devTimeSync,
    devDabHistoryExport,
    devBrightnessQuickSet,
    devProfileDuplicate,
    devResetLocalSettings,
    devSessionInfo,
    devFullSnapshot,
    devLoraxSearch,
    devSystemCheck,
    exportBrowserDebugLog,
    copyBrowserDebugLog,
    downloadBrowserDebugLog,
    getBrowserBle,
    _filterPuffcoScanDevices: filterPuffcoScanDevices,
    _matchesPuffcoManufacturerPrefix: matchesPuffcoManufacturerPrefix,
    // Quick-action path test for the Lorax inspector — verifies
    // heater sensor paths are reachable on the connected hardware.
    testHeaterSensorPaths,
    runLoraxPathTests,
    consumeLoraxTestResponse,
    copyLoraxTestResults,
    redetectDrawStrengthSource,
    clearDrawStrengthPin,
    // Test hook for the draw-sensor wiring (also used by the
    // smoke test in tools/draw_sensor_smoke.js).
    _simulateDrawStrength: (state) => updateDrawStrengthUI(state),
    // Dab Scoring
    startDab,
    stopDab,
    closeDabPanel,
    saveDabScore,
    updateDabHistorySummary,
    resetDabPreheatCalibration,
    resetDabDrawCalibration,
    clearDabHistory,
    // Test-facing entry point for the scorer's per-poll gate. The
    // real pipeline calls this from updateDeviceState; the test hook
    // (window.__puffcoTest.injectDabStatus) drives it via the
    // _updateDeviceStateForTest shim below, which sets the IIFE-scoped
    // `connected` boolean and re-runs dabOnStatus. Underscore-prefixed
    // so callers know it's intended for verification, not user UI.
    _dabOnStatusForTest: dabOnStatus,
    // Test shim: set the IIFE-scoped `connected` flag and replay a
    // partial snapshot through the dab gate. Without this, the
    // headless test hook (injectDabStatus) is a "false promise" —
    // the underlying dabOnStatus early-returns when connected is
    // false, and there's no other way to flip the private boolean.
    // Bypasses the heavy UI re-render path of updateDeviceState
    // (profile library, status card, etc.) so a smoke runner can
    // fire dozens of snapshots per second without thrashing the DOM.
    _updateDeviceStateForTest: (partial) => {
      if (!partial) return null;
      const base = deviceState || {};
      const merged = { ...base, ...partial };
      if (merged.connected !== false) merged.connected = true;
      deviceState = merged;
      lastDeviceSnapshot = merged;
      connected = merged.connected === true;
      if (dabEnabled && connected) dabOnStatus(merged);
      return app._getDabStateForTest();
    },
    // State-inspection hook for headless tests. Returns a snapshot
    // of the IIFE-scoped dab variables so a verifier can assert
    // what the gate actually did (dabState, debounce count, sample
    // count, last state key) without poking into the closure.
    _getDabStateForTest: () => ({
      dabState,
      dabDebounceCount,
      dabSamples: dabSamples.slice(),
      dabLastStateKey,
      dabEnabled,
      connected,
      deviceStateConnected: deviceState?.connected === true,
      deviceStateHeat: deviceState?.heat ?? null,
      deviceStateKey: deviceState ? normalizeStateKey(deviceState.state) : '',
    }),
    // Diagnostic harness for the BLE sensor layer
    startDabDiagnostic: dabStartDiagnostic,
    stopDabDiagnostic: dabStopDiagnostic,
    finishDabDiagnostic: dabFinishDiagnostic,
    downloadDabDiagnosticLog: dabDownloadDiagnosticLog,
  };
})();

window.app = app;
window.puffcoDebug = {
  export: () => app.exportBrowserDebugLog(),
  print: () => console.table(app.exportBrowserDebugLog()),
};

// Lightweight test hook for the draw-sensor wiring. Lets a user
// (or a smoke-test runner) verify the chip + ring + draw panel
// react to draw-strength updates without needing a real device.
// Open devtools and call:
//   __puffcoTest.simulateDraw(80)            // one active inhale
//   __puffcoTest.simulateDraw(0)             // back to idle
//   __puffcoTest.simulateDraw(0, { source: false }) // no source
//   __puffcoTest.simulateDraw(50, { connected: false }) // disconnect
//   __puffcoTest.resetSession()              // zero the counter
//
// Draw-strength path probe (for diagnosing the "static 34% / 42%" bug):
//   __puffcoTest.clearDrawStrengthPin()      // drop the saved pin, re-resolve next snapshot
//   __puffcoTest.redetectDrawStrength()      // drop the pin + run a fresh path probe
//
// Dab scoring harness (no real device required):
//   __puffcoTest.injectDabStatus({ state: 'HEAT_CYCLE_PREHEAT', draw_strength_percent: 25 })
//   __puffcoTest.startDabDiagnostic()  // 30s of simulated samples, then downloads a log
window.__puffcoTest = {
  simulateDraw(percent, overrides = {}) {
    const state = {
      connected: true,
      heat: 'IDLE',
      draw_strength_source: '/p/app/htr/inh',
      draw_strength_percent: percent,
      draw_strength_active: percent >= 8,
      draw_strength_mode: 'dynamic_inhale',
      ...overrides,
    };
    if (overrides.source === false) delete state.draw_strength_source;
    if (overrides.connected === false) state.connected = false;
    try { app._simulateDrawStrength(state); } catch (e) { console.warn('simulateDraw failed:', e); }
  },
  resetSession() {
    try { localStorage.setItem('puffco:draw-session', '0'); } catch (_) {}
    try { app._simulateDrawStrength({ connected: true, heat: 'IDLE', draw_strength_source: '/p/app/htr/inh', draw_strength_percent: 0, draw_strength_active: false, draw_strength_mode: 'dynamic_inhale' }); } catch (_) {}
  },
  clearDrawStrengthPin() {
    try { return app.clearDrawStrengthPin(); } catch (e) { console.warn('clearDrawStrengthPin failed:', e); }
  },
  async redetectDrawStrength() {
    try { return await app.redetectDrawStrengthSource(); } catch (e) { console.warn('redetectDrawStrength failed:', e); return null; }
  },
  // Push a single status payload into the dab scorer. Lets a smoke
  // test exercise the new HEAT_CYCLE_ACTIVE gate without owning a
  // Puffco. partials get merged on top of a connected-IDLE baseline.
  // Returns the post-injection state (dabState, dabDebounceCount,
  // dabSamples length, last state key) so the caller can assert the
  // gate did or didn't fire without poking into the closure.
  injectDabStatus(partial = {}) {
    const base = {
      connected: true,
      heat: 'IDLE',
      state: 'IDLE',
      draw_strength_source: '/p/app/htr/inh',
      draw_strength_percent: 0,
      draw_strength_active: false,
      draw_strength_mode: 'dynamic_inhale',
      current_temperature_f: 0,
      target_temperature_f: 0,
      state_elapsed_time_s: 0,
      state_total_time_s: 30,
    };
    const merged = { ...base, ...partial };
    if (merged.connected !== false) merged.connected = true;
    try {
      // Route through _updateDeviceStateForTest so the IIFE-scoped
      // `connected` flag actually flips. The old path called
      // _dabOnStatusForTest directly, which early-returned on
      // !connected — i.e. the gate was never exercised and the hook
      // was a "false promise".
      if (typeof app._updateDeviceStateForTest === 'function') {
        return app._updateDeviceStateForTest(merged);
      }
      // Older build: fall back to the chip-UI path and warn the
      // operator that the gate is not actually being driven.
      try { app._simulateDrawStrength(merged); } catch (_) {}
      if (typeof app._dabOnStatusForTest === 'function') {
        app._dabOnStatusForTest(merged);
      } else {
        console.warn('__puffcoTest.injectDabStatus: no test entry point; cannot drive scorer');
      }
      return null;
    } catch (e) { console.warn('injectDabStatus failed:', e); return null; }
  },
  // Synthesises a 30-second diagnostic capture without needing a real
  // BLE device. Drives the scorer's diagnostic code path with fake
  // state transitions and airflow ramps so the download can be
  // verified headlessly. Returns the synthetic log so a node-side
  // runner can inspect it.
  startDabDiagnostic(opts = {}) {
    // Open the panel first so the diagnostic view is mounted.
    if (typeof app.startDab !== 'function') return null;
    // Make sure dab scoring is enabled.
    if (typeof app.settings?.set === 'function') {
      try { app.settings.set('dabEnabled', true); } catch (_) {}
    }
    // Flip the IIFE-scoped `connected` flag so dabStartDiagnostic
    // doesn't bail on its "Connect to a device first" toast. The
    // _updateDeviceStateForTest shim handles this; we send a single
    // IDLE snapshot to set up the connection state.
    if (typeof app._updateDeviceStateForTest === 'function') {
      try { app._updateDeviceStateForTest({ connected: true, heat: 'IDLE', state: 'IDLE' }); } catch (_) {}
    } else {
      console.warn('__puffcoTest.startDabDiagnostic: _updateDeviceStateForTest not exposed; diagnostic will not actually run');
    }
    // The diagnostic capture normally lives on the IIFE-scoped
    // `dabDiag` variable. We have no way to read that back from
    // outside the closure, so we install a one-shot hook the scorer
    // calls via app.downloadDabDiagnosticLog / a manual capture.
    // The simplest reliable approach: call the public diagnostic
    // entry, then immediately download at the end of the synthetic
    // burst.
    app.startDabDiagnostic();
    // Build a synthetic data burst and stream it into the live
    // diagnostic by repeatedly calling _updateDeviceStateForTest
    // with a state that progresses IDLE -> PREHEAT -> ACTIVE ->
    // FADE -> IDLE.
    const durationMs = Number(opts.durationMs) || 30000;
    const stepMs = Number(opts.stepMs) || 100;
    const steps = Math.max(1, Math.floor(durationMs / stepMs));
    let i = 0;
    const tick = () => {
      i++;
      const phase = i / steps;
      let state, percent, temp;
      if (phase < 0.1) { state = 'IDLE'; percent = 0; temp = 70; }
      else if (phase < 0.4) { state = 'HEAT_CYCLE_PREHEAT'; percent = 5; temp = 200 + (phase - 0.1) * 800; }
      else if (phase < 0.7) { state = 'HEAT_CYCLE_ACTIVE'; percent = 30 + Math.sin(i / 5) * 10; temp = 420; }
      else if (phase < 0.9) { state = 'HEAT_CYCLE_FADE'; percent = 10; temp = 320; }
      else { state = 'IDLE'; percent = 0; temp = 90; }
      try {
        if (typeof app._updateDeviceStateForTest === 'function') {
          app._updateDeviceStateForTest({
            connected: true,
            heat: state === 'IDLE' ? 'IDLE' : 'HEATING',
            state,
            draw_strength_source: '/p/app/htr/inh',
            draw_strength_percent: percent,
            draw_strength_active: percent >= 8,
            draw_strength_mode: 'dynamic_inhale',
            current_temperature_f: temp,
            target_temperature_f: 420,
            state_elapsed_time_s: i * stepMs / 1000,
            state_total_time_s: 30,
          });
        } else {
          app._simulateDrawStrength({
            connected: true,
            heat: state === 'IDLE' ? 'IDLE' : 'HEATING',
            state,
            draw_strength_source: '/p/app/htr/inh',
            draw_strength_percent: percent,
            draw_strength_active: percent >= 8,
            draw_strength_mode: 'dynamic_inhale',
            current_temperature_f: temp,
            target_temperature_f: 420,
            state_elapsed_time_s: i * stepMs / 1000,
            state_total_time_s: 30,
          });
        }
      } catch (_) {}
      if (i < steps) setTimeout(tick, stepMs);
      else {
        // End the diagnostic immediately so the Save button appears.
        try { app.finishDabDiagnostic(); } catch (_) {}
      }
    };
    setTimeout(tick, stepMs);
    return { started: true, steps, stepMs };
  },
};
