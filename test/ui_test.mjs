import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

// Run with: node --test test/ui_test.mjs. CHROME_BIN can select a Chromium browser.
const candidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ...((process.env.PATH || "").split(delimiter).flatMap((dir) => ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"].map((name) => join(dir, name)))),
].filter(Boolean);
const chrome = candidates.find((candidate) => existsSync(candidate));
const pageUrl = pathToFileURL(fileURLToPath(new URL("../public/index.html", import.meta.url))).href;
const token = "private-session-token-93bc";
const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

class Browser {
  constructor(executable) {
    this.profile = mkdtempSync(join(tmpdir(), "macdry-ui-"));
    this.child = spawn(executable, [
      "--headless", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
      "--disable-sync", "--no-first-run", "--no-default-browser-check", "--no-proxy-server",
      "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${this.profile}`,
      "--remote-debugging-pipe", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdio[4].on("data", (chunk) => this.receive(chunk));
    this.child.stdio[3].on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error(`Chrome exited unexpectedly. ${this.stderr}`)));
  }
  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer += this.decoder.write(chunk);
    let boundary;
    while ((boundary = this.buffer.indexOf("\0")) !== -1) {
      const message = JSON.parse(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary + 1);
      const request = this.pending.get(message.id);
      if (!request) continue;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}. ${this.stderr}`)); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  async newPage({ storageBlocked = false, storageWriteBlocked = false, hash = token } = {}) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this, targetId, sessionId);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installMocks})(${JSON.stringify({ storageBlocked, storageWriteBlocked })})` });
    await page.send("Page.navigate", { url: `${pageUrl}${hash ? `#${encodeURIComponent(hash)}` : ""}` });
    await page.ready();
    return page;
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise((resolve) => this.child.once("exit", resolve));
      this.child.kill("SIGTERM");
      let timer;
      await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3000); })]);
      clearTimeout(timer);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

class Page {
  constructor(browser, targetId, sessionId) { Object.assign(this, { browser, targetId, sessionId }); }
  send(method, params = {}) { return this.browser.send(method, params, this.sessionId); }
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
  async ready(previousRun = null) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`Boolean(window.__test && window.__test.runId !== ${JSON.stringify(previousRun)} && document.readyState === 'complete' && document.querySelector('[data-test="keyboard"] [data-result]')?.getAttribute('role') === 'status')`)) return;
      } catch { /* Navigation may destroy the previous execution context. */ }
      await flush();
    }
    throw new Error("UI did not finish loading");
  }
  async reload() {
    const oldRun = await this.eval("window.__test.runId");
    await this.send("Page.reload");
    await this.ready(oldRun);
  }
  async wait(expression) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await this.eval(expression)) return;
      await flush();
    }
    throw new Error(`Timed out waiting for: ${expression}`);
  }
  async close() { await this.browser.send("Target.closeTarget", { targetId: this.targetId }); }
}

// The document, DOM events, history and storage are real; only device, audio,
// graphics, download and network boundaries are replaced with deterministic fakes.
function installMocks({ storageBlocked, storageWriteBlocked }) {
  const state = window.__test = {
    runId: Math.random().toString(36), requests: [], responses: [], preflightResponses: [], systemResponses: { filesystem: [], network_quality: [], logs: [] }, pendingRequests: [],
    mediaCalls: [], mediaModes: [], pendingMedia: [], streams: [], audioContexts: [], workers: [], workerMessages: [], workerModes: [],
    graphicsAvailable: true, graphicsCalls: [], downloads: [], blobs: [], revoked: [], fastGpu: false, fakeNow: 0,
    localStorageReads: 0, recorderCalls: 0,
  };
  Object.defineProperty(window, "localStorage", { configurable: true, get() { state.localStorageReads++; throw new Error("Persistent storage is forbidden"); } });
  window.MediaRecorder = class { constructor() { state.recorderCalls++; throw new Error("Recording is forbidden"); } };
  if (storageBlocked) {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new DOMException("Blocked", "SecurityError"); } });
  } else if (storageWriteBlocked) {
    const storage = window.sessionStorage;
    if (location.hash) storage.setItem("macdry-session-token", "stale-token");
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: {
      getItem: (key) => storage.getItem(key),
      setItem() { throw new DOMException("Quota exceeded", "QuotaExceededError"); },
      removeItem: (key) => storage.removeItem(key),
    } });
  }
  window.fetch = async (url, options) => {
    state.requests.push({ url: String(url), options });
    const isPreflight = url === "/api/load-test/preflight";
    const systemTestId = {
      "/api/tests/filesystem": "filesystem",
      "/api/tests/network-quality": "network_quality",
      "/api/tests/log-scan": "logs",
    }[url];
    if (url !== "/api/checks" && !isPreflight && !systemTestId) throw new Error("Unexpected network request");
    const responseQueue = isPreflight ? state.preflightResponses : systemTestId ? state.systemResponses[systemTestId] : state.responses;
    let response = responseQueue.shift() || (isPreflight
      ? { status: 200, data: { eligible: true, checks: [
        { id: "memory_pressure", status: "info", summary: "macOS reports normal memory pressure." },
        { id: "thermal", status: "info", summary: "macOS reports a normal thermal warning level." }
      ] } }
      : systemTestId === "network_quality"
      ? { status: 200, data: { status: "measurement-recorded", summary: "Quality measured.", metrics: { download_mbps: 20, upload_mbps: 5 }, details: "Traffic was sent." } }
      : systemTestId === "filesystem"
      ? { status: 200, data: { status: "no-anomaly-detected", summary: "Volume verification reported no issue.", details: "No raw output." } }
      : systemTestId === "logs"
      ? { status: 200, data: { status: "no-anomaly-detected", summary: "No matching log events.", matches: {}, details: "Aggregate only." } }
      : { status: 200, data: { checks: [] } });
    if (response.deferred) response = await new Promise((resolve) => state.pendingRequests.push(resolve));
    if (response.reject) throw new Error(response.reject);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.data };
  };
  window.Worker = class {
    constructor(url) { this.url = url; this.listeners = new Map(); this.terminated = false; state.workers.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
    postMessage(message) {
      state.workerMessages.push({ url: this.url, type: message.type });
      if (message.type === "stop") return;
      const mode = state.workerModes.shift() || "complete";
      if (mode === "pending") return;
      const status = mode === "complete" ? "no-anomaly-detected" : mode;
      queueMicrotask(() => this.listeners.get("message")?.({ data: { type: message.type, status } }));
    }
    terminate() { this.terminated = true; }
  };
  const originalNow = performance.now.bind(performance);
  Object.defineProperty(performance, "now", { configurable: true, value: () => state.fastGpu ? state.fakeNow : originalNow() });
  const originalAnimationFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => originalAnimationFrame((time) => {
    if (!state.fastGpu) return callback(time);
    state.fakeNow += 1000;
    callback(state.fakeNow);
  });
  const previewObjects = new WeakMap();
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
    configurable: true,
    get() { return previewObjects.get(this) || null; },
    set(value) { previewObjects.set(this, value); },
  });
  state.makeStream = () => {
    const track = new EventTarget();
    track.stopped = false;
    track.stop = () => { track.stopped = true; };
    const stream = { track, getTracks: () => [track] };
    state.streams.push(stream);
    return stream;
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {
    getUserMedia(constraints) {
      state.mediaCalls.push(constraints);
      const mode = state.mediaModes.shift() || "accept";
      if (mode === "denied") return Promise.reject(new DOMException("Denied", "NotAllowedError"));
      if (mode === "missing") return Promise.reject(new DOMException("Missing", "NotFoundError"));
      if (mode === "pending") return new Promise((resolve, reject) => state.pendingMedia.push({ resolve, reject }));
      return Promise.resolve(state.makeStream());
    },
  } });
  class FakeAudioContext {
    constructor() {
      if (state.failAudio) throw new Error("Audio context unavailable");
      this.state = "running";
      this.currentTime = 0;
      this.destination = { kind: "destination" };
      this.connections = [];
      this.oscillators = [];
      state.audioContexts.push(this);
    }
    resume() { return Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    node(kind) {
      return { kind, connect: (target, output, input) => this.connections.push({ from: kind, to: target.kind, output, input }) };
    }
    createMediaStreamSource() { return this.node("microphone"); }
    createAnalyser() { return { ...this.node("analyser"), fftSize: 0, getFloatTimeDomainData: (array) => array.fill(0.1) }; }
    createChannelMerger() { return this.node("merger"); }
    createGain() { return { ...this.node("gain"), gain: { setValueAtTime() {}, linearRampToValueAtTime() {} } }; }
    createOscillator() {
      const oscillator = { ...this.node("oscillator"), frequency: {}, start(time) { this.started = time; }, stop(time) { this.stopped = time; } };
      this.oscillators.push(oscillator);
      return oscillator;
    }
  }
  window.AudioContext = FakeAudioContext;
  const gl = {
    SCISSOR_TEST: 1, COLOR_BUFFER_BIT: 2, VERTEX_SHADER: 3, FRAGMENT_SHADER: 4, COMPILE_STATUS: 5, LINK_STATUS: 6,
    ARRAY_BUFFER: 7, STATIC_DRAW: 8, FLOAT: 9, TRIANGLES: 10, NO_ERROR: 0,
    isContextLost: () => false,
    viewport(...args) { state.graphicsCalls.push(["viewport", ...args]); },
    enable() {}, disable() {},
    scissor(...args) { state.graphicsCalls.push(["scissor", ...args]); },
    clearColor(...args) { state.graphicsCalls.push(["clearColor", ...args]); },
    clear() {}, createShader: (type) => ({ type }), shaderSource() {}, compileShader() {}, getShaderParameter: () => true,
    createProgram: () => ({}), attachShader() {}, linkProgram() {}, getProgramParameter: () => true, useProgram() {},
    getAttribLocation: () => 0, createBuffer: () => ({}), bindBuffer() {}, bufferData() {}, enableVertexAttribArray() {},
    vertexAttribPointer() {}, getUniformLocation: () => ({}), uniform1f() {}, drawArrays() {}, getError: () => 0, deleteBuffer() {},
  };
  HTMLCanvasElement.prototype.getContext = function () { return state.graphicsAvailable ? gl : null; };
  URL.createObjectURL = (blob) => { state.blobs.push(blob); return `blob:mock-${state.blobs.length}`; };
  URL.revokeObjectURL = (url) => state.revoked.push(url);
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.href.startsWith("blob:mock-")) state.downloads.push({ href: this.href, filename: this.download });
    else originalClick.call(this);
  };
}

