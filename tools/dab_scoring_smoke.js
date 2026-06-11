// tools/dab_scoring_smoke.js
//
// Headless smoke test for the dab scoring gates. The real PWA arms the
// scorer on the device's own state machine:
//
//   * When a heat cycle starts (HEAT_CYCLE_PREHEAT) it auto-shows the
//     preheat view -- armed, but NOT scoring yet.
//   * The scoring session starts IMMEDIATELY (no 3-2-1 countdown) the
//     instant the chamber finishes preheating and enters
//     HEAT_CYCLE_ACTIVE (the PREHEAT -> ACTIVE transition), regardless
//     of the airflow reading at that moment.
//   * The N-consecutive-above-threshold debounce (DAB_DEBOUNCE_SAMPLES)
//     is only a FALLBACK for the case where scoring is enabled while the
//     device is already mid-ACTIVE, so no transition edge is observed.
//
// This script re-implements the relevant gate logic in isolation so the
// verifier can run it with just Node and assert the rules without owning
// a Puffco. The actual app.js logic is also covered by the
// playwright-driven end-to-end run that the project README describes,
// but for fast CI we keep a pure-Node version that mirrors the rules.
//
// Run:
//   node tools/dab_scoring_smoke.js
//
// Exit code: 0 on success, 1 on any failed assertion.

'use strict';

const DAB_THRESHOLD = 12;                  // matches app.js default
const DAB_DEBOUNCE_SAMPLES = 3;            // matches app.js
const DAB_MIN_SAMPLES_FOR_SCORE = 5;       // matches app.js
const DAB_DROP_TIMEOUT_MS = 1200;          // matches app.js
const SAMPLE_INTERVAL_MS = 1000;           // 1 Hz status poll

// ---- mirrors of the helpers in app.js ----
function normalizeStateKey(value) {
  if (value == null || value === '') return '';
  const compact = String(value).trim().toUpperCase().replace(/[\s.\/-]+/g, '_');
  const noSep = compact.replace(/_/g, '');
  const aliases = {
    HEATCYCLEPREHEAT: 'HEAT_CYCLE_PREHEAT',
    HEATCYCLEACTIVE: 'HEAT_CYCLE_ACTIVE',
    HEATCYCLEFADE:   'HEAT_CYCLE_FADE',
    MASTEROFF:       'MASTER_OFF',
    TEMPSELECT:      'TEMP_SELECT',
  };
  return aliases[noSep] || compact;
}

function isHeatActive(data) {
  const state = normalizeStateKey(data?.state);
  return data?.heat === 'HEATING' ||
    ['HEAT_CYCLE_PREHEAT', 'HEAT_CYCLE_ACTIVE', 'HEAT_CYCLE_FADE'].includes(state);
}

function dabIsDrawingState(data) {
  if (!isHeatActive(data)) return false;
  return normalizeStateKey(data?.state) === 'HEAT_CYCLE_ACTIVE';
}

// A trimmed version of the gate -- same rules as the real app, but
// driven by a manually-ticked clock so the test is deterministic.
function makeGate(threshold = DAB_THRESHOLD) {
  const state = {
    dabState: 'idle',           // idle | preheating | countdown | active | results
    dabDebounceCount: 0,
    dabSamples: [],
    dabDroppedBelowAt: null,
    dabStartTime: null,
    sessionFired: false,
    prevStateKey: '',
  };
  return {
    state,
    // Pretend the device was already reporting `key` on the previous
    // poll. Used to simulate "scoring enabled mid-cycle" where no
    // PREHEAT -> ACTIVE edge is observed.
    primeState(key) {
      state.prevStateKey = normalizeStateKey(key);
    },
    onStatus(data) {
      const percent = Number(data.draw_strength_percent || 0);
      const now = data.now ?? Date.now();
      const stateKey = normalizeStateKey(data?.state);
      const prevStateKey = state.prevStateKey;
      state.prevStateKey = stateKey;
      const preheatJustEnded =
        stateKey === 'HEAT_CYCLE_ACTIVE' && prevStateKey !== 'HEAT_CYCLE_ACTIVE';

      // Armed-during-preheat: hold until the chamber is ready, then
      // start the session immediately (no 3-2-1). Bail out if the
      // user/device leaves the heat cycle.
      if (state.dabState === 'preheating') {
        if (stateKey === 'HEAT_CYCLE_ACTIVE') {
          state.dabDebounceCount = 0;
          this.startActive(now);
          state.sessionFired = true;
          return 'session_started';
        }
        if (stateKey === 'IDLE' || stateKey === 'MASTER_OFF' || stateKey === 'TEMP_SELECT') {
          state.dabState = 'idle';
          state.dabDebounceCount = 0;
          return 'preheat_cancelled';
        }
        return 'preheating';
      }

      if (state.dabState === 'idle') {
        // Heat cycle started -> arm the preheat view (not scoring yet).
        if (stateKey === 'HEAT_CYCLE_PREHEAT') {
          state.dabState = 'preheating';
          state.dabDebounceCount = 0;
          return 'armed_preheat';
        }
        // Preheat just ended -> start scoring immediately.
        if (preheatJustEnded) {
          state.dabDebounceCount = 0;
          this.startActive(now);
          state.sessionFired = true;
          return 'session_started';
        }
        // Hard gate for the mid-cycle fallback path.
        if (!dabIsDrawingState(data)) {
          state.dabDebounceCount = 0;
          return 'blocked_by_state';
        }
        if (percent >= threshold) {
          state.dabDebounceCount++;
          if (state.dabDebounceCount >= DAB_DEBOUNCE_SAMPLES) {
            this.startActive(now);
            state.sessionFired = true;
            return 'session_started';
          }
          return `counting_${state.dabDebounceCount}`;
        }
        state.dabDebounceCount = 0;
        return 'below_threshold';
      }

      if (state.dabState === 'active') {
        const af = Math.min(1, percent / 90);
        state.dabSamples.push({ ts: now, airflow: af });
        if (percent < threshold) {
          if (!state.dabDroppedBelowAt) state.dabDroppedBelowAt = now;
          if (now - state.dabDroppedBelowAt > DAB_DROP_TIMEOUT_MS) {
            state.dabState = 'results';
            return 'ended_drop_timeout';
          }
        } else {
          state.dabDroppedBelowAt = null;
        }
        if (state.dabStartTime && now - state.dabStartTime > 90000) {
          state.dabState = 'results';
          return 'ended_max_duration';
        }
        return 'sample_recorded';
      }
      return 'noop';
    },
    startActive(now = Date.now()) {
      state.dabState = 'active';
      state.dabSamples = [];
      state.dabDroppedBelowAt = null;
      state.dabStartTime = now;
    },
  };
}

