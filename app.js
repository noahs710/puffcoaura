/**
 * Puffco BLE Web Controller — Frontend Application
 * 
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
  let connectPending = false;
  let scanPending = false;
  let editingProfileIndex = null;
  let editingLocalProfileId = null;
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
  // Last executed voice action — surfaced in the UI as a fading chip.
  let voiceLastAction = null;
  let voiceLastActionFrame = null;
  let voiceStream = null;
  let voiceAudioContext = null;
  let voiceAnalyser = null;
  let voiceMeterFrame = null;
  let voiceBluetoothPending = false;
  const browserDebugEvents = [];
  const BROWSER_DEBUG_LIMIT = 300;
  const PROFILE_ORDER_KEY = 'puffco_profile_order';
  const PROFILE_VAPOR_KEY = 'puffco_profile_vapor_presets_v1';
  const LOCAL_PROFILES_KEY = 'puffco_local_profiles';
  const PROFILE_BACKUP_KEY = 'puffco_profile_backups_v1';
  const MOOD_LIBRARY_KEY = 'puffco_mood_library_v1';
  const LAST_CONNECTED_KEY = 'puffco_last_connected';
  const ADVANCED_USER_KEY = 'puffco:advanced-user';
  const PEAK_PRO_MAC_PREFIX = 'F0:AD';
  // Round 2 polish: persisted card reorder. Keyed under puffco:* to
  // match the existing puffco:theme / puffco:accent / puffco_transport_mode
  // style. Read by the inline pre-paint script in <head> and by
  // initCardOrder() in this file. Source of truth for the card list
  // lives in the data-card-id attributes on .app-container children.
  const CARD_ORDER_KEY = 'puffco:card-order';
  const CARD_DRAG_INDICATOR_MS = 180;
  const DRAW_SESSION_KEY = 'puffco:draw-session';
  const VAPOR_PRESETS = [
    { id: 'standard', name: 'Balanced', short: 'Balanced', desc: 'Smooth everyday vapor' },
    { id: 'high', name: 'High Vapor', short: 'High', desc: 'Fuller clouds' },
    { id: 'max', name: 'Max Vapor', short: 'Max', desc: 'Densest pull' },
    { id: 'xl', name: 'XL Vapor', short: 'XL', desc: '3D XL chamber mode' },
  ];
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
      setBridgeNote(`Local bridge scans only Peak Pro manufacturer prefix ${PEAK_PRO_MAC_PREFIX}.`, 'online');
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
    btnScan.classList.toggle('hidden', connected || !scanAvailableInCurrentMode());
    btnScan.disabled = connected || !scanAvailableInCurrentMode() || scanPending;
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
    localStorage.setItem('puffco_transport_mode', transportMode);
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
      setBridgeNote(`Bridge connected: ${url}`, 'online');
      renderBackendMirror();
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
    transportMode = 'bridge';
    localStorage.setItem('puffco_transport_mode', transportMode);
    stopBrowserBlePolling();
    const input = document.getElementById('bridge-url');
    bridgeUrl = normalizeBridgeUrl(input?.value);
    localStorage.setItem('puffco_bridge_url', bridgeUrl);
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
    setTimeout(() => initWebSocket(bridgeUrl), 50);
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
        setVoiceBluetoothPrompt(true, 'Chrome blocked the chooser. Tap Open Chooser while this page is active.');
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
          lastDeviceSnapshot = normalizeDisconnectedPayload(msg.data, msg.message);
          deviceState = null;
          updateConnectionUI(false);
          updateStatusUI(null);
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
        btnScan.textContent = 'Scan';
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
    return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(String(value || '').trim());
  }

  function syncIdentityModeUI() {
    const macMode = usingMacAddress();
    const label = document.getElementById('device-identity-label');
    const input = document.getElementById('device-name');
    if (label) label.textContent = macMode ? 'MAC Address' : 'Device Name';
    if (input) {
      input.placeholder = macMode ? 'F0:AD:4E:00:00:00' : 'Peak';
      input.setAttribute('aria-label', macMode ? 'Device MAC address' : 'Device name');
    }
  }

  function toggleMacAddressMode() {
    const input = document.getElementById('device-name');
    const macMode = usingMacAddress();
    const current = input?.value.trim() || '';
    if (macMode) {
      if (current && !isMacAddressString(current)) localStorage.setItem('puffco_device_name', current);
      if (input) input.value = localStorage.getItem('puffco_device_mac') || '';
    } else {
      if (isMacAddressString(current)) localStorage.setItem('puffco_device_mac', current);
      if (input) input.value = localStorage.getItem('puffco_device_name') || 'Peak';
    }
    localStorage.setItem('puffco_use_mac_address', macMode ? '1' : '0');
    syncIdentityModeUI();
  }

  function currentDeviceIdentity() {
    const value = document.getElementById('device-name')?.value.trim() || '';
    if (usingMacAddress()) {
      return { device: 'Peak', mac: value || undefined, display: value || 'MAC address' };
    }
    return { device: value || 'Peak', mac: undefined, display: value || 'Peak' };
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
    setText('stat-last-connected', lastConnectedLabel());
    setText('stat-charge', chargeLabel);
    updateTelemetryFields(data);
    setText('stat-firmware', data.firmware ?? '—');
    setText('stat-bootloader', data.bootloader ?? '—');
    setText('stat-serial', data.serial ?? '—');
    setText('stat-dpd', labels.dabs_per_day ?? formatDabsPerDay(data.dabs_per_day));
    setText('stat-drem', labels.dabs_left ?? formatMetric(data.dabs_left, 0));
    setText('stat-total-dabs', labels.total_dabs ?? formatMetric(data.total_dabs, 0));
    setText('stat-name', data.name ?? '—');
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

  function updateDrawStrengthUI(data) {
    const panel = document.getElementById('draw-strength-panel');
    const label = document.getElementById('draw-strength-label');
    const source = document.getElementById('draw-strength-source');
    const clearBtn = document.getElementById('btn-draw-clear-source');
    if (!panel || !label || !source) return;
    const percent = data?.connected ? Math.max(0, Math.min(100, Math.round(Number(data.draw_strength_percent) || 0))) : 0;
    const active = Boolean(data?.draw_strength_active || percent >= 8);
    const dynamicInhale = data?.draw_strength_mode === 'dynamic_inhale' || data?.draw_strength_source === '/p/app/htr/inh';
    const wasActive = panel.classList.contains('active');
    panel.style.setProperty('--draw-strength', String(percent));
    panel.classList.toggle('active', active);
    panel.classList.toggle('found', Boolean(data?.draw_strength_source));
    const mapping = data?.draw_strength_source_mapping;
    panel.classList.toggle('pinned', Boolean(mapping && mapping.path));
    // Round 2: surface a "heating" state on the draw panel when the
    // sensor is firing while the chamber is heating, so the panel
    // visually agrees with .heat-live-panel.timer-running.
    if (data?.connected && active && (data.heat === 'HEATING' || data.heat === 'BOOSTING' || data.heat === 'heating' || data.heat === 'boosting')) {
      panel.classList.add('heating');
    } else {
      panel.classList.remove('heating');
    }
    label.textContent = data?.connected ? (active ? `${percent}% ${dynamicInhale ? 'inhale' : 'draw'}` : 'Idle') : 'Disconnected';
    const mode = dynamicInhale
      ? 'dynamic inhale'
      : data?.draw_strength_mode === 'heater_power_proxy'
        ? 'heater power proxy'
        : data?.draw_strength_mode;
    if (data?.draw_strength_source) {
      const pinnedTag = mapping?.path && mapping.path === data.draw_strength_source ? ' · pinned' : '';
      source.textContent = `${mode || 'direct'} · ${data.draw_strength_source}${pinnedTag}`;
    } else if (!data?.connected) {
      source.textContent = 'Connect to scan for an inhale sensor';
    } else if (data.heat === 'HEATING') {
      source.textContent = 'Scanning direct inhale paths during heat';
    } else {
      source.textContent = 'Scanning direct inhale paths';
    }
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', !(mapping && mapping.path));
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

  function rescanDrawStrength() {
    if (!connected) {
      toast('Connect to the device before rescanning dynamic inhale', 'error');
      return;
    }
    const button = document.getElementById('btn-draw-rescan');
    if (button) {
      button.disabled = true;
      button.textContent = 'Scanning…';
    }
    toast('Inhale during the next ~6 s so dynamic inhale can be confirmed', 'info');
    const sent = send('draw_strength_observe', {
      samples: 4,
      interval: 1.5,
      promote: true,
    });
    if (!sent && button) {
      button.disabled = false;
      button.textContent = 'Rescan';
    }
    // The button gets re-enabled on the next status update / observation reply,
    // but in case the server never responds we re-enable it after 10 s.
    setTimeout(() => {
      if (!button) return;
      button.disabled = false;
      button.textContent = 'Rescan';
    }, 10_000);
  }

  function clearDrawStrengthSource() {
    if (!connected) {
      toast('Connect to the device before clearing the inhale pin', 'error');
      return;
    }
    send('draw_strength_source', { clear: true });
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
      card.draggable = true;
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
      card.addEventListener('dragstart', (event) => {
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/profile-index', String(profileIndex));
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      card.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = event.dataTransfer.getData('text/profile-index');
        if (from !== '') reorderProfiles(Number(from), profileIndex);
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
    const payload = {
      index,
      name: profile.name || `Profile ${index}`,
      temp_f: Number(profile.temp_f),
      time_s: Number(profile.time_s),
      vapor: normalizeVaporPreset(profile),
    };
    const mood = normalizeProfileMood(profile);
    if (mood) {
      payload.mood_light = {
        preset: mood.sourcePreset || mood.preset,
        colors: mood.colors,
        tempo_frac: mood.tempoFrac ?? mood.tempo_frac ?? 0.5,
        dynamic_inhale: mood.dynamicInhale ?? mood.dynamic_inhale ?? false,
      };
    }
    return payload;
  }

  function commitDeviceProfileOrder(orderedProfiles, movedIndex) {
    const currentProfile = Number(deviceState?.current_profile);
    const selectedIndex = orderedProfiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === currentProfile);
    const nextProfiles = orderedProfiles.map((profile, slotIndex) => ({
      ...profile,
      vapor: normalizeVaporPreset(profile),
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
      profiles: orderedProfiles.map((profile, slotIndex) => profilePayloadForDevice(profile, slotIndex)),
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
    const aliases = {
      normal: 'standard',
      balanced: 'standard',
      default: 'standard',
      low: 'standard',
      more: 'high',
      boosted: 'high',
      maximum: 'max',
      full: 'max',
      xlarge: 'xl',
      '3d_xl': 'xl',
      xl_vapor: 'xl',
    };
    const id = aliases[value] || value;
    return VAPOR_PRESETS.some((preset) => preset.id === id) ? id : 'standard';
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
    localStorage.setItem(key, JSON.stringify(value));
  }

  function profileVaporDeviceKey() {
    return String(deviceState?.serial || deviceState?.name || 'default-device');
  }

  function readProfileVaporOverrides() {
    const payload = readJsonStorage(PROFILE_VAPOR_KEY, { version: 1, devices: {} });
    return payload && typeof payload === 'object' && payload.devices && typeof payload.devices === 'object'
      ? payload
      : { version: 1, devices: {} };
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

  function profileWithVapor(profile, fallbackIndex = null) {
    if (!profile || typeof profile !== 'object') return profile;
    const index = Number(profile.index ?? fallbackIndex);
    const payload = readProfileVaporOverrides();
    const device = payload.devices?.[profileVaporDeviceKey()] || {};
    const override = Number.isFinite(index) ? device[String(index)] : null;
    return { ...profile, vapor: normalizeVaporPreset(profile.vapor ?? profile.vapor_preset ?? profile.xl_vapor ?? override) };
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
    if (!profile) return;
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
      card.addEventListener('dragstart', (event) => {
        card.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.dataset.localProfileId);
      });
      card.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });
      card.addEventListener('drop', (event) => {
        event.preventDefault();
        const fromId = event.dataTransfer.getData('text/plain');
        const toId = card.dataset.localProfileId;
        reorderLocalProfiles(fromId, toId);
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
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
    const library = readProfileLibrary().profiles.map((profile) => (
      profile.id === id ? { ...profile, archived: true, archived_at: new Date().toISOString() } : profile
    ));
    writeProfileLibrary(library);
    renderProfileLibrary();
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
    document.getElementById('modal-select').checked = false;

    modal?.classList.add('visible');
  }

  function saveLocalProfileFromModal() {
    const library = readProfileLibrary().profiles;
    const index = library.findIndex((profile) => profile.id === editingLocalProfileId);
    if (index < 0) return;
    const name = document.getElementById('modal-name').value.trim() || 'Local profile';
    const temp = parseFloat(document.getElementById('modal-temp').value);
    const time = parseFloat(document.getElementById('modal-time').value);
    const vapor = normalizeVaporPreset(document.getElementById('modal-vapor')?.value);
    const mood = moodParams();
    if (!mood) return;
    const profile = {
      ...library[index],
      name,
      temp_f: temp,
      time_s: time,
      vapor,
      color: null,
      mood: normalizeProfileMood({ mood }),
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
    const params = {
      index,
      name: profile.name,
      temp_f: Number(profile.temp_f),
      time_s: Number(profile.time_s),
      vapor: normalizeVaporPreset(profile),
    };
    const mood = normalizeProfileMood(profile);
    if (mood) {
      params.mood_light = {
        preset: mood.sourcePreset || mood.preset,
        colors: mood.colors,
        tempo_frac: mood.tempoFrac ?? mood.tempo_frac ?? 0.5,
        dynamic_inhale: mood.dynamicInhale ?? mood.dynamic_inhale ?? false,
      };
    }
    writeProfileVaporOverride(index, params.vapor);
    send('set_profile', params);
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
    try {
      localStorage.removeItem(PROFILE_ORDER_KEY);
    } catch {}
    if (deviceState?.profiles) updateProfilesUI(deviceState.profiles, deviceState.current_profile);
    toast('Local profile order reset', 'success');
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
    const modalHex = document.getElementById('modal-hex');
    if (modalColor && modalHex) {
      modalColor.addEventListener('input', () => {
        modalHex.value = modalColor.value.toUpperCase();
      });
      modalHex.addEventListener('input', () => {
        let val = modalHex.value.trim();
        if (!val.startsWith('#')) val = '#' + val;
        if (/^#[0-9a-fA-F]{6}$/.test(val)) {
          modalColor.value = val;
        }
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
    const preview = document.getElementById('color-preview');
    if (wheel) wheel.value = color;
    if (hexInput) hexInput.value = color.toUpperCase();
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
      slot.addEventListener('dragstart', (event) => {
        slot.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/mood-color-index', String(index));
      });
      slot.addEventListener('dragend', () => slot.classList.remove('dragging'));
      slot.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      });
      slot.addEventListener('drop', (event) => {
        event.preventDefault();
        const from = Number(event.dataTransfer.getData('text/mood-color-index'));
        if (!Number.isInteger(from) || from === index) return;
        const [moved] = moodEditor.colors.splice(from, 1);
        moodEditor.colors.splice(index, 0, moved);
        syncPickerToMoodColor();
        renderMoodColors();
        renderModalSummary();
      });
      wrap.appendChild(slot);
    });

    const add = document.getElementById('mood-add-color');
    if (add) {
      add.disabled = moodEditor.colors.length >= preset.max;
      add.textContent = `Add color (${moodEditor.colors.length}/${preset.max})`;
    }
    const range = document.getElementById('mood-color-range');
    if (range) range.textContent = `${preset.min}-${preset.max} colors`;
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
    if (!profile) return;

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
    document.getElementById('modal-select').checked = false;

    document.getElementById('profile-modal').classList.add('visible');
  }

  function findProfile(index) {
    const profiles = Array.isArray(deviceState?.profiles) ? deviceState.profiles : [];
    const fallback = profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(index));
    return fallback >= 0 ? profileWithVapor(profiles[fallback], fallback) : null;
  }

  function closeModal() {
    const modal = document.getElementById('profile-modal');
    modal?.classList.remove('visible');
    modal?.classList.remove('local-profile-edit');
    editingProfileIndex = null;
    editingLocalProfileId = null;
  }

  function saveProfile(forceSelect = false) {
    if (editingLocalProfileId) {
      saveLocalProfileFromModal();
      return;
    }
    const index = parseInt(document.getElementById('modal-index').value);
    const name = document.getElementById('modal-name').value.trim() || null;
    const tempStr = document.getElementById('modal-temp').value;
    const timeStr = document.getElementById('modal-time').value;
    const vapor = normalizeVaporPreset(document.getElementById('modal-vapor')?.value);

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
    params.mood_light = mood;
    if (forceSelect || document.getElementById('modal-select').checked) params.select = true;

    saveProfileBackup('before_set_profile');
    writeProfileVaporOverride(index, vapor);
    updateOptimisticProfileDetails(index, params);
    send('set_profile', params);
    if (params.select) {
      optimisticProfileIndex = index;
      updateOptimisticProfile(index);
    }
    closeModal();
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
    if (identity.mac) localStorage.setItem('puffco_device_mac', identity.mac);
    else localStorage.setItem('puffco_device_name', identity.device);

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
    if (!send('scan_devices', { timeout: 6, puffco_only: true, manufacturer_prefix: PEAK_PRO_MAC_PREFIX })) {
      finishDeviceScan();
      return false;
    }
    return true;
  }

  function finishDeviceScan() {
    scanPending = false;
    const button = document.getElementById('btn-scan');
    if (button) {
      button.textContent = 'Scan';
    }
    updateScanButtonVisibility();
  }

  function handleDeviceScan(data) {
    finishDeviceScan();
    const results = document.getElementById('device-scan-results');
    if (!results) return;
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (!devices.length) {
      results.innerHTML = `<div class="scan-empty">${escapeHtml(data?.note || `No Peak Pro devices found with MAC prefix ${PEAK_PRO_MAC_PREFIX}`)}</div>`;
      results.classList.add('active');
      appendLog(data?.note || `No Peak Pro devices found with MAC prefix ${PEAK_PRO_MAC_PREFIX}`, 'info');
      return;
    }
    results.innerHTML = devices.map((item) => {
      const name = escapeHtml(item.name || 'Unknown BLE device');
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
        const name = button.dataset.name || 'Peak';
        const address = button.dataset.address || '';
        document.getElementById('device-name').value = address || name;
        const macToggle = document.getElementById('use-mac-address');
        if (macToggle) macToggle.checked = Boolean(address);
        syncIdentityModeUI();
        localStorage.setItem('puffco_device_name', name);
        localStorage.setItem('puffco_device_mac', address);
        localStorage.setItem('puffco_use_mac_address', address ? '1' : '0');
        appendLog(`Selected ${name} (${address})`, 'success');
        results.classList.remove('active');
        results.innerHTML = '';
        setTimeout(() => connectDevice(), 50);
      });
    });
    appendLog(`Found ${devices.length} Peak Pro candidate${devices.length === 1 ? '' : 's'} with ${data?.manufacturer_prefix || PEAK_PRO_MAC_PREFIX}`, 'success');
  }

  function refreshStatus() {
    return send('status');
  }

  function selectProfile(index) {
    if (!connected || optimisticProfileIndex === Number(index)) return false;
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
      profiles: deviceState.profiles.map((item, fallbackIndex) => ({
        ...item,
        vapor: Number(item.index ?? fallbackIndex) === Number(index) ? normalizeVaporPreset(profile) : normalizeVaporPreset(item),
        active: Number(item.index ?? fallbackIndex) === Number(index),
      })),
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

  function toast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const duplicate = [...container.children].find((child) => child.textContent === message);
    if (duplicate) {
      duplicate.remove();
    }
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('exit');
      setTimeout(() => el.remove(), 300);
    }, 3500);
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
          return `${humanizeEnum(key)} ${Math.round(parsed)}/255`;
        })
        .filter(Boolean);
      return parts.join(', ') || null;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return humanizeEnum(value);
    const clamped = Math.max(0, Math.min(255, parsed));
    return `${Math.round(parsed)}/255 (${Math.round((clamped / 255) * 100)}%)`;
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
    const selectedIndex = profiles.findIndex((profile, fallbackIndex) => Number(profile.index ?? fallbackIndex) === Number(selected));
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

  function renderLoraxPathList(paths) {
    const list = document.getElementById('lorax-path-list');
    if (!list) return;
    list.innerHTML = '';

    if (paths.length === 0) {
      list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No paths found</div>';
      return;
    }

    paths.forEach(p => {
      const activeClass = selectedPathEntry && selectedPathEntry.path === p.path ? ' active' : '';
      const div = document.createElement('div');
      div.className = `lorax-path-item${activeClass}`;
      div.onclick = () => selectLoraxPath(p.path);

      const accessLabel = getAccessLabel(p.access);
      const accessClass = getAccessClass(p.access);
      const statusBadge = p.status === 'experimental' ? `<span class="lorax-badge lorax-badge-exp">exp</span>` : '';

      div.innerHTML = `
        <div class="path-name" title="${escAttr(p.path)}">${escHtml(p.path)}</div>
        <div class="path-meta">
          ${statusBadge}
          <span class="lorax-badge ${accessClass}">${escHtml(accessLabel)}</span>
        </div>
      `;
      list.appendChild(div);
    });
  }

  function selectLoraxPath(pathStr) {
    const entry = loraxPaths.find(p => p.path === pathStr);
    if (!entry) return;
    selectedPathEntry = entry;

    // Highlight active in list
    const items = document.querySelectorAll('.lorax-path-item');
    items.forEach(item => {
      const nameEl = item.querySelector('.path-name');
      if (nameEl && nameEl.textContent === pathStr) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
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

  function voiceSupportConstructor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function updateVoiceUI(message = null) {
    const button = document.getElementById('btn-voice');
    const state = document.getElementById('voice-state');
    if (button) button.textContent = voiceIntentRunning ? 'Stop Voice' : 'Enable Voice';
    if (state) {
      state.textContent = message || (voiceListening ? 'Listening' : voicePermissionGranted ? 'Ready' : 'Permission required');
      state.classList.toggle('listening', voiceListening);
      const dataState = !voicePermissionGranted
        ? 'no-permission'
        : voiceBluetoothPending
          ? 'queued'
          : voiceListening
            ? 'listening'
            : voicePermissionGranted
              ? 'ready'
              : 'idle';
      state.dataset.state = dataState;
    }
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
      updateVoiceUI('Tap Open Chooser');
      setVoiceTranscript(`Heard: ${text} · Bluetooth chooser queued`, true);
      appendLog('Voice queued Bluetooth chooser; browser requires a trusted tap to open it.', 'warn');
      return true;
    }
    setVoiceBluetoothPrompt(false);
    updateVoiceUI('Opening Bluetooth chooser');
    setVoiceTranscript('Opening Bluetooth chooser for Peak Pro', true);
    connectDevice();
    return true;
  }

  function openBluetoothFromVoice() {
    const text = voiceBluetoothPending ? 'queued bluetooth selector' : 'open bluetooth selector';
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
      id: 'mode_browser_ble',
      label: 'Switch to browser Bluetooth',
      icon: 'bt',
      match: /\b(?:browser|web)\s*(?:bluetooth|ble)(?:\s*mode)?\b/,
      run: () => { setTransportMode('browser_ble'); return { ok: true, detail: 'Browser Bluetooth mode' }; },
    },
    {
      id: 'mode_bridge',
      label: 'Switch to bridge mode',
      icon: 'bridge',
      match: /\b(?:local|windows|backend|bridge)\s*(?:bridge|mode)?\b/,
      run: () => { setTransportMode('bridge'); return { ok: true, detail: 'Bridge mode' }; },
    },
    {
      id: 'connect',
      label: 'Open Bluetooth chooser',
      icon: 'bt',
      match: (text) => (
        /\b(?:open|show|start|launch)\s+(?:the\s+)?(?:bluetooth|ble)\s*(?:selector|chooser|pairing)?\b/.test(text)
        || /\b(?:connect|pair|find|scan|search)\b.*\b(?:peak|peak\s*pro|puffco|device|bluetooth|ble)\b/.test(text)
        || /\b(?:scan|find|search)\s*(?:devices?|peak|puffco)?\b/.test(text)
        || /\b(?:connect|pair)\b/.test(text)
      ) ? [text] : null,
      run: (text) => {
        const accepted = runVoiceConnect(text);
        return { ok: accepted, detail: accepted ? 'Bluetooth chooser open' : 'Bluetooth chooser blocked' };
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
      id: 'stop',
      label: 'Stop heat',
      icon: 'stop',
      match: /\b(?:please\s+)?(?:stop|cancel|end|abort)(?:\s+(?:it|the\s+heat|heat|session|cycle|dab|now))?\b/,
      run: () => {
        const sent = stop(true);
        return sent ? { ok: true, detail: 'Stop sent' } : { ok: false, blocked: 'No active heat to stop' };
      },
    },
    {
      id: 'boost',
      label: 'Boost',
      icon: 'boost',
      match: /\bboost(?:\s+it)?\b|\bturn\s+up(?:\s+the)?\s+(?:heat|temp)/,
      run: () => {
        const sent = boost();
        return sent ? { ok: true, detail: 'Boost sent' } : { ok: false, blocked: 'Boost needs active heat' };
      },
    },
    {
      id: 'heat',
      label: 'Start heat',
      icon: 'heat',
      match: /\b(?:start|begin|run|do|fire|initiate)\b[^.]{0,20}\b(?:heat|session|cycle|dab)\b|\bheat\s*up\b|\b(?:get|go)\s+hot\b|\b(?:start|begin|fire)\b\s+(?:it|the)\b/,
      run: () => {
        const sent = heat();
        return sent ? { ok: true, detail: 'Heat sent' } : { ok: false, blocked: isHeatActive(deviceState) ? 'Heat already running' : 'Heat unavailable' };
      },
    },
    {
      id: 'battery',
      label: 'Show battery',
      icon: 'battery',
      match: /\b(?:battery(?:\s+level)?|show\s+battery|charge\s+level)\b/,
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
    const text = String(transcript || '').toLowerCase().trim();
    if (!text) return false;
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
      return false;
    }
    return handleVoiceCommand(value);
  }

  async function startVoiceCommands() {
    const Recognition = voiceSupportConstructor();
    updateVoiceUI('Requesting mic');
    if (!(await ensureVoiceMic())) return;
    voiceIntentRunning = true;
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
    try {
      voiceRecognition.start();
      toast('Voice commands listening', 'success');
    } catch (err) {
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

  const THEME_STORAGE_KEY = 'puffco_theme';
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
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      return THEME_OPTIONS.includes(stored) ? stored : 'auto';
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
    const popover = document.getElementById('theme-popover');
    const button = document.getElementById('btn-settings');
    if (!popover || !button) return;
    const isOpen = popover.getAttribute('aria-hidden') === 'false';
    const next = typeof forceState === 'boolean' ? forceState : !isOpen;
    popover.setAttribute('aria-hidden', next ? 'false' : 'true');
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
  }

  function initThemeSystem() {
    const theme = readSavedTheme();
    document.documentElement.setAttribute('data-theme', theme);
    applyAccent(readSavedAccent());
    setAdvancedUser(isAdvancedUser());
    syncThemeUI();

    document.querySelectorAll('[data-theme-option]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyTheme(btn.getAttribute('data-theme-option'));
        btn.focus();
      });
    });
    document.querySelectorAll('[data-accent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyAccent(btn.getAttribute('data-accent'));
        btn.focus();
      });
    });

    document.addEventListener('click', (event) => {
      const popover = document.getElementById('theme-popover');
      const button = document.getElementById('btn-settings');
      if (!popover || !button) return;
      if (popover.getAttribute('aria-hidden') === 'false'
          && !popover.contains(event.target)
          && !button.contains(event.target)) {
        toggleSettings(false);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        const popover = document.getElementById('theme-popover');
        if (popover && popover.getAttribute('aria-hidden') === 'false') {
          toggleSettings(false);
          document.getElementById('btn-settings')?.focus();
        }
      }
    });
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
    let dragging = null;
    let lastZone = null;

    function setDropZone(target, zone) {
      if (!target) return;
      if (lastZone && lastZone !== target) {
        lastZone.removeAttribute('data-drop-zone');
      }
      if (zone) {
        target.setAttribute('data-drop-zone', zone);
      } else {
        target.removeAttribute('data-drop-zone');
      }
      lastZone = zone ? target : null;
    }

    function clearAllDropZones() {
      Array.from(container.children).forEach((el) => {
        el.removeAttribute('data-drop-zone');
      });
      lastZone = null;
    }

    function isCard(el) {
      return el && el.parentNode === container && el.getAttribute('data-card-id');
    }

    function midpointOf(el) {
      const rect = el.getBoundingClientRect();
      return rect.top + rect.height / 2;
    }

    Array.from(container.children).forEach((el) => {
      if (!el.getAttribute || !el.getAttribute('data-card-id')) return;
      el.setAttribute('data-draggable', 'true');
      el.setAttribute('draggable', 'true');

      el.addEventListener('dragstart', (event) => {
        dragging = el;
        el.setAttribute('data-dragging', 'true');
        container.classList.add('is-dragging');
        try {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', el.getAttribute('data-card-id'));
        } catch (_) { /* some browsers throw on setData without data */ }
      });

      el.addEventListener('dragend', () => {
        if (el) el.removeAttribute('data-dragging');
        container.classList.remove('is-dragging');
        clearAllDropZones();
        dragging = null;
      });

      el.addEventListener('dragover', (event) => {
        if (!dragging || dragging === el) return;
        event.preventDefault();
        try { event.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
        const mid = midpointOf(el);
        const zone = event.clientY < mid ? 'above' : 'below';
        setDropZone(el, zone);
      });

      el.addEventListener('dragleave', () => {
        if (lastZone === el) setDropZone(el, null);
      });

      el.addEventListener('drop', (event) => {
        if (!dragging || dragging === el) return;
        event.preventDefault();
        const mid = midpointOf(el);
        const zone = lastZone || (event.clientY < mid ? 'above' : 'below');
        if (zone === 'above') {
          container.insertBefore(dragging, el);
        } else {
          const after = el.nextSibling;
          container.insertBefore(dragging, after);
        }
        clearAllDropZones();
        persistCardOrderFromDom();
        flashCardSnap(dragging);
        updateCardMoveButtonStates();
        dragging = null;
      });
    });
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
    try { localStorage.removeItem(CARD_ORDER_KEY); } catch (_) { /* ignore */ }
    const container = getCardOrderContainer();
    if (!container) return;
    const defaults = capturedDefaultCardOrder && capturedDefaultCardOrder.length
      ? capturedDefaultCardOrder
      : defaultCardOrder();
    applyCardOrder(defaults);
    persistCardOrderFromDom();
    updateCardMoveButtonStates();
    if (typeof toast === 'function') {
      toast('Card layout reset to default', 'success');
    }
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
    bridgeUrl = normalizeBridgeUrl(localStorage.getItem('puffco_bridge_url'));
    transportMode = normalizeTransportMode(localStorage.getItem('puffco_transport_mode') || defaultTransportMode());
    initThemeSystem();
    const savedMacMode = localStorage.getItem('puffco_use_mac_address') === '1';
    const macToggle = document.getElementById('use-mac-address');
    if (macToggle) macToggle.checked = savedMacMode;
    if (macToggle) macToggle.addEventListener('change', toggleMacAddressMode);
    const identityInput = document.getElementById('device-name');
    if (identityInput) {
      identityInput.value = savedMacMode ? (savedMac || '') : (savedName || 'Peak');
    }
    syncIdentityModeUI();
    localMoodPresets = readMoodLibrary();
    updateConnectionUI(false);
    renderBridgeUI();
    renderProfileLibrary();
    updateVoiceUI();
    updateVoicePreview('—', null);
    showVoiceLastAction();

    initAppNavigation();
    initLabelTooltips();
    initColorControls();
    const profileImport = document.getElementById('profile-import-file');
    if (profileImport) {
      profileImport.addEventListener('change', () => importProfileFile(profileImport.files?.[0]));
    }
    const moodImport = document.getElementById('mood-import-file');
    if (moodImport) {
      moodImport.addEventListener('change', () => importMoodFile(moodImport.files?.[0]));
    }
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
    renderTimer = setInterval(() => {
      if (deviceState) updateHeatLiveUI(deviceState);
    }, 1000);
    initServiceWorker();
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
    rescanDrawStrength,
    clearDrawStrengthSource,
    resetCardOrder,
    resetDrawSessionCount,
    toggleSettings,
    selectProfile,
    editProfile,
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
    heat,
    stop,
    boost,
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
    devHeatProbe,
    devHeatObserve,
    devLoraxProbe,
    devLoraxObserve,
    devSetTemperatureSource,
    devClearTemperatureSource,
    devRunLoraxAction,
    exportBrowserDebugLog,
    copyBrowserDebugLog,
    downloadBrowserDebugLog,
    getBrowserBle,
    // Test hook for the draw-sensor wiring (also used by the
    // smoke test in tools/draw_sensor_smoke.js).
    _simulateDrawStrength: (state) => updateDrawStrengthUI(state),
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
};