let browser;
before(() => {
  assert.ok(chrome, "A Chromium browser is required; set CHROME_BIN to its executable.");
  browser = new Browser(chrome);
});
after(async () => { if (browser) await browser.close(); });

async function usingPage(options, run) {
  const page = await browser.newPage(options);
  try { await run(page); } finally { await page.close(); }
}

const check = { id: "model", title: "<img src=x onerror=alert(1)>", status: "info", summary: "Inventory only", details: "Details", source: "local" };

test("explicit API request, safe rendering and session token across reload", async () => usingPage({}, async (page) => {
  const initial = await page.eval(`({ hash: location.hash, stored: sessionStorage.getItem('macdry-session-token'), requests: __test.requests.length, media: __test.mediaCalls.length, audio: __test.audioContexts.length, graphics: __test.graphicsCalls.length, downloads: __test.downloads.length })`);
  assert.deepEqual(initial, { hash: "", stored: token, requests: 0, media: 0, audio: 0, graphics: 0, downloads: 0 });
  await page.eval(`__test.responses.push({ status: 200, data: { checks: [${JSON.stringify(check)}] } }); document.querySelector('#refresh-checks').click()`);
  await page.wait("document.querySelectorAll('.check-card').length === 1");
  const rendered = await page.eval(`({ request: __test.requests[0], title: document.querySelector('.check-card h3').textContent, images: document.querySelectorAll('.check-card img').length, state: document.querySelector('#checks-state').textContent })`);
  assert.equal(rendered.request.url, "/api/checks");
  assert.equal(rendered.request.options.method, "GET");
  assert.equal(rendered.request.options.headers["X-Macdry-Token"], token);
  assert.equal(rendered.request.options.cache, "no-store");
  assert.equal(rendered.title, check.title);
  assert.equal(rendered.images, 0);
  assert.match(rendered.state, /1 check returned/);
  await page.reload();
  assert.equal(await page.eval("location.hash"), "");
  assert.equal(await page.eval("__test.requests.length"), 0);
  await page.eval("document.querySelector('#refresh-checks').click()");
  await page.wait("__test.requests.length === 1");
  assert.equal(await page.eval("__test.requests[0].options.headers['X-Macdry-Token']"), token);
  await page.eval("location.hash = '#replacement-token'");
  await page.reload();
  assert.equal(await page.eval("location.hash"), "");
  assert.equal(await page.eval("sessionStorage.getItem('macdry-session-token')"), "replacement-token");
  await page.reload();
  await page.eval("document.querySelector('#refresh-checks').click()");
  await page.wait("__test.requests.length === 1");
  assert.equal(await page.eval("__test.requests[0].options.headers['X-Macdry-Token']"), "replacement-token");
}));