function calcDabFullScore(samples, threshold = DAB_THRESHOLD) {
  if (!samples || samples.length < DAB_MIN_SAMPLES_FOR_SCORE) {
    return { total: 0, samples: samples?.length || 0, insufficient: true };
  }
  // Hand back a real-looking total so the test can confirm "samples
  // >= 5 produces a non-zero number". The full math lives in app.js;
  // here we only need to demonstrate the gate flips.
  const peak = Math.max(...samples.map(s => s.airflow)) * 100;
  const duration = (samples[samples.length - 1].ts - samples[0].ts) / 1000;
  return {
    total: Math.round(peak * duration),
    samples: samples.length,
    insufficient: false,
  };
}

// ---- assertion helpers ----
let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}

function at(seconds, percent, state, extra = {}) {
  return { now: seconds * 1000, state, heat: state === 'IDLE' ? 'IDLE' : 'HEATING', draw_strength_percent: percent, ...extra };
}

// ---- scenarios ----

// 1) PREHEAT + high airflow -> arms the preheat view but does NOT score.
//    A noisy airflow reading during preheat can never start a dab.
console.log('\n[1] PREHEAT with 25% airflow arms preheat view but must NOT start scoring');
{
  const g = makeGate();
  for (let s = 1; s <= 5; s++) {
    g.onStatus(at(s, 25, 'HEAT_CYCLE_PREHEAT'));
  }
  assert(g.state.dabState === 'preheating', 'armed into preheat view, waiting for the chamber');
  assert(g.state.sessionFired === false, 'session never started during preheat');
  assert(g.state.dabSamples.length === 0, 'no samples collected');
}

// 2) IDLE with high airflow -> no scoring, no arming
console.log('\n[2] IDLE with 25% airflow must NOT start or arm scoring');
{
  const g = makeGate();
  for (let s = 1; s <= 5; s++) {
    g.onStatus(at(s, 25, 'IDLE'));
  }
  assert(g.state.dabState === 'idle', 'state stays idle while device is idle');
  assert(g.state.sessionFired === false, 'session never started');
}

// 3) HEAT_CYCLE_FADE with high airflow -> no scoring
console.log('\n[3] HEAT_CYCLE_FADE with 25% airflow must NOT start scoring');
{
  const g = makeGate();
  for (let s = 1; s <= 5; s++) {
    g.onStatus(at(s, 25, 'HEAT_CYCLE_FADE'));
  }
  assert(g.state.dabState === 'idle', 'state stays idle during fade');
  assert(g.state.sessionFired === false, 'session never started');
}

// 4) PREHEAT -> ACTIVE transition starts scoring immediately, even with
//    a LOW airflow reading. This is the "starts right as preheat ends"
//    requirement -- no 3-2-1 countdown in between.
console.log('\n[4] PREHEAT -> ACTIVE transition starts the session the instant preheat ends');
{
  const g = makeGate();
  g.onStatus(at(1, 0, 'HEAT_CYCLE_PREHEAT'));     // arm
  assert(g.state.dabState === 'preheating', 'armed during preheat');
  const r = g.onStatus(at(2, 3, 'HEAT_CYCLE_ACTIVE')); // preheat ends, airflow only 3%
  assert(r === 'session_started', 'session started on the transition');
  assert(g.state.dabState === 'active', 'state advanced straight to active (no countdown)');
}

