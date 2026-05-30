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
  let heatCommandPending = null;
  let renderTimer = null;
  let lastDeviceSnapshot = null;
  let lastBackendMessage = null;
  let lastConnectionStatus = null;
  let bridgeUrl = null;
  let suppressSocketReconnect = false;

  // Lorax Path Explorer State
  let loraxPaths = [];
  let selectedPathEntry = null;
  let registryLoaded = false;
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
      name: 'No animation',
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
      id: 'spin',
      name: 'Spin',
      desc: 'Lighthouse motion',
      min: 1,
      max: 6,
      colors: ['#ff0000'],
      tempo: true,
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
  const moodEditor = {
    preset: 'no_animation',
    colors: ['#ff0000'],
    tempoFrac: 0.5,
    dynamicInhale: false,
  };
  const DEVICE_COMMANDS = new Set([
    'select_profile', 'set_profile', 'set_color', 'mood_light', 'lantern', 'lantern_color',
    'stealth', 'brightness', 'show_battery', 'show_version', 'heat', 'stop',
    'boost', 'power', 'temperature_observe', 'temperature_source',
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

  function renderBridgeUI() {
    const input = document.getElementById('bridge-url');
    if (input && document.activeElement !== input) input.value = bridgeUrl || defaultBridgeUrl();
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
      console.log('WebSocket closed, reconnecting in 2s...');
      lastConnectionStatus = {
        stage: 'socket_closed',
        message: `Browser socket disconnected from local backend at ${bridgeUrl || url}.`,
        timestamp: new Date().toISOString(),
      };
      setBridgeNote(`Bridge disconnected. Retrying ${bridgeUrl || url}...`, 'offline');
      if (connected || connectPending) {
        connected = false;
        connectPending = false;
        deviceState = null;
        lastDeviceSnapshot = normalizeDisconnectedPayload(lastDeviceSnapshot, 'Server connection lost');
        updateConnectionUI(false);
        updateStatusUI(null);
        toast('Server connection lost', 'error');
      }
      renderBackendMirror();
      reconnectTimer = setTimeout(() => initWebSocket(), 2000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setBridgeNote(`Bridge error. Make sure start.bat is running on Windows: ${bridgeUrl || url}`, 'offline');
    };
  }

  function connectBridge() {
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

  function send(cmd, params = {}) {
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
          updateDeviceState(normalizeConnectedPayload(msg.data));
          toast('Connected to device!', 'success');
          appendLog(msg.message || 'Connected to device', 'success');
          break;
        case 'disconnected':
          connectPending = false;
          scanPending = false;
          connected = false;
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
          toast(msg.message, 'error');
          appendLog(msg.message, 'error');
          renderConnectionAttempts(msg.data?.attempts);
          if (scanPending) finishDeviceScan();
          if (connectPending) {
            connectPending = false;
            updateConnectionUI(false);
          } else if (connected) {
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
    deviceState = data;
    lastDeviceSnapshot = data;
    connected = data.connected === true;
    updateConnectionUI(connected);
    if (connected) {
      updateStatusUI(data);
      updateProfilesUI(data.profiles, data.current_profile);
      stealthOn = !!data.stealth;
      updateToggle('toggle-stealth', stealthOn);
      lanternOn = !!data.lantern;
      updateToggle('toggle-lantern', lanternOn);

      // Lorax elements visibility
      const loraxEmpty = document.getElementById('lorax-empty');
      const loraxContent = document.getElementById('lorax-content');
      if (loraxEmpty) loraxEmpty.classList.add('hidden');
      if (loraxContent) loraxContent.classList.remove('hidden');

      const advancedPanel = document.getElementById('advanced-panel');
      if (!registryLoaded && advancedPanel?.open) {
        send('lorax_registry');
      }
    } else {
      updateStatusUI(null);
      updateProfilesUI([], null);
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

  function updateConnectionUI(isConnected) {
    const badge = document.getElementById('connection-badge');
    const text = document.getElementById('connection-text');
    const btnConnect = document.getElementById('btn-connect');
    const btnDisconnect = document.getElementById('btn-disconnect');
    const btnScan = document.getElementById('btn-scan');
    const nameInput = document.getElementById('device-name');
    const macInput = document.getElementById('device-mac');
    const scanResults = document.getElementById('device-scan-results');

    if (isConnected) {
      if (badge) badge.classList.add('connected');
      if (text) text.textContent = deviceState?.name || 'Connected';
      if (btnConnect) {
        btnConnect.classList.add('hidden');
        btnConnect.innerHTML = 'Connect';
        btnConnect.disabled = false;
      }
      if (btnScan) btnScan.classList.add('hidden');
      if (btnDisconnect) btnDisconnect.classList.remove('hidden');

      if (nameInput) {
        const group = nameInput.closest('.input-group');
        if (group) group.classList.add('hidden');
      }
      if (macInput) {
        const group = macInput.closest('.input-group');
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
        btnScan.classList.remove('hidden');
        btnScan.textContent = 'Scan';
        btnScan.disabled = false;
      }
      if (btnDisconnect) btnDisconnect.classList.add('hidden');

      if (nameInput) {
        const group = nameInput.closest('.input-group');
        if (group) group.classList.remove('hidden');
      }
      if (macInput) {
        const group = macInput.closest('.input-group');
        if (group) group.classList.remove('hidden');
      }
      if (scanResults) {
        scanResults.classList.remove('active');
        scanResults.innerHTML = '';
      }

      heatCommandPending = null;
      updateControlAvailability(false);
    }
  }

  function updateControlAvailability(isConnected) {
    const selectors = [
      '#controls-grid button',
      'button[data-device-command]',
      '#profiles-card button',
      '#brightness-card button',
      '#power-card button',
    ];
    document.querySelectorAll(selectors.join(',')).forEach((el) => {
      el.disabled = !isConnected;
    });
    updateHeatControls();
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
      return;
    }

    const report = data.heat_report || {};
    const readable = data.official_readable || {};
    const current = report.current_temp_label || data.live_temperature?.label || readable.currentTemperature || formatTemperatureF(data.current_temperature_f) || '—';
    const target = report.target_temp_label || readable.targetTemperature || formatTemperatureF(data.target_temperature_f) || formatTemperatureF(data.active_profile_temp_f) || '—';
    const remaining = getDynamicRemainingSeconds(report);
    let timer = '—';
    if (remaining != null) {
      timer = formatSecondsClock(remaining);
    } else if (report.timer_confidence === 'preheating') {
      timer = 'Preheating';
    } else if (report.duration_label) {
      timer = report.duration_label;
    }

    const profileName = data.active_profile_name || (data.current_profile != null ? `Profile ${data.current_profile}` : '—');
    setText('hero-device-name', data.name || 'Puffco');
    setText('hero-state-chip', heatStatusLabel(data));
    setText('hero-current-temp', current);
    setText('hero-target-temp', target);
    setText('hero-heat-timer', timer);
    setText('hero-profile', profileName);
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
      countdownEl.textContent = '--';
      phaseEl.textContent = 'Disconnected';
      currentEl.textContent = 'Current --';
      targetEl.textContent = 'Target --';
      metaEl.textContent = 'Waiting for device';
      panel.className = 'heat-live-panel';
      return;
    }

    const report = data.heat_report || {};
    const heating = isHeatActive(data);
    const current = report.current_temp_label || data.live_temperature?.label || data.official_readable?.currentTemperature || null;
    const target = report.target_temp_label || (data.active_profile_temp_f != null ? `${Math.round(data.active_profile_temp_f)} F` : null);
    let countdown = '--';
    let meta = report.duration_label ? `${report.duration_label} profile` : 'Profile duration unknown';

    const dynamicRemaining = getDynamicRemainingSeconds(report);
    if (dynamicRemaining != null) {
      countdown = formatSecondsClock(dynamicRemaining);
      const prefix = report.timer_confidence === 'firmware' ? 'Firmware timer' : 'Timer';
      meta = report.timer_elapsed_label ? `${prefix}, ${report.timer_elapsed_label} elapsed` : `${prefix} running`;
    } else if (heating && report.timer_confidence === 'syncing') {
      countdown = 'Sync';
      meta = 'Timer starts after an observed preheat-to-active transition';
    } else if (heating && report.timer_confidence === 'preheating') {
      countdown = 'Heat';
      meta = report.duration_label ? `Countdown begins at active heat, ${report.duration_label} profile` : 'Countdown begins at active heat';
    }

    countdownEl.textContent = countdown;
    phaseEl.textContent = report.phase || heatStatusLabel(data);
    currentEl.textContent = current ? `Current ${current}` : 'Current --';
    targetEl.textContent = target ? `Target ${target}` : 'Target --';
    metaEl.textContent = meta;
    const hasTimer = ['observed', 'firmware'].includes(report.timer_confidence);
    panel.className = 'heat-live-panel' + (heating ? ' active' : '') + (hasTimer ? ' timer-running' : '');
    updateHeroTelemetry(data);
    updateTelemetryFields(data);
  }

  function updateTelemetryFields(data) {
    const telemetryIds = [
      'stat-current-temp',
      'stat-target-temp',
      'stat-heat-timer',
      'stat-profile',
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
      return;
    }
    const report = data.heat_report || {};
    const readable = data.official_readable || {};
    const current = report.current_temp_label || data.live_temperature?.label || data.official_readable?.currentTemperature || formatTemperatureF(data.current_temperature_f);
    const target = report.target_temp_label || data.official_readable?.targetTemperature || formatTemperatureF(data.target_temperature_f) || formatTemperatureF(data.active_profile_temp_f);
    const remaining = getDynamicRemainingSeconds(report);
    let timer = '—';
    if (remaining != null) {
      timer = formatSecondsClock(remaining);
    } else if (report.timer_confidence === 'preheating') {
      timer = 'Preheating';
    } else if (report.duration_label) {
      timer = `${report.duration_label} profile`;
    }

    const profileName = data.active_profile_name || (data.current_profile != null ? `Profile ${data.current_profile}` : '—');
    setText('stat-current-temp', current || '—');
    setText('stat-target-temp', target || '—');
    setText('stat-heat-timer', timer);
    setText('stat-profile', profileName);
    setText('stat-battery-source', formatBatterySource(data.battery_source, data.battery_source_type));
    setText('stat-charge-eta', readable.chargeEstimatedTimeToFull || '—');
    setText('stat-boost', formatBoostSetting(data, readable));
    setText('stat-lantern-time', formatLanternStatus(data, readable));
    setText('stat-low-battery', readable.lowBatteryIndicator || formatBooleanLabel(data.low_battery_indicator) || '—');
    setText('stat-max-battery', readable.maxBatteryLevel || formatPercentLabel(data.max_battery_level) || '—');
    setText('stat-led-brightness', readable.brightness || formatBrightness(data.led_brightness) || '—');
  }

  function updateHeatControls() {
    const startBtn = document.getElementById('btn-heat');
    const boostBtn = document.getElementById('btn-boost');
    const stopBtn = document.getElementById('btn-stop');
    const statusText = document.getElementById('heat-status-text');
    if (!startBtn || !boostBtn || !stopBtn) return;

    const heating = connected && isHeatActive(deviceState);
    const pending = !!heatCommandPending;
    startBtn.disabled = !connected || heating || pending;
    boostBtn.disabled = !connected || !heating || pending;
    stopBtn.disabled = !connected || (!heating && heatCommandPending !== 'heat') || pending;

    startBtn.classList.toggle('loading', heatCommandPending === 'heat');
    boostBtn.classList.toggle('loading', heatCommandPending === 'boost');
    stopBtn.classList.toggle('loading', heatCommandPending === 'stop');

    startBtn.textContent = heatCommandPending === 'heat' ? 'Starting…' : 'Start Heat';
    boostBtn.textContent = heatCommandPending === 'boost' ? 'Boosting…' : 'Boost';
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

    profiles.forEach((p, i) => {
      const isActive = p.active || p.index === currentIndex;
      const profileColor = extractProfileColor(p.color);
      const mood = extractProfileMood(p.color);
      const officialMood = isOfficialMoodPayload(p.color);
      const moodName = mood.name || activeMoodPreset().name;

      // Profile card
      const card = document.createElement('div');
      card.className = 'profile-card' + (isActive ? ' active' : '');
      card.style.setProperty('--profile-color', profileColor);

      card.innerHTML = `
        <div class="profile-name">
          <span class="active-indicator"></span>
          <span>${escHtml(p.name || `Profile ${p.index}`)}</span>
          <div class="profile-color-swatch" style="background:${profileColor};margin-left:auto;"></div>
        </div>
        <div class="profile-meta">
          <span>${p.temp_f ?? '—'}°F</span>
          <span>${p.time_s ?? '—'}s</span>
          <span>${escHtml(moodName)}</span>
          <span class="profile-sync-badge ${officialMood ? 'ok' : 'warn'}">${officialMood ? 'Official' : 'Legacy'}</span>
        </div>
        <div class="profile-actions">
          <button class="btn btn-sm btn-secondary" onclick="app.selectProfile(${p.index})">
            ${isActive ? 'Active' : 'Select'}
          </button>
          <button class="btn btn-sm btn-secondary" onclick="app.editProfile(${p.index})">Edit</button>
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
  }

  function extractProfileColor(colorObj) {
    if (!colorObj) return '#8b5cf6';
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
          return '#' + raw.slice(0, 3).map(v => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0')).join('');
        }
        for (const item of raw) {
          const color = normalize(item);
          if (color) return color;
        }
      }
      return null;
    };
    // Navigate the nested color structure from the Puffco CBOR response
    try {
      const metaColor = normalize(colorObj.meta?.userColors || colorObj.meta?.arrayColors);
      if (metaColor) return metaColor;
      if (colorObj.lamp?.param?.color) {
        const paramColor = normalize(colorObj.lamp.param.color);
        if (paramColor) return paramColor;
      }
      // Try flat "color" key
      if (colorObj.color) {
        const flatColor = normalize(colorObj.color);
        if (flatColor) return flatColor;
      }
    } catch (e) {}
    return '#8b5cf6';
  }

  function extractProfileMood(colorObj) {
    const fallbackColor = extractProfileColor(colorObj);
    const meta = colorObj?.meta || {};
    const preset = MOOD_PRESETS.some(item => item.id === meta.moodType) ? meta.moodType : 'no_animation';
    const rawColors = Array.isArray(meta.userColors) ? meta.userColors : [fallbackColor];
    const colors = rawColors
      .map(color => extractProfileColor({ color }))
      .filter(color => /^#[0-9a-f]{6}$/i.test(color));
    return {
      preset,
      name: meta.moodName || meta.led3Name || (MOOD_PRESETS.find(item => item.id === preset)?.name ?? 'No animation'),
      colors: colors.length ? colors : [fallbackColor],
      tempoFrac: Number.isFinite(Number(meta.tempoFrac)) ? Math.max(0, Math.min(1, Number(meta.tempoFrac))) : 0.5,
      dynamicInhale: !!Number(meta.dynamicInhale || 0),
    };
  }

  function isOfficialMoodPayload(colorObj) {
    const meta = colorObj?.meta || {};
    const lamp = colorObj?.lamp || {};
    const preset = String(meta.moodType || '').replace(/-/g, '_');
    return lamp.name === 'pikaled2'
      && MOOD_PRESETS.some(item => item.id === preset)
      && Array.isArray(meta.userColors)
      && meta.userColors.length > 0;
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
    return MOOD_PRESETS.find(preset => preset.id === moodEditor.preset) || MOOD_PRESETS[0];
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
    moodEditor.preset = preset.id;
    moodEditor.colors = preset.colors.slice();
    moodEditor.dynamicInhale = false;
    if (!preset.tempo) moodEditor.tempoFrac = 0.5;
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
    ['modal-temp', 'modal-time'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.addEventListener('input', renderModalSummary);
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
      MOOD_PRESETS.forEach(preset => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mood-preset' + (preset.id === moodEditor.preset ? ' active' : '');
        btn.innerHTML = `<strong>${escHtml(preset.name)}</strong><span>${escHtml(preset.desc)}</span>`;
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
      slot.innerHTML = `
        <span>${index + 1}</span>
        <input type="color" value="${escHtml(color)}" aria-label="Mood color ${index + 1}" />
        <input type="text" class="hex-input" value="${escHtml(color.toUpperCase())}" maxlength="7" />
        <button class="icon-btn mood-remove" title="Remove color" ${moodEditor.colors.length <= preset.min ? 'disabled' : ''}>×</button>
      `;
      const colorInput = slot.querySelector('input[type="color"]');
      const textInput = slot.querySelector('input[type="text"]');
      const removeBtn = slot.querySelector('button');
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
      preset: moodEditor.preset,
      colors: moodEditor.colors.slice(),
      tempo_frac: moodEditor.tempoFrac,
      dynamic_inhale: moodEditor.dynamicInhale,
      ...extra,
    };
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
    const preset = activeMoodPreset();
    summary.textContent = `${temp}°F · ${time}s · ${preset.name}`;
  }

  function editProfile(index) {
    editingProfileIndex = index;
    const profile = deviceState?.profiles?.[index];
    if (!profile) return;

    document.getElementById('modal-kicker').textContent = `Profile ${index}`;
    document.getElementById('modal-name').value = profile.name || '';
    document.getElementById('modal-temp').value = profile.temp_f ?? '';
    document.getElementById('modal-time').value = profile.time_s ?? '';
    document.getElementById('modal-index').value = index;

    const mood = extractProfileMood(profile.color);
    moodEditor.preset = mood.preset;
    moodEditor.colors = mood.colors;
    moodEditor.tempoFrac = mood.tempoFrac;
    moodEditor.dynamicInhale = mood.dynamicInhale;
    syncPickerToMoodColor();
    renderMoodControls();
    renderModalSummary();
    document.getElementById('modal-select').checked = false;

    document.getElementById('profile-modal').classList.add('visible');
  }

  function closeModal() {
    document.getElementById('profile-modal').classList.remove('visible');
    editingProfileIndex = null;
  }

  function saveProfile() {
    const index = parseInt(document.getElementById('modal-index').value);
    const name = document.getElementById('modal-name').value.trim() || null;
    const tempStr = document.getElementById('modal-temp').value;
    const timeStr = document.getElementById('modal-time').value;

    const params = { index };
    if (name) params.name = name;
    if (tempStr) params.temp_f = parseFloat(tempStr);
    if (timeStr) params.time_s = parseFloat(timeStr);
    const mood = moodParams();
    if (!mood) return;
    params.mood_light = mood;
    if (document.getElementById('modal-select').checked) params.select = true;

    send('set_profile', params);
    closeModal();
  }

  // ---- Toggle Helpers ----

  function updateToggle(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    if (state) {
      el.classList.add('on');
    } else {
      el.classList.remove('on');
    }
  }

  function toggleLantern() {
    if (!connected) return;
    const previous = lanternOn;
    lanternOn = !lanternOn;
    updateToggle('toggle-lantern', lanternOn);
    if (!send('lantern', { state: lanternOn ? 'on' : 'off' })) {
      lanternOn = previous;
      updateToggle('toggle-lantern', previous);
    }
  }

  function toggleStealth() {
    if (!connected) return;
    const previous = stealthOn;
    stealthOn = !stealthOn;
    updateToggle('toggle-stealth', stealthOn);
    if (!send('stealth', { state: stealthOn ? 'on' : 'off' })) {
      stealthOn = previous;
      updateToggle('toggle-stealth', previous);
    }
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
    send('brightness', {
      base: parseInt(document.getElementById('slider-base').value),
      mid: parseInt(document.getElementById('slider-mid').value),
      glass: parseInt(document.getElementById('slider-glass').value),
      logo: parseInt(document.getElementById('slider-logo').value),
    });
  }

  // ---- Commands ----

  function connectDevice() {
    if (connectPending) return;
    const name = document.getElementById('device-name').value.trim() || 'Peak';
    const mac = document.getElementById('device-mac').value.trim() || undefined;

    // Save to localStorage
    localStorage.setItem('puffco_device_name', name);
    if (mac) localStorage.setItem('puffco_device_mac', mac);

    const btn = document.getElementById('btn-connect');
    connectPending = true;
    btn.innerHTML = '<span class="spinner"></span> Connecting…';
    btn.disabled = true;

    if (!send('connect', { device: name, mac })) {
      connectPending = false;
      updateConnectionUI(false);
      return;
    }

    // Safety timeout: if backend never responds, reset to allow retry
    setTimeout(() => {
      if (!connectPending) return;
      connectPending = false;
      updateConnectionUI(false);
      toast('Connection attempt timed out', 'error');
      appendLog('Connection timed out after 120s — no response from backend', 'error');
    }, 120000);
  }

  function disconnectDevice() {
    send('disconnect');
  }

  function resyncDevice() {
    const name = document.getElementById('device-name').value.trim() || 'Peak';
    const mac = document.getElementById('device-mac').value.trim();
    appendLog('Requesting backend BLE resync', 'info');
    send('connect', { device: name, mac });
  }

  function scanDevices() {
    if (scanPending || connected) return;
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
    if (!send('scan_devices', { timeout: 6, puffco_only: true })) {
      finishDeviceScan();
    }
  }

  function finishDeviceScan() {
    scanPending = false;
    const button = document.getElementById('btn-scan');
    if (button) {
      button.textContent = 'Scan';
      button.disabled = connected;
    }
  }

  function handleDeviceScan(data) {
    finishDeviceScan();
    const results = document.getElementById('device-scan-results');
    if (!results) return;
    const devices = Array.isArray(data?.devices) ? data.devices : [];
    if (!devices.length) {
      results.innerHTML = `<div class="scan-empty">${escapeHtml(data?.note || 'No Puffco devices found')}</div>`;
      results.classList.add('active');
      appendLog(data?.note || 'No Puffco devices found during scan', 'info');
      return;
    }
    results.innerHTML = devices.map((item) => {
      const name = escapeHtml(item.name || 'Unknown BLE device');
      const address = escapeHtml(item.address || '');
      const rssi = item.rssi == null ? '' : `<span>${escapeHtml(String(item.rssi))} dBm</span>`;
      return `
        <button class="scan-result" type="button" data-address="${address}" data-name="${name}">
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
        document.getElementById('device-name').value = name;
        document.getElementById('device-mac').value = address;
        localStorage.setItem('puffco_device_name', name);
        localStorage.setItem('puffco_device_mac', address);
        appendLog(`Selected ${name} (${address})`, 'success');
        results.classList.remove('active');
        results.innerHTML = '';
      });
    });
    appendLog(`Found ${devices.length} Puffco candidate${devices.length === 1 ? '' : 's'} with Windows BLE`, 'success');
  }

  function refreshStatus() {
    send('status');
  }

  function selectProfile(index) {
    send('select_profile', { index });
  }

  function heat() {
    if (heatCommandPending || isHeatActive(deviceState)) return;
    heatCommandPending = 'heat';
    updateHeatControls();
    if (!send('heat')) {
      heatCommandPending = null;
      updateHeatControls();
    }
  }

  function stop() {
    if (heatCommandPending) return;
    heatCommandPending = 'stop';
    updateHeatControls();
    if (!send('stop')) {
      heatCommandPending = null;
      updateHeatControls();
    }
  }

  function boost() {
    if (heatCommandPending || !isHeatActive(deviceState)) return;
    heatCommandPending = 'boost';
    updateHeatControls();
    if (!send('boost')) {
      heatCommandPending = null;
      updateHeatControls();
    }
  }

  function showBattery() {
    send('show_battery');
  }

  function showVersion() {
    send('show_version');
  }

  function power(cmd) {
    if (cmd === 'off' && !confirm('Power off the device?')) return;
    send('power', { cmd });
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

  function appendLog(message, type = 'info') {
    const log = document.getElementById('activity-log');
    if (!log) return;

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
    lastBackendMessage = {
      type: msg.type || 'unknown',
      message: msg.message || null,
      received_at: new Date().toISOString(),
      data: msg.data ?? null,
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
    setText('backend-poll', formatPollingStatus(backend));
    setText('backend-battery-raw', formatBackendValue(snapshot?.battery_raw || snapshot?.battery_source || snapshot?.battery));
    setText('backend-temp-source', formatBackendValue(snapshot?.live_temperature_source?.path || snapshot?.live_temperature?.source || sources.currentTemperature));

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
    if (el) el.textContent = value;
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

  function formatPollingStatus(backend) {
    if (!backend || typeof backend !== 'object') return '—';
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
    if (el) el.textContent = value;
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
    const temp = readable.boostTemperature || formatTemperatureDeltaF(data.boost_temperature_delta_f);
    const time = readable.boostTime || formatSecondsLabel(data.boost_time_s);
    if (temp && time) return `${temp} / ${time}`;
    return temp || time || '—';
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
    const compact = String(value).trim().toUpperCase().replace(/[\s.-]+/g, '_');
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

  function formatChamber(value) {
    const normalized = String(value || '').toUpperCase();
    if (!value) return '—';
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
    send('lorax_registry');
  }

  function handleLoraxRegistry(data) {
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
        const valueStr = readResult.value === null || readResult.value === undefined ? 'null' : readResult.value;
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

  function handleLoraxRead(data) {
    if (!data) return;
    if (selectedPathEntry && selectedPathEntry.path === data.path) {
      renderLoraxDetails(data);
    }
    appendLog(`Read ${data.path}: ${data.value !== null && data.value !== undefined ? data.value : 'bytes[' + data.size + ']'}`, 'info');
  }

  function renderDevResult(type, data) {
    const output = document.getElementById('dev-command-output');
    if (!output) return;
    const payload = {
      type,
      received_at: new Date().toISOString(),
      data: data ?? null,
    };
    output.textContent = safeJsonStringify(payload);
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

  function init() {
    // Restore saved values
    const savedName = localStorage.getItem('puffco_device_name');
    const savedMac = localStorage.getItem('puffco_device_mac');
    bridgeUrl = normalizeBridgeUrl(localStorage.getItem('puffco_bridge_url'));
    if (savedName) document.getElementById('device-name').value = savedName;
    if (savedMac) document.getElementById('device-mac').value = savedMac;
    renderBridgeUI();

    initColorControls();
    initWebSocket(bridgeUrl);
    const advancedPanel = document.getElementById('advanced-panel');
    if (advancedPanel) {
      advancedPanel.addEventListener('toggle', () => {
        if (advancedPanel.open && connected && !registryLoaded) {
          send('lorax_registry');
        }
      });
    }
    renderTimer = setInterval(() => {
      if (deviceState) updateHeatLiveUI(deviceState);
    }, 1000);

    // Unregister any active service worker to avoid cache issues
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (let registration of registrations) {
          registration.unregister();
        }
      }).catch(err => {
        console.log('SW unregistration failed:', err);
      });
    }
  }

  // Boot
  document.addEventListener('DOMContentLoaded', init);

  // Public API
  return {
    connectBridge,
    connect: connectDevice,
    disconnect: disconnectDevice,
    resyncDevice,
    scanDevices,
    refreshStatus,
    selectProfile,
    editProfile,
    closeModal,
    saveProfile,
    toggleLantern,
    toggleStealth,
    applyColorToProfile,
    applyLanternColor,
    setMoodPreset,
    addMoodColor,
    applyMoodToProfile,
    applyMoodToLantern,
    applyBrightness,
    updateSliderLabel,
    updateAllBrightness,
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
    clearDevOutput,
    devOfficialAttrs,
    devHeatProbe,
    devHeatObserve,
    devLoraxProbe,
    devLoraxObserve,
    devSetTemperatureSource,
    devClearTemperatureSource,
    devRunLoraxAction,
  };
})();