test("blocked session storage retains an in-memory token and explains reload fallback", async () => usingPage({ storageBlocked: true }, async (page) => {
  assert.equal(await page.eval("location.hash"), "");
  assert.match(await page.eval("document.querySelector('#token-storage-notice').textContent"), /reloading may require/i);
  await page.eval("document.querySelector('#refresh-checks').click()");
  await page.wait("__test.requests.length === 1");
  assert.equal(await page.eval("__test.requests[0].options.headers['X-Macdry-Token']"), token);
  await page.reload();
  assert.match(await page.eval("document.querySelector('#checks-state').textContent"), /No session token/i);
  await page.eval("document.querySelector('#refresh-checks').click()");
  assert.equal(await page.eval("__test.requests.length"), 0);
}));

test("a failed token write removes any stale stored token", async () => usingPage({ storageWriteBlocked: true }, async (page) => {
  assert.equal(await page.eval("sessionStorage.getItem('macdry-session-token')"), null);
  assert.match(await page.eval("document.querySelector('#token-storage-notice').textContent"), /reloading may require/i);
  await page.eval("document.querySelector('#refresh-checks').click()");
  await page.wait("__test.requests.length === 1");
  assert.equal(await page.eval("__test.requests[0].options.headers['X-Macdry-Token']"), token);
  await page.reload();
  assert.match(await page.eval("document.querySelector('#checks-state').textContent"), /No session token/i);
  await page.eval("document.querySelector('#refresh-checks').click()");
  assert.equal(await page.eval("__test.requests.length"), 0);
}));

test("API failures and stale responses cannot show misleading results", async () => usingPage({}, async (page) => {
  await page.eval("__test.responses.push({status: 403}); document.querySelector('#refresh-checks').click()");
  await page.wait("document.querySelector('#checks-state').textContent.includes('HTTP 403')");
  assert.equal(await page.eval("document.querySelectorAll('.check-card').length"), 0);
  await page.eval("__test.responses.push({status: 200, data: {checks: 'invalid'}}); document.querySelector('#refresh-checks').click()");
  await page.wait("document.querySelector('#checks-state').textContent.includes('invalid checks response')");
  await page.eval("__test.responses.push({reject: 'offline'}); document.querySelector('#refresh-checks').click()");
  await page.wait("document.querySelector('#checks-state').textContent.includes('Could not load')");
  await page.eval(`__test.responses.push({deferred: true}, {status: 200, data: {checks: [${JSON.stringify(check)}]}}); document.querySelector('#refresh-checks').click(); document.querySelector('#refresh-checks').click()`);
  await page.wait("document.querySelectorAll('.check-card').length === 1 && __test.pendingRequests.length === 1");
  await page.eval("__test.pendingRequests[0]({status: 200, data: {checks: []}})");
  await flush();
  assert.equal(await page.eval("document.querySelectorAll('.check-card').length"), 1);
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /Informational: 1/);
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.checks_state, "complete");
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].status, "info");
}));

test("summary separates check and human response states and displays recommendations safely", async () => usingPage({}, async (page) => {
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /not run yet/i);
  assert.match(await page.eval("document.querySelector('#summary-tests').textContent"), /Not tested: 9 · Unavailable: 0/);
  const checks = [
    { id: "storage", status: "warning", title: "Storage", summary: "Almost full", details: "90% used", source: "df", recommendation: "Review space <img src=x onerror=alert(1)>" },
    { id: "smart", status: "fail", title: "SMART", recommendation: "Back up data" },
    { id: "memory", status: "info", title: "Memory" },
    { id: "battery", status: "unavailable", title: "Battery" },
    { id: "other", status: "future", title: "Other" },
  ];
  await page.eval(`__test.responses.push({status: 200, data: {checks: ${JSON.stringify(checks)}}}); document.querySelector('#refresh-checks').click()`);
  await page.wait("document.querySelectorAll('.check-card').length === 5");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /Anomalies: 1 · Alerts: 1 · Informational: 1 · Unavailable: 1 · Unknown: 1/);
  const cards = await page.eval("Array.from(document.querySelectorAll('.check-card'), card => ({badge: card.querySelector('.check-badge').textContent, recommendation: card.querySelector('.check-recommendation').textContent, details: card.querySelector('details')?.textContent, source: card.querySelector('.check-source')?.textContent, images: card.querySelectorAll('img').length}))");
  assert.deepEqual(cards.map((card) => card.badge), ["Alert", "Anomaly", "Informational", "Unavailable", "Unknown"]);
  assert.match(cards[0].recommendation, /Review space <img/);
  assert.match(cards[0].details, /90% used/);
  assert.equal(cards[0].source, "Source: df");
  assert.equal(cards[0].images, 0);
  assert.match(cards[2].recommendation, /does not establish hardware health/);
  await page.eval("document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('[data-test=keyboard] [data-feedback=pass]').click(); document.querySelector('[data-action=start-pointer]').click(); document.querySelector('[data-test=pointer] [data-feedback=fail]').click(); __test.graphicsAvailable = false; document.querySelector('[data-action=start-gpu]').click()");
  assert.match(await page.eval("document.querySelector('#summary-tests').textContent"), /Human pass: 1 · Human fail: 1 · Not tested: 6 · Unavailable: 1/);
  assert.match(await page.eval("document.querySelector('[data-test=gpu] .test-guidance').textContent"), /graphics settings/);
  assert.match(await page.eval("document.querySelector('[data-test=keyboard] .test-guidance').textContent"), /human response.*not proof/i);
  assert.match(await page.eval("document.querySelector('.summary-limit').textContent"), /human responses, not proof/i);
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.deepEqual(report.summary.checks, { fail: 1, warning: 1, info: 1, unavailable: 1, unknown: 1 });
  assert.deepEqual(report.summary.tests, { "not-tested": 6, pass: 1, fail: 1, unavailable: 1 });
  assert.deepEqual(report.checks.map(({ id, status }) => ({ id, status })), [
    { id: "storage", status: "warning" }, { id: "smart", status: "fail" }, { id: "memory", status: "info" },
    { id: "battery", status: "unavailable" }, { id: "other-5", status: "unknown" },
  ]);
  assert.equal(report.checks[0].recommendation, checks[0].recommendation);
  assert.equal(report.checks[1].recommendation, checks[1].recommendation);
  assert.match(report.checks[2].recommendation, /does not establish hardware health/);
  assert.equal(report.checks[2].summary, null);
  assert.deepEqual(report.checks[4], { id: "other-5", status: "unknown", recommendation: "Review the source and retry the local check; an unavailable or unknown result is not a diagnosis." });
  assert.match(report.tests.find((item) => item.id === "gpu").recommendation, /graphics settings/);
  assert.match(report.tests.find((item) => item.id === "pointer").recommendation, /Repeat/);
  assert.match(report.limitations, /human responses.*not proof/i);
}));