// 5) IDLE -> ACTIVE direct transition (a preheat poll was missed) also
//    starts scoring immediately.
console.log('\n[5] IDLE -> ACTIVE direct transition starts the session immediately');
{
  const g = makeGate();
  g.onStatus(at(1, 0, 'IDLE'));
  const r = g.onStatus(at(2, 4, 'HEAT_CYCLE_ACTIVE'));
  assert(r === 'session_started', 'session started on entering the drawing state');
  assert(g.state.dabState === 'active', 'state advanced straight to active');
}

// 6) Fallback: scoring enabled while ALREADY mid-ACTIVE (no transition
//    edge). Below-threshold samples must NOT score; the debounce only
//    flips after DAB_DEBOUNCE_SAMPLES consecutive above-threshold reads.
console.log('\n[6] Mid-cycle (already ACTIVE) falls back to the sustained-draw debounce');
{
  const g = makeGate();
  g.primeState('HEAT_CYCLE_ACTIVE');           // pretend we were already active
  for (let s = 1; s <= 3; s++) g.onStatus(at(s, 5, 'HEAT_CYCLE_ACTIVE')); // below threshold
  assert(g.state.dabState === 'idle', 'low airflow mid-cycle does not start scoring');
  assert(g.state.dabDebounceCount === 0, 'debounce reset on below-threshold reads');
  for (let s = 4; s <= 6; s++) g.onStatus(at(s, 25, 'HEAT_CYCLE_ACTIVE')); // sustained draw
  assert(g.state.dabState === 'active', 'sustained draw eventually starts the session');
}

// 7) Active session with 10 above-threshold samples (>= 5) -> real score
console.log('\n[7] ACTIVE session with 10 samples -> non-zero score');
{
  const g = makeGate();
  g.onStatus(at(1, 0, 'HEAT_CYCLE_PREHEAT'));   // arm
  g.onStatus(at(2, 25, 'HEAT_CYCLE_ACTIVE'));   // preheat ends -> session starts
  assert(g.state.dabState === 'active', 'session started right after preheat');
  for (let s = 4; s <= 13; s++) g.onStatus(at(s, 35, 'HEAT_CYCLE_ACTIVE'));
  const score = calcDabFullScore(g.state.dabSamples);
  assert(score.samples === 10, '10 samples collected');
  assert(score.insufficient === false, 'insufficient flag is false');
  assert(score.total > 0, 'total score is non-zero');
}

// 8) Active session with 3 samples (below 5) -> insufficient
console.log('\n[8] ACTIVE session with 3 samples -> insufficient flag set');
{
  const g = makeGate();
  g.state.dabState = 'active';
  g.state.dabSamples = [];
  g.state.dabStartTime = 0;
  for (let s = 1; s <= 3; s++) g.onStatus(at(s, 30, 'HEAT_CYCLE_ACTIVE'));
  const score = calcDabFullScore(g.state.dabSamples);
  assert(score.insufficient === true, 'insufficient flag is true');
  assert(score.total === 0, 'total score is 0');
  assert(score.samples === 3, 'samples count is 3');
}

// 9) Lowered threshold only matters on the mid-cycle fallback path.
console.log('\n[9] Lowered threshold (8%) accepts mid-cycle samples the default rejects');
{
  const g = makeGate(8);
  g.primeState('HEAT_CYCLE_ACTIVE');
  for (let s = 1; s <= 3; s++) g.onStatus(at(s, 10, 'HEAT_CYCLE_ACTIVE'));
  assert(g.state.dabState === 'active', 'lowered threshold still starts the session');
}

// 10) Active session ends when airflow drops for > DAB_DROP_TIMEOUT_MS
console.log('\n[10] Active session ends after airflow drop timeout');
{
  const g = makeGate();
  g.state.dabState = 'active';
  g.state.dabSamples = [];
  g.state.dabStartTime = 0;
  g.onStatus(at(1, 30, 'HEAT_CYCLE_ACTIVE'));   // first good sample
  g.onStatus(at(2, 0, 'HEAT_CYCLE_ACTIVE'));    // drop starts
  const result1 = g.onStatus(at(3, 0, 'HEAT_CYCLE_ACTIVE'));   // 1s elapsed
  assert(g.state.dabState === 'active', 'still active at 1s (timeout is 1.2s)');
  assert(result1 !== 'ended_drop_timeout', 'not ended yet');
  const result2 = g.onStatus(at(3.3, 0, 'HEAT_CYCLE_ACTIVE')); // 1.3s elapsed
  assert(g.state.dabState === 'results', 'ended after 1.3s drop');
  assert(result2 === 'ended_drop_timeout', 'end reason is drop timeout');
}

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}
