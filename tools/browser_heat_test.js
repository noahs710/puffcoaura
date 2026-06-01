const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  let page = null;
  try {
    page = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
  } catch {
    const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
    page = tabs.find((tab) => tab.type === "page" && tab.url === "about:blank") || tabs.find((tab) => tab.type === "page");
  }
  if (!page) throw new Error("No Chrome page found on the debugging port");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
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

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  await send("Network.enable");
  await send("Network.setBypassServiceWorker", { bypass: true });
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        localStorage.setItem('puffco_transport_mode', 'bridge');
        localStorage.setItem('puffco_bridge_url', 'ws://127.0.0.1:8421/ws');
        const sockets = [];
        const baseState = {
          connected: true,
          name: 'Test Peak',
          battery: 83,
          state: 'IDLE',
          heat: 'idle',
          chamber: 'CHAMBER_TYPE_3D',
          charge: 'NOT_CHARGING',
          firmware: '39',
          bootloader: '1',
          serial: 'TEST-SERIAL',
          dabs_per_day: 12.4,
          dabs_left: 28.2,
          total_dabs: 321,
          uptime: [1, 2, 3],
          labels: {
            battery: '83%',
            charge: 'Not charging',
            chamber: '3D chamber',
            state: 'Idle',
            heat: 'Idle',
            dabs_per_day: '12.4',
            dabs_left: '28',
            total_dabs: '321',
            uptime: '1:02:03',
          },
          current_profile: 0,
          profiles: [
            { index: 0, active: true, name: 'Blue', temp_f: 520, time_s: 60, color: { color: '#38bdf8' } },
            { index: 1, active: false, name: 'Green', temp_f: 500, time_s: 55, color: { color: '#22c55e' } },
            { index: 2, active: false, name: 'Red', temp_f: 540, time_s: 45, color: { color: '#ef4444' } },
            { index: 3, active: false, name: 'Gold', temp_f: 560, time_s: 40, color: { color: '#f6a623' } },
          ],
        };

        class MockSocket {
          constructor() {
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
            setTimeout(() => {
              this.readyState = 1;
              this.onopen && this.onopen();
              this.emit({ type: 'status', data: baseState });
            }, 20);
          }
          send(raw) {
            const msg = JSON.parse(raw);
            this.sent.push(msg);
            window.__sentCommands = this.sent;
            if (msg.cmd === 'heat') {
              this.emit({ type: 'ok', message: 'Heat cycle started', data: { ...baseState, state: 'HEAT_CYCLE_PREHEAT', heat: 'HEATING', labels: { ...baseState.labels, state: 'Preheating', heat: 'Preheating' } } });
            } else if (msg.cmd === 'boost') {
              this.emit({ type: 'ok', message: 'Boost sent', data: { ...baseState, state: 'HEAT_CYCLE_ACTIVE', heat: 'HEATING', labels: { ...baseState.labels, state: 'Heating', heat: 'Heating' } } });
            } else if (msg.cmd === 'stop') {
              this.emit({ type: 'ok', message: 'Heat cycle stopped', data: { ...baseState, state: 'IDLE', heat: 'idle' } });
            } else if (msg.cmd === 'status') {
              this.emit({ type: 'status', data: baseState });
            }
          }
          close() {
            this.readyState = 3;
            this.onclose && this.onclose();
          }
          emit(payload) {
            setTimeout(() => this.onmessage && this.onmessage({ data: JSON.stringify(payload) }), 25);
          }
        }
        MockSocket.CONNECTING = 0;
        MockSocket.OPEN = 1;
        MockSocket.CLOSING = 2;
        MockSocket.CLOSED = 3;
        window.WebSocket = MockSocket;
        window.__mockSockets = sockets;
        window.__sentCommands = [];
      })();
    `,
  });

  const targetUrl = process.argv[2] || "http://127.0.0.1:8420";
  await send("Page.navigate", { url: targetUrl });
  await sleep(800);

  async function evalPage(expression) {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result.exceptionDetails) {
      const details = result.result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "Runtime evaluation failed");
    }
    return result.result.result.value;
  }

  const initial = await evalPage(`(() => ({
    connected: document.querySelector("#connection-text")?.textContent?.trim(),
    startDisabled: document.querySelector("#btn-heat")?.disabled,
    boostDisabled: document.querySelector("#btn-boost")?.disabled,
    stopDisabled: document.querySelector("#btn-stop")?.disabled,
    heatText: document.querySelector("#heat-status-text")?.textContent?.trim(),
    battery: document.querySelector("#battery-pct")?.textContent?.trim(),
    chargePill: document.querySelector("#charge-pill")?.textContent?.trim(),
    charge: document.querySelector("#stat-charge")?.textContent?.trim(),
    chamber: document.querySelector("#stat-chamber")?.textContent?.trim(),
    dabsLeft: document.querySelector("#stat-drem")?.textContent?.trim(),
    dabsPerDay: document.querySelector("#stat-dpd")?.textContent?.trim(),
    totalDabs: document.querySelector("#stat-total-dabs")?.textContent?.trim(),
    bleExpanded: document.querySelector("#ble-capability")?.getAttribute("aria-expanded"),
    bleDetailsDisplay: document.querySelector("#ble-capability-details") ? getComputedStyle(document.querySelector("#ble-capability-details")).display : "missing"
  }))()`);

  await evalPage(`document.querySelector("#ble-capability").click()`);
  const afterBleExpand = await evalPage(`(() => ({
    bleExpanded: document.querySelector("#ble-capability")?.getAttribute("aria-expanded"),
    bleDetailsDisplay: document.querySelector("#ble-capability-details") ? getComputedStyle(document.querySelector("#ble-capability-details")).display : "missing",
    bleTitle: document.querySelector("#ble-capability-title")?.textContent?.trim()
  }))()`);

  await evalPage(`app.selectProfile(1)`);
  const afterProfileSelect = await evalPage(`(() => ({
    activeProfile: document.querySelector(".profile-card.active .profile-name span:not(.active-indicator)")?.textContent?.trim(),
    heroProfile: document.querySelector("#hero-profile")?.textContent?.trim(),
    statProfile: document.querySelector("#stat-profile")?.textContent?.trim(),
    sent: (window.__sentCommands || []).map((cmd) => cmd.cmd)
  }))()`);

  await evalPage(`app.heat()`);
  await sleep(250);
  const afterHeat = await evalPage(`(() => ({
    sent: window.__sentCommands.map((cmd) => cmd.cmd),
    startDisabled: document.querySelector("#btn-heat")?.disabled,
    boostDisabled: document.querySelector("#btn-boost")?.disabled,
    stopDisabled: document.querySelector("#btn-stop")?.disabled,
    heatText: document.querySelector("#heat-status-text")?.textContent?.trim(),
    statHeat: document.querySelector("#stat-state")?.textContent?.trim(),
    bodyHeating: document.body.classList.contains("heat-active")
  }))()`);

  await evalPage(`app.boost()`);
  await sleep(250);
  const afterBoost = await evalPage(`(() => ({
    sent: window.__sentCommands.map((cmd) => cmd.cmd),
    logText: [...document.querySelectorAll("#activity-log .log-row")].map((row) => row.textContent.trim()).join("\\n")
  }))()`);

  await evalPage(`app.stop()`);
  await sleep(250);
  const afterStop = await evalPage(`(() => ({
    sent: window.__sentCommands.map((cmd) => cmd.cmd),
    startDisabled: document.querySelector("#btn-heat")?.disabled,
    boostDisabled: document.querySelector("#btn-boost")?.disabled,
    stopDisabled: document.querySelector("#btn-stop")?.disabled,
    heatText: document.querySelector("#heat-status-text")?.textContent?.trim(),
    statHeat: document.querySelector("#stat-state")?.textContent?.trim(),
    bodyHeating: document.body.classList.contains("heat-active")
  }))()`);

  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPath = "C:/PuffcoBLE/browser-heat.png";
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, "base64"));

  const jsErrors = events
    .filter((event) => event.method === "Runtime.exceptionThrown" || event.method === "Log.entryAdded")
    .map((event) => event.params)
    .slice(0, 8);

  const failures = [];
  if (jsErrors.length) failures.push("JavaScript/log errors were captured");
  if (initial.connected !== "Test Peak") failures.push("Mock connected device did not appear in the UI");
  if (initial.startDisabled || !initial.boostDisabled || !initial.stopDisabled) failures.push("Initial heat buttons are not in idle state");
  if (initial.battery !== "83%") failures.push("Battery percent did not render as 83%");
  if (initial.chargePill !== "Not charging" || initial.charge !== "Not charging") failures.push("Charging state was not human-readable");
  if (initial.chamber !== "3D chamber") failures.push("Chamber type was not human-readable");
  if (initial.dabsLeft !== "28") failures.push("Dabs remaining did not render cleanly");
  if (initial.dabsPerDay !== "12.4") failures.push("Dabs/day did not render cleanly");
  if (initial.totalDabs !== "321") failures.push("Total dabs did not render cleanly");
  if (initial.bleExpanded !== "false" || initial.bleDetailsDisplay !== "none") failures.push("Bluetooth readiness details were not compact by default");
  if (afterBleExpand.bleExpanded !== "true" || afterBleExpand.bleDetailsDisplay === "none") failures.push("Bluetooth readiness details did not expand when clicked");
  if (!/Bluetooth/i.test(afterBleExpand.bleTitle)) failures.push("Bluetooth readiness title did not render");
  if (afterProfileSelect.activeProfile !== "Green") failures.push("Profile switching did not update the active card instantly");
  if (afterProfileSelect.heroProfile !== "Green" || afterProfileSelect.statProfile !== "Green") failures.push("Profile switching did not update status/hero instantly");
  if (!afterProfileSelect.sent.includes("select_profile")) failures.push("Profile switching did not send select_profile");
  if (!afterHeat.sent.includes("heat")) failures.push("Start Heat did not send the heat command");
  if (!afterHeat.startDisabled || afterHeat.boostDisabled || afterHeat.stopDisabled) failures.push("Heating state did not disable Start and enable Boost/Stop");
  if (afterHeat.statHeat !== "Preheating") failures.push("Status heat value did not update to Preheating");
  if (!afterHeat.bodyHeating) failures.push("Heating state did not enable app heat animation class");
  if (!afterBoost.sent.includes("boost")) failures.push("Boost did not send the boost command while heating");
  if (!/Boost sent/.test(afterBoost.logText)) failures.push("Boost result was not logged");
  if (!afterStop.sent.includes("stop")) failures.push("Stop did not send the stop command");
  if (afterStop.startDisabled || !afterStop.boostDisabled || !afterStop.stopDisabled) failures.push("Stopped state did not restore idle heat buttons");
  if (afterStop.statHeat !== "Idle") failures.push("Status heat value did not return to Idle");
  if (afterStop.bodyHeating) failures.push("Stopped state did not clear app heat animation class");

  console.log(JSON.stringify({
    initial,
    afterBleExpand,
    afterProfileSelect,
    afterHeat,
    afterBoost,
    afterStop,
    jsErrors,
    screenshot: screenshotPath,
    failures,
  }, null, 2));

  ws.close();
  if (failures.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