test("summary and report distinguish not-run, loading, complete and unavailable checks", async () => usingPage({}, async (page) => {
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /not run yet/i);
  await page.eval("document.querySelector('#export-report').click(); __test.responses.push({deferred: true}); document.querySelector('#refresh-checks').click()");
  await page.wait("__test.pendingRequests.length === 1");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /loading local checks/i);
  await page.eval("document.querySelector('#export-report').click(); __test.pendingRequests[0]({status: 200, data: {checks: []}})");
  await page.wait("document.querySelector('#checks-state').textContent.includes('no checks')");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /complete:.*no checks returned/i);
  await page.eval("document.querySelector('#export-report').click(); __test.responses.push({deferred: true}); document.querySelector('#refresh-checks').click()");
  await page.wait("__test.pendingRequests.length === 2");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /loading local checks/i);
  await page.eval("__test.pendingRequests[1]({status: 503})");
  await page.wait("document.querySelector('#checks-state').textContent.includes('HTTP 503')");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /local checks are unavailable/i);
  await page.eval("document.querySelector('#export-report').click()");
  const reports = await page.eval("Promise.all(__test.blobs.map(async blob => JSON.parse(await blob.text())))");
  assert.deepEqual(reports.map((report) => report.checks_state), ["not-run", "loading", "complete", "unavailable"]);
  assert.deepEqual(reports.map((report) => report.checks), [null, null, [], null]);
  assert.deepEqual(reports.map((report) => report.summary.checks), [null, null, { fail: 0, warning: 0, info: 0, unavailable: 0, unknown: 0 }, null]);
}));

test("missing token leaves checks not-run until an attempted run becomes unavailable", async () => usingPage({ storageBlocked: true, hash: "" }, async (page) => {
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /not run yet.*session token/i);
  assert.match(await page.eval("document.querySelector('#checks-state').textContent"), /no session token/i);
  await page.eval("document.querySelector('#export-report').click(); document.querySelector('#refresh-checks').click(); document.querySelector('#export-report').click()");
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /local checks are unavailable/i);
  const reports = await page.eval("Promise.all(__test.blobs.map(async blob => JSON.parse(await blob.text())))");
  assert.deepEqual(reports.map((report) => report.checks_state), ["not-run", "unavailable"]);
  assert.ok(reports.every((report) => report.checks === null && report.summary.checks === null));
  assert.equal(await page.eval("__test.requests.length"), 0);
}));

test("stale successes and failures do not change loading or unavailable state", async () => usingPage({}, async (page) => {
  await page.eval("__test.responses.push({deferred: true}, {deferred: true}); document.querySelector('#refresh-checks').click(); document.querySelector('#refresh-checks').click()");
  await page.wait("__test.pendingRequests.length === 2");
  await page.eval(`__test.pendingRequests[0]({status: 200, data: {checks: [${JSON.stringify(check)}]}})`);
  await flush();
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /loading local checks/i);
  assert.equal(await page.eval("document.querySelectorAll('.check-card').length"), 0);
  await page.eval("document.querySelector('#export-report').click(); __test.pendingRequests[1]({status: 503})");
  await page.wait("document.querySelector('#checks-state').textContent.includes('HTTP 503')");
  await page.eval("__test.responses.push({deferred: true}, {status: 503}); document.querySelector('#refresh-checks').click(); document.querySelector('#refresh-checks').click()");
  await page.wait("__test.pendingRequests.length === 3 && document.querySelector('#checks-state').textContent.includes('HTTP 503')");
  await page.eval(`__test.pendingRequests[2]({status: 200, data: {checks: [${JSON.stringify(check)}]}})`);
  await flush();
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /local checks are unavailable/i);
  assert.equal(await page.eval("document.querySelectorAll('.check-card').length"), 0);
  await page.eval("__test.responses.push({deferred: true}, {status: 200, data: {checks: []}}); document.querySelector('#refresh-checks').click(); document.querySelector('#refresh-checks').click()");
  await page.wait("__test.pendingRequests.length === 4 && document.querySelector('#checks-state').textContent.includes('no checks')");
  await page.eval("__test.pendingRequests[3]({reject: 'offline'})");
  await flush();
  assert.match(await page.eval("document.querySelector('#summary-checks').textContent"), /complete:.*no checks returned/i);
  await page.eval("document.querySelector('#export-report').click()");
  const reports = await page.eval("Promise.all(__test.blobs.map(async blob => JSON.parse(await blob.text())))");
  assert.deepEqual(reports.map((report) => report.checks_state), ["loading", "complete"]);
  assert.deepEqual(reports.map((report) => report.checks), [null, []]);
}));

test("keyboard displays only the last physical code while active and focused", async () => usingPage({}, async (page) => {
  const feedback = "document.querySelector('#keyboard-feedback').textContent";
  const waiting = "Waiting for a keydown in this area.";
  await page.eval(`document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'KeyQ'}))`);
  assert.equal(await page.eval(feedback), waiting);
  assert.equal(await page.eval("document.querySelector('[data-test=keyboard] [data-feedback=pass]').disabled"), true);
  await page.eval(`document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'KeyQ'}))`);
  assert.equal(await page.eval(feedback), "Last physical key: KeyQ");
  await page.eval(`document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'KeyW'}))`);
  assert.equal(await page.eval(feedback), "Last physical key: KeyW");
  assert.equal(await page.eval("document.body.textContent.includes('KeyQ') || document.body.textContent.includes('PRIVATE_KEY')"), false);
  await page.eval(`document.querySelector('#export-report').focus(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'KeyE'}))`);
  assert.equal(await page.eval(feedback), "Last physical key: KeyW");
  await page.eval(`document.querySelector('#keyboard-area').focus(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY'}))`);
  assert.equal(await page.eval(feedback), "Physical key code unavailable.");
  await page.eval(`document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {code: 'Unidentified'}))`);
  assert.equal(await page.eval(feedback), "Physical key code unavailable.");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
  assert.equal(await page.eval(feedback), "Last physical key: KeyA");
  await page.eval(`document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyR'})); document.querySelector('[data-test=keyboard] [data-feedback=pass]').click(); document.querySelector('[data-action=stop-keyboard]').click()`);
  assert.equal(await page.eval(feedback), waiting);
  assert.equal(await page.eval("document.querySelector('#keyboard-workspace').hidden"), true);
  assert.equal(await page.eval("document.querySelector('[data-test=keyboard] [data-result]').dataset.status"), "pass");
  await page.eval(`document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyT'}))`);
  assert.equal(await page.eval(feedback), waiting);
}));

