const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpRequest(path, options = {}) {
  const response = await fetch(`http://127.0.0.1:9222${path}`, options);
  if (!response.ok) throw new Error(`CDP ${path} returned ${response.status}`);
  return response.json();
}

async function main() {
  const tabs = await cdpRequest('/json');
  const tab = tabs.find((item) => item.type === 'page' && /127\.0\.0\.1:8080|127\.0\.0\.1:8420|localhost:8420/.test(item.url))
    || tabs.find((item) => item.type === 'page');
  if (!tab?.webSocketDebuggerUrl) throw new Error('No debuggable Chrome page found on port 9222');

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const events = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method) events.push(msg);
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Network.setBypassServiceWorker', { bypass: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Page.navigate', { url: process.argv[2] || 'http://127.0.0.1:8080/index.html' });
  await sleep(1200);

  const expression = `(() => {
    const q = (selector) => document.querySelector(selector);
    const rect = (selector) => {
      const el = q(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    const text = (selector) => q(selector)?.textContent?.trim() || '';
    const before = (a, b) => {
      const left = q(a);
      const right = q(b);
      return !!(left && right && (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING));
    };
    return {
      title: document.title,
      url: location.href,
      profilesBeforeHeat: before('#profiles-card', '#heat-control-card'),
      profilesBeforeLighting: before('#profiles-card', '#lighting-card'),
      bleInsideConnectionPill: !!q('#connection-badge #ble-capability'),
      bleSummaryHidden: getComputedStyle(q('#connection-badge #ble-capability .capability-summary')).display === 'none',
      desktopMobileHotbar: document.body.classList.contains('mobile-nav-shell') || getComputedStyle(q('.app-menu')).position === 'fixed',
      hasMoodColorList: !!q('#mood-colors'),
      hasProfileLibrary: !!q('#profile-library-grid'),
      hasSessionMetrics: !!q('#session-metrics'),
      hasCapabilityStrip: !!q('#capability-strip'),
      noNoAnimationVisible: !document.body.innerText.includes('No animation'),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      heatCountdown: text('#heat-countdown'),
      currentText: text('#heat-live-current'),
      targetText: text('#heat-live-target'),
    };
  })()`;

  const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true });
  const page = evaluated.result?.result?.value || {};
  const jsErrors = events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || event.method === 'Log.entryAdded')
    .map((event) => event.params)
    .slice(0, 6);
  ws.close();

  const failures = [];
  if (!page.profilesBeforeHeat || !page.profilesBeforeLighting) failures.push('Profiles is not before Heat/Lighting');
  if (!page.bleInsideConnectionPill || !page.bleSummaryHidden) failures.push('Bluetooth indicator is not compact inside the connection pill');
  if (page.desktopMobileHotbar) failures.push('Desktop viewport is using mobile hotbar');
  if (!page.hasMoodColorList || !page.hasProfileLibrary || !page.hasSessionMetrics || !page.hasCapabilityStrip) failures.push('Parity UI blocks are missing');
  if (!page.noNoAnimationVisible) failures.push('No animation text is visible');
  if (!page.noHorizontalOverflow) failures.push('Horizontal overflow detected');
  if (jsErrors.length) failures.push('JavaScript/log errors captured');

  console.log(JSON.stringify({ page, jsErrors, failures }, null, 2));
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
