const fs = require("fs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = tabs.find((tab) => tab.type === "page");
  if (!page) {
    throw new Error("No Chrome page found on the debugging port");
  }

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
    if (msg.method) {
      events.push(msg);
    }
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
  const targetUrl = process.argv[2] || "http://127.0.0.1:8420";
  const viewport = process.argv[3] || "desktop";
  if (viewport === "mobile") {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
  } else {
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  await send("Page.navigate", { url: targetUrl });
  await sleep(1600);

  await send("Runtime.evaluate", {
    expression: `(() => {
      const all = document.querySelector("#slider-all");
      all.value = "72";
      all.dispatchEvent(new Event("input", { bubbles: true }));
      app.applyBrightness();
    })()`,
    returnByValue: true,
  });
  await sleep(250);

  await send("Runtime.evaluate", {
    expression: `(() => {
      app.heat();
      app.showBattery();
    })()`,
    returnByValue: true,
  });
  await sleep(500);

  const expression = `(() => {
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
    const exists = (sel) => !!document.querySelector(sel);
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const overlaps = (a, b) => !!(a && b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
    const toastRect = rect(".toast");
    const controlRects = [".app-header", "#controls-grid", "#connect-card", "#status-card"].map(rect);
    return {
      title: document.title,
      url: location.href,
      connection: text("#connection-text"),
      header: text(".logo"),
      hasAllSlider: exists("#slider-all"),
      allSliderValue: document.querySelector("#slider-all")?.value,
      baseSliderValue: document.querySelector("#slider-base")?.value,
      baseLabel: text("#val-base"),
      hasFactoryReset: document.body.innerText.includes("Factory Reset"),
      hasProfiles: exists("#profiles-grid"),
      hasActivityLog: exists("#activity-log"),
      activityRows: document.querySelectorAll("#activity-log .log-row").length,
      hasExtendedStats: ["#stat-bootloader", "#stat-serial", "#stat-total-dabs", "#stat-uptime"].every(exists),
      hasStatusEmpty: document.querySelector("#status-empty")?.classList.contains("visible"),
      toastText: [...document.querySelectorAll(".toast")].map((toast) => toast.textContent.trim()),
      disabledDeviceButtons: [...document.querySelectorAll("#controls-grid button, #color-card button, #brightness-card button, #power-card button")]
        .every((button) => button.disabled),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      bodyWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      toastOverControls: controlRects.some((controlRect) => overlaps(toastRect, controlRect)),
      cards: document.querySelectorAll(".card").length,
      connectRect: rect("#connect-card"),
      brightnessRect: rect("#brightness-card")
    };
  })()`;

  const pageState = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });

  const screenshot = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const screenshotPath = viewport === "mobile"
    ? "C:/PuffcoBLE/browser-smoke-mobile.png"
    : "C:/PuffcoBLE/browser-smoke.png";
  fs.writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, "base64"));

  const jsErrors = events
    .filter((event) => event.method === "Runtime.exceptionThrown" || event.method === "Log.entryAdded")
    .map((event) => event.params)
    .slice(0, 8);

  const pageData = pageState.result.result.value;
  const failures = [];
  if (jsErrors.length) failures.push("JavaScript/log errors were captured");
  if (pageData.overflowX) failures.push("Page has horizontal overflow");
  if (!pageData.hasActivityLog) failures.push("Activity log is missing");
  if (!pageData.activityRows) failures.push("Activity log did not record blocked commands");
  if (!pageData.hasExtendedStats) failures.push("Extended status fields are missing");
  if (!pageData.disabledDeviceButtons) failures.push("Device controls are enabled while disconnected");
  if (pageData.toastOverControls) failures.push("Toast overlaps the main control area");

  console.log(JSON.stringify({
    page: pageData,
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