test("keyboard clears the displayed code when the page is hidden or closed", async () => usingPage({}, async (page) => {
  const feedback = "document.querySelector('#keyboard-feedback').textContent";
  await page.eval(`document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyQ'}))`);
  assert.equal(await page.eval(feedback), "Last physical key: KeyQ");
  await page.eval("Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(await page.eval(feedback), "Waiting for a keydown in this area.");
  assert.equal(await page.eval("document.querySelector('#keyboard-workspace').hidden"), true);
  await page.eval(`Object.defineProperty(document, 'hidden', {configurable: true, value: false}); document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyW'})); window.dispatchEvent(new Event('pagehide'))`);
  assert.equal(await page.eval(feedback), "Waiting for a keydown in this area.");
  assert.equal(await page.eval("document.querySelector('#keyboard-workspace').hidden"), true);
}));

test("pointer test requires activation and records only user feedback", async () => usingPage({}, async (page) => {
  await page.eval("document.querySelector('#pointer-area').dispatchEvent(new PointerEvent('pointermove'))");
  assert.equal(await page.eval("document.querySelector('[data-test=pointer] [data-feedback=pass]').disabled"), true);
  await page.eval(`document.querySelector('[data-action=start-pointer]').click(); for (const type of ['pointermove', 'click', 'wheel']) document.querySelector('#pointer-area').dispatchEvent(new Event(type)); document.querySelector('[data-test=pointer] [data-feedback=fail]').click()`);
  assert.match(await page.eval("document.querySelector('#pointer-feedback').textContent"), /Move: detected · Click: detected · Scroll: detected/);
  assert.equal(await page.eval("document.querySelector('[data-test=pointer] [data-result]').dataset.status"), "fail");
  await page.eval("document.querySelector('[data-action=stop-pointer]').click()");
  assert.equal(await page.eval("document.querySelector('#pointer-workspace').hidden"), true);
}));

test("camera and microphone permissions, feedback and explicit cleanup", async () => usingPage({}, async (page) => {
  assert.equal(await page.eval("__test.mediaCalls.length"), 0);
  for (const id of ["camera", "microphone"]) {
    await page.eval(`__test.mediaModes.push('denied'); document.querySelector('[data-action=start-${id}]').click()`);
    await page.wait(`document.querySelector('[data-test=${id}] [data-result]').dataset.status === 'unavailable'`);
    assert.match(await page.eval(`document.querySelector('#${id}-message').textContent`), /permission.*denied/i);
    assert.equal(await page.eval(`document.querySelector('[data-test=${id}] [data-feedback=pass]').disabled`), true);
  }
  await page.eval("document.querySelector('[data-action=start-camera]').click()");
  await page.wait("!document.querySelector('#camera-workspace').hidden");
  assert.deepEqual(await page.eval("__test.mediaCalls[2]"), { video: true, audio: false });
  assert.equal(await page.eval("document.querySelector('#camera-preview').srcObject === __test.streams[0]"), true);
  assert.equal(await page.eval("document.querySelector('[data-test=camera] [data-result]').dataset.status"), "not-tested");
  await page.eval("document.querySelector('[data-test=camera] [data-feedback=pass]').click(); document.querySelector('[data-action=stop-camera]').click()");
  assert.equal(await page.eval("__test.streams[0].track.stopped && document.querySelector('#camera-preview').srcObject === null"), true);
  await page.eval("document.querySelector('[data-action=start-microphone]').click()");
  await page.wait("!document.querySelector('#microphone-workspace').hidden");
  assert.deepEqual(await page.eval("__test.mediaCalls[3]"), { audio: true, video: false });
  assert.ok(await page.eval("Number(document.querySelector('#microphone-level').value) > 0"));
  assert.deepEqual(await page.eval("__test.audioContexts[0].connections.map(({from,to}) => ({from,to}))"), [{ from: "microphone", to: "analyser" }]);
  await page.eval("document.querySelector('[data-test=microphone] [data-feedback=fail]').click(); document.querySelector('[data-action=stop-microphone]').click()");
  assert.equal(await page.eval("__test.streams[1].track.stopped && __test.audioContexts[0].state === 'closed' && Number(document.querySelector('#microphone-level').value) === 0"), true);
}));

test("device and audio initialization errors block feedback and release resources", async () => usingPage({}, async (page) => {
  await page.eval("__test.mediaModes.push('missing'); document.querySelector('[data-action=start-camera]').click()");
  await page.wait("document.querySelector('[data-test=camera] [data-result]').dataset.status === 'unavailable'");
  assert.match(await page.eval("document.querySelector('#camera-message').textContent"), /No matching device/);
  await page.eval("__test.failAudio = true; document.querySelector('[data-action=start-microphone]').click()");
  await page.wait("document.querySelector('[data-test=microphone] [data-result]').dataset.status === 'unavailable'");
  assert.equal(await page.eval("__test.streams[0].track.stopped"), true);
  assert.equal(await page.eval("document.querySelector('[data-test=microphone] [data-feedback=pass]').disabled"), true);
  await page.eval("document.querySelector('[data-action=start-audio]').click()");
  await page.wait("document.querySelector('[data-test=audio] [data-result]').dataset.status === 'unavailable'");
  assert.equal(await page.eval("document.querySelector('[data-test=audio] [data-feedback=pass]').disabled"), true);
  assert.equal(await page.eval("document.querySelector('[data-action=start-audio]').disabled"), false);
}));

test("pending permissions and active streams are stopped on hide or pagehide", async () => usingPage({}, async (page) => {
  await page.eval("__test.mediaModes.push('pending'); document.querySelector('[data-action=start-camera]').click()");
  await page.wait("__test.pendingMedia.length === 1");
  await page.eval("document.querySelector('[data-action=stop-camera]').click(); __test.pendingMedia[0].resolve(__test.makeStream())");
  await page.wait("__test.streams[0].track.stopped");
  await page.eval("__test.mediaModes.push('pending'); document.querySelector('[data-action=start-camera]').click(); document.querySelector('[data-action=stop-camera]').click(); __test.pendingMedia[1].reject(new DOMException('Denied', 'NotAllowedError'))");
  await flush();
  assert.equal(await page.eval("document.querySelector('[data-test=camera] [data-result]').dataset.status"), "not-tested");
  await page.eval("__test.mediaModes.push('pending'); document.querySelector('[data-action=start-microphone]').click()");
  await page.wait("__test.pendingMedia.length === 3");
  await page.eval("Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); __test.pendingMedia[2].resolve(__test.makeStream())");
  await page.wait("__test.streams[1].track.stopped");
  await page.eval("Object.defineProperty(document, 'hidden', {configurable: true, value: false}); document.querySelector('[data-action=start-camera]').click(); document.querySelector('[data-action=start-microphone]').click()");
  await page.wait("!document.querySelector('#camera-workspace').hidden && !document.querySelector('#microphone-workspace').hidden");
  await page.eval("document.querySelector('[data-action=start-audio]').click(); document.querySelector('[data-action=start-gpu]').click()");
  await page.wait("!document.querySelector('[data-test=audio] [data-feedback=pass]').disabled");
  await page.eval("window.dispatchEvent(new Event('pagehide'))");
  assert.equal(await page.eval("__test.streams[2].track.stopped && __test.streams[3].track.stopped && __test.audioContexts.every(context => context.state === 'closed') && document.querySelector('#gpu-workspace').hidden"), true);
}));

test("audio and graphics need user confirmation and handle unavailable WebGL", async () => usingPage({}, async (page) => {
  await page.eval("document.querySelector('[data-action=start-audio]').click()");
  await page.wait("!document.querySelector('[data-test=audio] [data-feedback=pass]').disabled");
  const audio = await page.eval("({ connections: __test.audioContexts[0].connections, oscillators: __test.audioContexts[0].oscillators.map(({started,stopped}) => ({started,stopped})), status: document.querySelector('[data-test=audio] [data-result]').dataset.status })");
  assert.deepEqual(audio.connections.filter((edge) => edge.from === "gain").map((edge) => edge.input), [0, 1]);
  assert.ok(audio.oscillators[1].started > audio.oscillators[0].stopped);
  assert.equal(audio.status, "not-tested");
  await page.eval("document.querySelector('[data-test=audio] [data-feedback=pass]').click(); document.querySelector('[data-action=stop-audio]').click()");
  assert.equal(await page.eval("__test.audioContexts[0].state"), "closed");
  await page.eval("__test.graphicsAvailable = false; document.querySelector('[data-action=start-gpu]').click()");
  assert.equal(await page.eval("document.querySelector('[data-test=gpu] [data-result]').dataset.status"), "unavailable");
  assert.equal(await page.eval("document.querySelector('[data-test=gpu] [data-feedback=pass]').disabled"), true);
  await page.eval("__test.graphicsAvailable = true; document.querySelector('[data-action=start-gpu]').click()");
  assert.equal(await page.eval("__test.graphicsCalls.filter(call => call[0] === 'scissor').length"), 3);
  assert.equal(await page.eval("document.querySelector('[data-test=gpu] [data-result]').dataset.status"), "not-tested");
  await page.eval("document.querySelector('[data-test=gpu] [data-feedback=fail]').click(); document.querySelector('[data-action=stop-gpu]').click(); document.querySelector('[data-action=start-gpu]').click()");
  assert.equal(await page.eval("document.querySelector('#gpu-workspace').hidden"), false);
}));

test("manual port, wireless and physical checks record only explicit human responses", async () => usingPage({}, async (page) => {
  const initial = await page.eval("({ requests: __test.requests.length, enabled: [!document.querySelector('[data-test=ports] [data-feedback=pass]').disabled, !document.querySelector('[data-test=wireless] [data-feedback=pass]').disabled, !document.querySelector('[data-test=physical_condition] [data-feedback=pass]').disabled] })");
  assert.deepEqual(initial, { requests: 0, enabled: [true, true, true] });
  await page.eval(`document.querySelector('[data-test="ports"] [data-feedback=unavailable]').click(); document.querySelector('[data-test="physical_condition"] [data-feedback=fail]').click()`);
  assert.equal(await page.eval(`document.querySelector('[data-test="ports"] [data-result]').dataset.status`), "unavailable");
  assert.equal(await page.eval(`document.querySelector('[data-test="physical_condition"] [data-result]').dataset.status`), "fail");
  assert.match(await page.eval(`document.querySelector('[data-test="physical_condition"] .test-guidance').textContent`), /stop using or charging/i);
  assert.equal(await page.eval("__test.requests.length"), 0);
}));

test("system tests require explicit actions, confirmation and export only sanitized results", async () => usingPage({}, async (page) => {
  assert.equal(await page.eval("__test.requests.length"), 0);
  assert.equal(await page.eval("document.querySelector('#verify-volume').disabled"), true);
  assert.equal(await page.eval("document.querySelector('#network-quality-start').disabled"), true);
  await page.eval("document.querySelector('#verify-volume').click(); document.querySelector('#network-quality-start').click()");
  assert.equal(await page.eval("__test.requests.length"), 0);

  await page.eval(`__test.systemResponses.filesystem.push({ status: 200, data: { status: "no-anomaly-detected", summary: "Volume verification reported no issue.", details: "No raw command output." } }); document.querySelector('#filesystem-confirmed').checked = true; document.querySelector('#filesystem-confirmed').dispatchEvent(new Event('change')); document.querySelector('#verify-volume').click()`);
  await page.wait("document.querySelector('#filesystem-result').dataset.status === 'no-anomaly-detected'");
  const filesystemRequest = await page.eval("__test.requests[0]");
  assert.equal(filesystemRequest.url, "/api/tests/filesystem");
  assert.equal(filesystemRequest.options.method, "POST");
  assert.equal(filesystemRequest.options.headers["X-Macdry-Token"], token);

  await page.eval(`__test.systemResponses.network_quality.push({ status: 200, data: { status: "measurement-recorded", summary: "Measured.", details: "No hardware verdict.", metrics: { download_mbps: 20, upload_mbps: 5, secret: "PRIVATE_INTERFACE" }, interface_name: "PRIVATE_INTERFACE" } }); document.querySelector('#network-quality-confirmed').checked = true; document.querySelector('#network-quality-confirmed').dispatchEvent(new Event('change')); document.querySelector('#network-quality-start').click()`);
  await page.wait("document.querySelector('#network_quality-result').dataset.status === 'measurement-recorded'");
  assert.match(await page.eval("document.querySelector('#network_quality-state').textContent"), /Download: 20 Mbps/);

  await page.eval(`__test.systemResponses.logs.push({ status: 200, data: { status: "warning", summary: "2 filtered entries found.", details: "Aggregate only.", matches: { panic: 1, storage: 1, battery: 0, thermal: 0, sensor: 0 }, raw: "PRIVATE_RAW_LOG" } }); document.querySelector('#scan-logs').click()`);
  await page.wait("document.querySelector('#logs-result').dataset.status === 'warning'");
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.system_tests.filesystem.status, "no-anomaly-detected");
  assert.equal(report.system_tests.network_quality.metrics.download_mbps, 20);
  assert.equal(report.system_tests.network_quality.metrics.secret, undefined);
  assert.equal(report.system_tests.logs.matches.panic, 1);
  assert.equal(JSON.stringify(report).includes("PRIVATE_INTERFACE"), false);
  assert.equal(JSON.stringify(report).includes("PRIVATE_RAW_LOG"), false);
  assert.deepEqual(report.summary.system_tests, { run: 3, unavailable: 0 });
}));

