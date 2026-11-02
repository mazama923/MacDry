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
    runId: Math.random().toString(36), requests: [], responses: [], pendingRequests: [],
    mediaCalls: [], mediaModes: [], pendingMedia: [], streams: [], audioContexts: [],
    graphicsAvailable: true, graphicsCalls: [], downloads: [], blobs: [], revoked: [],
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
    if (url !== "/api/checks") throw new Error("Unexpected network request");
    let response = state.responses.shift() || { status: 200, data: { checks: [] } };
    if (response.deferred) response = await new Promise((resolve) => state.pendingRequests.push(resolve));
    if (response.reject) throw new Error(response.reject);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, json: async () => response.data };
  };
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
    SCISSOR_TEST: 1, COLOR_BUFFER_BIT: 2,
    isContextLost: () => false,
    viewport(...args) { state.graphicsCalls.push(["viewport", ...args]); },
    enable() {}, disable() {},
    scissor(...args) { state.graphicsCalls.push(["scissor", ...args]); },
    clearColor(...args) { state.graphicsCalls.push(["clearColor", ...args]); },
    clear() {},
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

test("export before checks preserves their unavailable state without making requests", async () => usingPage({}, async (page) => {
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.equal(report.checks, null);
  assert.ok(report.tests.every((item) => item.status === "not-tested"));
  assert.equal(await page.eval("__test.requests.length + __test.mediaCalls.length"), 0);
}));

test("download contains only date, server checks and guided results, without token or inputs", async () => usingPage({}, async (page) => {
  await page.eval(`__test.responses.push({status: 200, data: {checks: [${JSON.stringify(check)}]}}); document.querySelector('#refresh-checks').click()`);
  await page.wait("document.querySelectorAll('.check-card').length === 1");
  await page.eval(`document.querySelector('[data-action=start-keyboard]').click(); document.querySelector('#keyboard-area').dispatchEvent(new KeyboardEvent('keydown', {key: 'PRIVATE_KEY', code: 'NumpadAdd'})); document.querySelector('[data-test=keyboard] [data-feedback=pass]').click(); __test.mediaModes.push('denied'); document.querySelector('[data-action=start-camera]').click()`);
  assert.equal(await page.eval("document.querySelector('#keyboard-feedback').textContent"), "Last physical key: NumpadAdd");
  await page.wait("document.querySelector('[data-test=camera] [data-result]').dataset.status === 'unavailable'");
  assert.equal(await page.eval("__test.downloads.length"), 0);
  await page.eval("document.querySelector('#export-report').click()");
  const report = await page.eval("(async () => JSON.parse(await __test.blobs[0].text()))()");
  assert.deepEqual(Object.keys(report), ["date", "checks", "tests"]);
  assert.ok(!Number.isNaN(Date.parse(report.date)));
  assert.deepEqual(report.checks, [check]);
  assert.deepEqual(report.tests, [
    { id: "keyboard", status: "pass" }, { id: "pointer", status: "not-tested" },
    { id: "camera", status: "unavailable" }, { id: "microphone", status: "not-tested" },
    { id: "audio", status: "not-tested" }, { id: "gpu", status: "not-tested" },
  ]);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_KEY"));
  assert.ok(!JSON.stringify(report).includes("NumpadAdd"));
  assert.deepEqual(await page.eval("__test.downloads"), [{ href: "blob:mock-1", filename: "macdry-report.json" }]);
  await page.wait("__test.revoked.includes('blob:mock-1')");
  assert.equal(await page.eval("__test.requests.length"), 1);
  assert.equal(await page.eval("__test.localStorageReads + __test.recorderCalls"), 0);
  assert.deepEqual(await page.eval("Object.keys(sessionStorage)"), ["macdry-session-token"]);
}));
