const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("Connecting to Chrome on port 9222...");
  let page = null;
  try {
    page = await (await fetch("http://127.0.0.1:9222/json/new?about:blank", { method: "PUT" })).json();
  } catch (err) {
    try {
      const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
      page = tabs.find((tab) => tab.type === "page" && tab.url.includes("8420")) || 
             tabs.find((tab) => tab.type === "page" && tab.url === "about:blank") || 
             tabs.find((tab) => tab.type === "page");
    } catch (e) {
      console.error("Could not reach Chrome debugging port 9222. Ensure Chrome is running with remote debugging enabled.");
      process.exit(1);
    }
  }

  if (!page) {
    console.error("No debuggable page found in Chrome.");
    process.exit(1);
  }

  console.log(`Attaching to Chrome page: ${page.url || page.title}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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

  // Navigate to local website if it's not already there
  const targetUrl = "http://127.0.0.1:8420";
  if (!page.url || !page.url.startsWith(targetUrl)) {
    console.log(`Navigating to ${targetUrl}...`);
    await send("Page.navigate", { url: targetUrl });
    await sleep(2000);
  }

  // Set transport mode to browser BLE
  console.log("Setting transport mode to browser_ble (Browser Bluetooth)...");
  await send("Runtime.evaluate", {
    expression: `(() => {
      app.setTransportMode('browser_ble');
    })()`,
  });

  console.log("\n========================================================");
  console.log("ACTION REQUIRED:");
  console.log("Please open your Chrome browser tab at http://127.0.0.1:8420");
  console.log("1. Click the 'Connect' button.");
  console.log("2. Select your Peak Pro ('Pretty Peaky') in the BLE chooser.");
  console.log("3. Once the web page shows 'Pretty Peaky' connected, this script will proceed.");
  console.log("========================================================\n");

  // Poll connection status
  let isConnected = false;
  while (!isConnected) {
    try {
      const result = await send("Runtime.evaluate", {
        expression: `(() => {
          const client = app.getBrowserBle();
          return client && client.device && client.device.gatt && client.device.gatt.connected;
        })()`,
        returnByValue: true
      });
      
      isConnected = !!(result.result && result.result.result && result.result.result.value);
    } catch (e) {
      // Ignore errors during poll
    }
    
    if (!isConnected) {
      await sleep(1000);
    }
  }

  console.log("Device connected in browser! Loading paths registry...");
  
  // Wait a moment for registry to be loaded on page
  await sleep(1500);

  console.log("Starting full Lorax paths scan in browser context...");
  
  const scanExpression = `(async () => {
    const client = app.getBrowserBle();
    if (!client) throw new Error("BLE Client not found in page");
    
    const paths = window.loraxPaths || [];
    if (!paths.length) {
      // Force request registry if not loaded
      app.refreshLoraxRegistry();
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const registryPaths = window.loraxPaths || [];
    if (!registryPaths.length) throw new Error("No paths registry loaded in page");
    
    const results = [];
    for (let i = 0; i < registryPaths.length; i++) {
      const entry = registryPaths[i];
      if (entry.path === '/p/app/facr') {
        console.log("Skipping factory reset path");
        continue;
      }
      
      let success = false;
      let decoded = null;
      let raw_hex = null;
      let error = null;
      
      const size = entry.size && entry.size > 0 ? entry.size : (entry.data_type === 'float32' ? 4 : (entry.data_type === 'uint8' || entry.data_type === 'int8' ? 1 : 12));
      
      try {
        const raw = await client.readShort(entry.path, 0, size);
        success = true;
        raw_hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');
        decoded = client.decodeValue(raw, entry.data_type);
      } catch (e) {
        error = e.message || String(e);
      }
      
      results.push({
        path: entry.path,
        name: entry.name,
        registered_type: entry.data_type,
        registered_size: entry.size,
        success,
        raw_hex,
        decoded,
        error,
        entry
      });
      
      await new Promise(r => setTimeout(r, 40));
    }
    return results;
  })()`;

  const evaluation = await send("Runtime.evaluate", {
    expression: scanExpression,
    awaitPromise: true,
    returnByValue: true
  });

  if (evaluation.result.exceptionDetails) {
    console.error("Scan failed with exception:", evaluation.result.exceptionDetails.exception?.description);
    ws.close();
    process.exit(1);
  }

  const results = evaluation.result.result.value;
  console.log(`Scan completed! Scanned ${results.length} paths.`);

  const outputFilePath = path.join(__dirname, "lorax_test_results.json");
  fs.writeFileSync(outputFilePath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Results written to ${outputFilePath}`);

  // Summarize
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(`Summary: ${succeeded} succeeded, ${failed} failed.`);

  ws.close();
}

main().catch((err) => {
  console.error("Unhandle error in main:", err);
  process.exit(1);
});