test("controlled load test requires normal preflight and explicit confirmation before its bounded workload", async () => usingPage({}, async (page) => {
  assert.equal(await page.eval("__test.workers.length"), 0);
  await page.eval(`__test.preflightResponses.push({ status: 200, data: { eligible: false, checks: [
    { id: "memory_pressure", status: "warning", summary: "Elevated pressure" },
    { id: "thermal", status: "info", summary: "Normal warning snapshot" }
  ] } }); document.querySelector('#load-preflight').click()`);
  await page.wait("document.querySelector('#load-test-result').dataset.status === 'blocked'");
  assert.equal(await page.eval("document.querySelector('#load-start').disabled"), true);
  assert.equal(await page.eval("__test.workers.length"), 0);

  await page.eval(`__test.preflightResponses.push({ status: 200, data: { eligible: true, checks: [
    { id: "memory_pressure", status: "info", summary: "Normal pressure" },
    { id: "thermal", status: "unavailable", summary: "No thermal warning level was recorded." }
  ] } }); document.querySelector('#load-preflight').click()`);
  await page.wait("!document.querySelector('#load-confirmation').hidden");
  assert.match(await page.eval("document.querySelector('#load-preflight-state').textContent"), /cannot monitor heat/i);
  assert.equal(await page.eval("document.querySelector('#load-confirmed').checked"), false);
  assert.equal(await page.eval("document.querySelector('#load-start').disabled"), true);
  assert.equal(await page.eval("__test.workers.length"), 0);

  await page.eval("__test.fastGpu = true; document.querySelector('#load-confirmed').checked = true; document.querySelector('#load-confirmed').dispatchEvent(new Event('change')); document.querySelector('#load-start').click()");
  await page.wait("document.querySelector('#load-test-result').dataset.status === 'no-anomaly-detected'");
  const run = await page.eval(`({ workers: __test.workers.length, messages: __test.workerMessages.map(({type}) => type), components: document.querySelector('#summary-load-test').textContent, message: document.querySelector('#load-test-message').textContent, terminated: __test.workers.every(worker => worker.terminated) })`);
  assert.deepEqual(run.messages, ["cpu", "cpu", "memory"]);
  assert.match(run.components, /Nothing unusual detected during this test/);
  assert.match(run.message, /does not certify/);
  assert.equal(run.terminated, true);
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.hardware_load_test.status, "no-anomaly-detected");
  assert.ok(report.hardware_load_test.duration_seconds <= 900);
  assert.deepEqual(report.hardware_load_test.components, {
    cpu: "no-anomaly-detected", memory: "no-anomaly-detected", gpu: "no-anomaly-detected"
  });
  assert.match(report.hardware_load_test.limitations, /software rendering/);
  assert.deepEqual(report.hardware_load_test.preflight, { memory_pressure: "info", thermal: "unavailable" });
  assert.equal(await page.eval("__test.requests.filter((request) => request.url === '/api/load-test/preflight').every((request) => request.options.headers['X-Macdry-Token'] === '" + token + "')"), true);
}));

test("a memory anomaly stops later phases and is not reported as a successful test", async () => usingPage({}, async (page) => {
  await page.eval("__test.fastGpu = true; __test.workerModes.push('complete', 'complete', 'anomaly-detected'); document.querySelector('#load-preflight').click()");
  await page.wait("!document.querySelector('#load-confirmation').hidden");
  await page.eval("document.querySelector('#load-confirmed').checked = true; document.querySelector('#load-confirmed').dispatchEvent(new Event('change')); document.querySelector('#load-start').click()");
  await page.wait("document.querySelector('#load-test-result').dataset.status === 'anomaly-detected'");
  const result = await page.eval(`({ messages: __test.workerMessages.map(({type}) => type), components: document.querySelector('#load-test-result').dataset.status, summary: document.querySelector('#summary-load-test').textContent })`);
  assert.deepEqual(result.messages, ["cpu", "cpu", "memory"]);
  assert.equal(result.components, "anomaly-detected");
  assert.match(result.summary, /An anomaly was detected/);
  assert.equal(await page.eval("document.querySelector('#load-test-workspace').hidden"), true);
}));

test("stopping a running load test terminates its workers and records interruption", async () => usingPage({}, async (page) => {
  await page.eval("__test.workerModes.push('pending', 'pending'); document.querySelector('#load-preflight').click()");
  await page.wait("!document.querySelector('#load-confirmation').hidden");
  await page.eval("document.querySelector('#load-confirmed').checked = true; document.querySelector('#load-confirmed').dispatchEvent(new Event('change')); document.querySelector('#load-start').click()");
  await page.wait("__test.workerMessages.length === 2");
  await page.eval("document.querySelector('#load-stop').click()");
  await page.wait("document.querySelector('#load-test-result').dataset.status === 'interrupted'");
  assert.equal(await page.eval("__test.workers.every(worker => worker.terminated)"), true);
  assert.equal(await page.eval("__test.workerMessages.some(({type}) => type === 'memory')"), false);
  assert.equal(await page.eval("document.querySelector('#load-stop').disabled"), true);
}));

test("load test stops when a live safety snapshot becomes abnormal or unavailable", async () => usingPage({}, async (page) => {
  await page.eval(`__test.preflightResponses.push(
    { status: 200, data: { eligible: true, checks: [
      { id: "memory_pressure", status: "info", summary: "Normal pressure" },
      { id: "thermal", status: "info", summary: "Normal warning snapshot" }
    ] } },
    { status: 200, data: { eligible: false, checks: [
      { id: "memory_pressure", status: "warning", summary: "Elevated pressure" },
      { id: "thermal", status: "info", summary: "Normal warning snapshot" }
    ] } }
  ); __test.workerModes.push('pending', 'pending'); document.querySelector('#load-preflight').click()`);
  await page.wait("!document.querySelector('#load-confirmation').hidden");
  await page.eval("document.querySelector('#load-confirmed').checked = true; document.querySelector('#load-confirmed').dispatchEvent(new Event('change')); document.querySelector('#load-start').click()");
  await page.wait("document.querySelector('#load-test-result').dataset.status === 'interrupted'");
  assert.match(await page.eval("document.querySelector('#load-test-message').textContent"), /memory pressure became abnormal/);
  assert.equal(await page.eval("__test.workers.every(worker => worker.terminated)"), true);
}));

test("export before checks preserves their not-run state without making requests", async () => usingPage({}, async (page) => {
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.version, 3);
  assert.equal(report.checks_state, "not-run");
  assert.equal(report.checks, null);
  assert.equal(report.summary.checks, null);
  assert.ok(report.tests.every((item) => item.status === "not-tested" && item.recommendation));
  assert.deepEqual(report.hardware_load_test, {
    status: "not-run", started_at: null, duration_seconds: null,
    preflight: { memory_pressure: "not-run", thermal: "not-run" },
    components: { cpu: "not-run", memory: "not-run", gpu: "not-run" },
    limitations: "Preflight statuses are retained; an unavailable thermal-warning signal is not a normal reading and means MacDry cannot monitor heat. CPU work runs for at most 14 minutes on two workers; the 256 MiB memory sample covers only a small portion of RAM and macOS may still swap. WebGL may use software rendering. No-anomaly-detected is not proof of hardware health."
  });
  assert.deepEqual(report.summary.system_tests, { run: 0, unavailable: 0 });
  assert.deepEqual(Object.keys(report.system_tests), ["filesystem", "network_quality", "logs"]);
  assert.equal(await page.eval("__test.requests.length + __test.mediaCalls.length + __test.workers.length"), 0);
}));

test("export while media streams are active includes no device or media data", async () => usingPage({}, async (page) => {
  await page.eval("document.querySelector('[data-action=start-camera]').click(); document.querySelector('[data-action=start-microphone]').click()");
  await page.wait("!document.querySelector('#camera-workspace').hidden && !document.querySelector('#microphone-workspace').hidden");
  await page.eval("__test.streams[0].track.label = 'PRIVATE_DEVICE_NAME'; __test.streams[0].frame = 'PRIVATE_CAMERA_FRAME'; __test.streams[1].audio = 'PRIVATE_AUDIO_DATA'; document.querySelector('[data-test=camera] [data-feedback=pass]').click(); document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.tests.find((item) => item.id === "camera").status, "pass");
  for (const secret of ["PRIVATE_DEVICE_NAME", "PRIVATE_CAMERA_FRAME", "PRIVATE_AUDIO_DATA"]) {
    assert.ok(!JSON.stringify(report).includes(secret));
  }
  assert.equal(await page.eval("__test.requests.length + __test.localStorageReads + __test.recorderCalls"), 0);
  await page.eval("window.dispatchEvent(new Event('pagehide'))");
  assert.equal(await page.eval("__test.streams.every(stream => stream.track.stopped)"), true);
}));

test("download preserves filtered engine observations and recommendations while excluding extra data", async () => usingPage({}, async (page) => {
  const power = {
    id: "battery_power", title: "Battery and power", status: "info",
    summary: "Charge: 75%. Charger connected. Charging. ",
    details: "Snapshot only; charge is a percentage of current full charge, not maximum capacity or battery health. Not charging while connected can be normal.",
    source: "system_profiler SPPowerDataType",
    recommendation: "Check Battery settings if behavior is unexpected; this is not a health test.",
  };
  const thermal = {
    id: "thermal", title: "Thermal warning", status: "warning",
    summary: "macOS reports a critical thermal warning.",
    details: "macOS thermal warning category (unitless), not a temperature; availability and platform-specific levels vary. A snapshot cannot assess cooling or hardware health.",
    source: "pmset -g therm",
    recommendation: "Save work, stop activity and let the Mac cool; seek service if it persists.",
  };
  const pressure = {
    id: "memory_pressure", title: "Memory pressure", status: "warning",
    summary: "macOS reports elevated memory pressure.",
    details: "macOS system-wide pressure category (unitless), sampled once; it is not a memory hardware test. This private interface may change.",
    source: "sysctl kern.memorystatus_vm_pressure_level",
    recommendation: "Close unnecessary apps and check Memory Pressure in Activity Monitor.",
  };
  const incoming = [
    { ...power, extra: "PRIVATE_DEVICE", serial: "PRIVATE_SERIAL", token, nested: { camera: "PRIVATE_CAMERA_DATA" } },
    { ...thermal, audio: "PRIVATE_MICROPHONE_DATA" }, pressure,
    { id: "unknown-PRIVATE_DEVICE", status: "future", title: "PRIVATE_DEVICE", summary: "PRIVATE_SERIAL", recommendation: "PRIVATE_CAMERA_DATA" },
    { id: "battery", status: "future", title: null, summary: { secret: "PRIVATE_SERIAL" }, details: ["PRIVATE_CAMERA_DATA"], source: token, recommendation: null },
  ];
  await page.eval(`__test.responses.push({status: 200, data: {checks: ${JSON.stringify(incoming)}}}); document.querySelector('#refresh-checks').click()`);
  await page.wait("document.querySelectorAll('.check-card').length === 5");
  await page.eval(`document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'NumpadAdd'})); document.querySelector('[data-test=keyboard] [data-feedback=pass]').click(); __test.mediaModes.push('denied'); document.querySelector('[data-action=start-camera]').click()`);
  assert.equal(await page.eval("document.querySelector('#keyboard-feedback').textContent"), "Last physical key: NumpadAdd");
  await page.wait("document.querySelector('[data-test=camera] [data-result]').dataset.status === 'unavailable'");
  assert.equal(await page.eval("__test.downloads.length"), 0);
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.deepEqual(Object.keys(report), ["version", "date", "limitations", "summary", "checks_state", "checks", "tests", "system_tests", "hardware_load_test"]);
  assert.equal(report.checks_state, "complete");
  assert.equal(report.version, 3);
  assert.ok(!Number.isNaN(Date.parse(report.date)));
  assert.deepEqual(report.checks.slice(0, 3), [power, thermal, pressure]);
  assert.deepEqual(report.checks[3], { id: "other-4", status: "unknown", recommendation: "Review the source and retry the local check; an unavailable or unknown result is not a diagnosis." });
  assert.deepEqual(report.checks[4], { id: "battery", title: null, status: "unknown", summary: null, details: null, source: "[redacted]", recommendation: "Review the source and retry the local check; an unavailable or unknown result is not a diagnosis." });
  assert.match(await page.eval("document.querySelector('#report .report-copy p:last-child').textContent"), /filtered local observations.*review the file before sharing/i);
  assert.deepEqual(report.tests.map(({ id, status }) => ({ id, status })), [
    { id: "keyboard", status: "pass" }, { id: "pointer", status: "not-tested" },
    { id: "camera", status: "unavailable" }, { id: "microphone", status: "not-tested" },
    { id: "audio", status: "not-tested" }, { id: "gpu", status: "not-tested" },
    { id: "ports", status: "not-tested" }, { id: "wireless", status: "not-tested" },
    { id: "physical_condition", status: "not-tested" },
  ]);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_KEY"));
  assert.ok(!JSON.stringify(report).includes("NumpadAdd"));
  for (const secret of ["PRIVATE_DEVICE", "PRIVATE_SERIAL", "PRIVATE_CAMERA_DATA", "PRIVATE_MICROPHONE_DATA"]) {
    assert.ok(!JSON.stringify(report).includes(secret));
  }
  assert.deepEqual(await page.eval("__test.downloads"), [{ href: "blob:mock-1", filename: "macdry-report.json" }]);
  await page.wait("__test.revoked.includes('blob:mock-1')");
  assert.equal(await page.eval("__test.requests.length"), 1);
  assert.equal(await page.eval("__test.localStorageReads + __test.recorderCalls"), 0);
  assert.deepEqual(await page.eval("Object.keys(sessionStorage)"), ["macdry-session-token"]);
}));
