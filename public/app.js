"use strict";

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const testIds = ["keyboard", "pointer", "camera", "microphone", "audio", "gpu"];
  const results = Object.fromEntries(testIds.map((id) => [id, "not-tested"]));
  const labels = { "not-tested": "Not tested", pass: "Pass", fail: "Fail", unavailable: "Unavailable" };
  const checkStatuses = ["fail", "warning", "info", "unavailable", "unknown"];
  const checkIds = new Set(["macos", "model", "cpu", "memory", "gpu", "storage", "smart", "battery", "memory_pressure", "battery_power", "thermal"]);
  const loadTest = {
    status: "not-run",
    startedAt: null,
    durationSeconds: null,
    preflight: { memory_pressure: "not-run", thermal: "not-run" },
    components: { cpu: "not-run", memory: "not-run", gpu: "not-run" }
  };
  const loadStatusLabels = {
    "not-run": "Not run",
    running: "Running",
    "no-anomaly-detected": "No anomaly detected",
    "anomaly-detected": "Anomaly detected",
    incomplete: "Incomplete",
    interrupted: "Stopped",
    blocked: "Blocked"
  };
  let checks = null;
  let checksState = "not-run";
  let checksRequest = 0;
  const tokenKey = "macdry-session-token";
  let token = window.location.hash.slice(1);
  let storageUnavailable = false;
  if (token) {
    try { token = decodeURIComponent(token); } catch { /* Treat a malformed fragment as the literal token. */ }
    history.replaceState(history.state, "", window.location.pathname + window.location.search);
    try {
      window.sessionStorage.setItem(tokenKey, token);
    } catch {
      storageUnavailable = true;
      try { window.sessionStorage.removeItem(tokenKey); } catch { /* Storage is unavailable. */ }
    }
  } else {
    try { token = window.sessionStorage.getItem(tokenKey) || ""; } catch { storageUnavailable = true; }
  }
  if (storageUnavailable) {
    const notice = $("#token-storage-notice");
    notice.hidden = false;
    notice.textContent = token
      ? "Session storage is unavailable. Checks can run with the current link, but reloading may require opening that link again."
      : "Session storage is unavailable. Open the original session link to run checks.";
  }

  function card(id) { return document.querySelector(`[data-test="${id}"]`); }
  function action(name) { return document.querySelector(`[data-action="${name}"]`); }
  function setResult(id, status) {
    results[id] = status;
    const badge = $("[data-result]", card(id));
    badge.textContent = labels[status];
    badge.dataset.status = status;
    $$('[data-feedback]', card(id)).forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.feedback === status));
    });
    let guidance = $(".test-guidance", card(id));
    if (!guidance) {
      guidance = document.createElement("p");
      guidance.className = "test-guidance";
      card(id).append(guidance);
    }
    guidance.textContent = `Next step: ${testRecommendation(id, status)}`;
    renderSummary();
  }
  function enableFeedback(id, enabled) {
    $$('[data-feedback]', card(id)).forEach((button) => { button.disabled = !enabled; });
  }
  function beginTest(id) {
    setResult(id, "not-tested");
    enableFeedback(id, false);
  }
  function unavailable(id) {
    setResult(id, "unavailable");
    enableFeedback(id, false);
  }
  testIds.forEach((id) => {
    const testCard = card(id);
    const badge = $("[data-result]", testCard);
    const name = $("h3", testCard).textContent;
    badge.setAttribute("role", "status");
    badge.setAttribute("aria-live", "polite");
    $(".feedback", testCard).setAttribute("role", "group");
    setResult(id, "not-tested");
    $$('[data-feedback]', testCard).forEach((button) => {
      button.setAttribute("aria-label", `Mark ${name} test as ${button.dataset.feedback}`);
      button.addEventListener("click", () => setResult(id, button.dataset.feedback));
    });
  });

  // Keep navigation within the page without reintroducing a fragment that could be mistaken for a token on reload.
  $$('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const target = document.getElementById(link.getAttribute("href").slice(1));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      if (link.classList.contains("skip-link")) {
        target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    });
  });

  function checkStatus(check) {
    return checkStatuses.includes(check.status) ? check.status : "unknown";
  }
  function countStatuses(items, statuses, getStatus) {
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    items.forEach((item) => { counts[getStatus(item)] += 1; });
    return counts;
  }
  function checkCounts() {
    return checks === null ? null : countStatuses(checks, checkStatuses, checkStatus);
  }
  function testCounts() {
    return countStatuses(testIds, Object.keys(labels), (id) => results[id]);
  }
  function renderSummary() {
    const local = checkCounts();
    const messages = {
      "not-run": token ? "Not run yet." : "Not run yet. A session token is required to run checks.",
      loading: "Loading local checks…",
      unavailable: "Local checks are unavailable. Check the message below and retry."
    };
    $("#summary-checks").textContent = checksState === "complete"
      ? `Complete: Anomalies: ${local.fail} · Alerts: ${local.warning} · Informational: ${local.info} · Unavailable: ${local.unavailable} · Unknown: ${local.unknown}${checks.length === 0 ? " (no checks returned)" : ""}`
      : messages[checksState];
    const guided = testCounts();
    $("#summary-tests").textContent = `Human pass: ${guided.pass} · Human fail: ${guided.fail} · Not tested: ${guided["not-tested"]} · Unavailable: ${guided.unavailable}`;
    $("#summary-load-test").textContent = loadSummaryText();
  }
  function loadSummaryText() {
    const messages = {
      "not-run": "Not run.",
      running: "In progress.",
      "no-anomaly-detected": "Nothing unusual detected during this test.",
      "anomaly-detected": "An anomaly was detected during this test.",
      incomplete: "Incomplete; one or more components were unavailable.",
      interrupted: "Stopped before completion.",
      blocked: "Blocked by the readiness check."
    };
    return messages[loadTest.status] || "Unknown result.";
  }
  function renderLoadTest() {
    const badge = $("#load-test-result");
    badge.dataset.status = loadTest.status;
    badge.textContent = loadStatusLabels[loadTest.status] || "Unknown";
    renderSummary();
  }
  function checkRecommendation(check) {
    const status = checkStatus(check);
    if (status === "unavailable" || status === "unknown") return "Review the source and retry the local check; an unavailable or unknown result is not a diagnosis.";
    if (status === "info") return "Review what the source actually measures; information alone does not establish hardware health.";
    if (check.id === "smart") return "Back up important data and investigate the reported SMART alert with a qualified technician.";
    if (check.id === "battery") return "Review the battery condition in macOS and consider an authorized service assessment.";
    if (check.id === "storage") return "Review available storage and free space if needed; this is not a disk health test.";
    return "Review the details and source, then investigate the reported issue or consult a qualified technician.";
  }
  function engineRecommendation(check) {
    return typeof check.recommendation === "string" && check.recommendation.trim()
      ? check.recommendation : checkRecommendation(check);
  }
  function reportText(value) {
    if (typeof value !== "string") return null;
    return token ? value.replaceAll(token, "[redacted]") : value;
  }
  function reportCheck(check, index) {
    if (!checkIds.has(check.id)) {
      return { id: `other-${index + 1}`, status: checkStatus(check), recommendation: checkRecommendation(check) };
    }
    return {
      id: check.id,
      title: reportText(check.title),
      status: checkStatus(check),
      summary: reportText(check.summary),
      details: reportText(check.details),
      source: reportText(check.source),
      recommendation: reportText(engineRecommendation(check))
    };
  }
  function testRecommendation(id, status) {
    if (status === "not-tested") return "This optional test has no human response yet; run it if relevant.";
    if (status === "unavailable") {
      if (id === "camera" || id === "microphone") return "Check browser and macOS permissions and device availability, then retry if desired.";
      if (id === "gpu") return "Check browser and graphics settings, then retry if desired.";
      if (id === "audio") return "Check browser and audio output settings, then retry if desired.";
      return "Check browser support and retry if desired.";
    }
    if (status === "fail") return "Repeat the guided test and check relevant settings or seek further assessment if the issue persists.";
    return "This records a human response to a limited test, not proof of hardware health.";
  }
  function displayValue(value) {
    if (value == null) return "";
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }
  function renderChecks(items) {
    const list = $("#checks-list");
    list.replaceChildren();
    items.forEach((check) => {
      const item = document.createElement("article");
      item.className = "check-card";
      const top = document.createElement("div");
      top.className = "check-card-top";
      const title = document.createElement("h3");
      title.textContent = displayValue(check.title) || "Untitled check";
      const badge = document.createElement("span");
      badge.className = "check-badge";
      const status = checkStatus(check);
      badge.dataset.status = status;
      badge.textContent = { info: "Informational", warning: "Alert", fail: "Anomaly", unavailable: "Unavailable", unknown: "Unknown" }[status];
      top.append(title, badge);
      const summary = document.createElement("p");
      summary.textContent = displayValue(check.summary) || "No summary provided.";
      item.append(top, summary);
      const recommendation = document.createElement("p");
      recommendation.className = "check-recommendation";
      const recommendationLabel = document.createElement("strong");
      recommendationLabel.textContent = "Verification: ";
      recommendation.append(recommendationLabel, document.createTextNode(engineRecommendation(check)));
      item.append(recommendation);
      if (check.details != null && displayValue(check.details) !== "") {
        const details = document.createElement("details");
        const heading = document.createElement("summary");
        heading.textContent = "View details";
        const content = document.createElement("pre");
        content.textContent = displayValue(check.details);
        details.append(heading, content);
        item.append(details);
      }
      if (check.source != null && displayValue(check.source) !== "") {
        const source = document.createElement("p");
        source.className = "check-source";
        source.textContent = `Source: ${displayValue(check.source)}`;
        item.append(source);
      }
      list.append(item);
    });
  }
  async function loadChecks() {
    const state = $("#checks-state");
    const request = ++checksRequest;
    checks = null;
    checksState = token ? "loading" : "unavailable";
    renderSummary();
    $("#checks-list").replaceChildren();
    state.classList.remove("is-error");
    if (!token) {
      state.classList.add("is-error");
      state.textContent = "No session token found. Open the complete local link provided by MacDry, then try again.";
      return;
    }
    state.textContent = "Loading local checks…";
    $("#refresh-checks").textContent = "Refresh checks ↻";
    try {
      const response = await fetch("/api/checks", {
        method: "GET", headers: { "X-Macdry-Token": token }, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer"
      });
      if (!response.ok) throw new Error(`Local server returned HTTP ${response.status}.`);
      const data = await response.json();
      if (!data || !Array.isArray(data.checks) || data.checks.some((check) => !check || typeof check !== "object" || Array.isArray(check))) {
        throw new Error("The local server returned an invalid checks response.");
      }
      if (request !== checksRequest) return;
      checks = data.checks;
      renderChecks(checks);
      checksState = "complete";
      renderSummary();
      state.textContent = checks.length ? `${checks.length} ${checks.length === 1 ? "check" : "checks"} returned. Select details for more context.` : "The local server returned no checks.";
    } catch (error) {
      if (request !== checksRequest) return;
      checks = null;
      checksState = "unavailable";
      $("#checks-list").replaceChildren();
      renderSummary();
      state.classList.add("is-error");
      state.textContent = error instanceof Error && /^Local server returned HTTP \d+\.$|^The local server returned an invalid checks response\.$/.test(error.message)
        ? `${error.message} Check the local server and session link, then retry.`
        : "Could not load local checks. Check the local server and session link, then retry.";
    }
  }
  $("#refresh-checks").addEventListener("click", loadChecks);

  let keyboardActive = false;
  const keyboardArea = $("#keyboard-area");
  action("start-keyboard").addEventListener("click", () => {
    beginTest("keyboard");
    keyboardActive = true;
    $("#keyboard-workspace").hidden = false;
    $("#keyboard-feedback").textContent = "Waiting for a keydown in this area.";
    enableFeedback("keyboard", true);
    keyboardArea.focus();
  });
  keyboardArea.addEventListener("keydown", (event) => {
    if (keyboardActive && document.activeElement === keyboardArea) {
      $("#keyboard-feedback").textContent = event.code && event.code !== "Unidentified" ? `Last physical key: ${event.code}` : "Physical key code unavailable.";
    }
  });
  function stopKeyboard() {
    keyboardActive = false;
    $("#keyboard-feedback").textContent = "Waiting for a keydown in this area.";
    $("#keyboard-workspace").hidden = true;
  }
  action("stop-keyboard").addEventListener("click", stopKeyboard);

  let pointerActive = false;
  let pointerEvents = { move: false, click: false, scroll: false };
  const pointerArea = $("#pointer-area");
  function pointerObserved(kind) {
    if (!pointerActive || pointerEvents[kind]) return;
    pointerEvents[kind] = true;
    $("#pointer-feedback").textContent = ["move", "click", "scroll"].map((name) => `${name[0].toUpperCase() + name.slice(1)}: ${pointerEvents[name] ? "detected" : "waiting"}`).join(" · ");
  }
  action("start-pointer").addEventListener("click", () => {
    beginTest("pointer");
    pointerEvents = { move: false, click: false, scroll: false };
    $("#pointer-feedback").textContent = "Move: waiting · Click: waiting · Scroll: waiting";
    $("#pointer-workspace").hidden = false;
    pointerActive = true;
    enableFeedback("pointer", true);
    pointerArea.focus();
  });
  pointerArea.addEventListener("pointermove", () => pointerObserved("move"));
  pointerArea.addEventListener("click", () => pointerObserved("click"));
  pointerArea.addEventListener("wheel", () => pointerObserved("scroll"), { passive: true });
  pointerArea.addEventListener("scroll", () => pointerObserved("scroll"), { passive: true });
  function stopPointer() {
    pointerActive = false;
    $("#pointer-workspace").hidden = true;
  }
  action("stop-pointer").addEventListener("click", stopPointer);

  const media = {
    camera: { generation: 0, stream: null, pending: false },
    microphone: { generation: 0, stream: null, pending: false, context: null, frame: 0 }
  };
  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
  }
  function closeContext(context) {
    if (context && context.state !== "closed") context.close().catch(() => {});
  }
  function mediaControls(id, active) {
    action(`start-${id}`).disabled = active;
    action(`stop-${id}`).disabled = !active;
  }
  function stopMedia(id, message) {
    const state = media[id];
    state.generation += 1;
    state.pending = false;
    stopTracks(state.stream);
    state.stream = null;
    if (id === "camera") {
      $("#camera-preview").srcObject = null;
    } else {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
      closeContext(state.context);
      state.context = null;
      $("#microphone-level").value = 0;
    }
    $(`#${id}-workspace`).hidden = true;
    mediaControls(id, false);
    if (message) $(`#${id}-message`).textContent = message;
  }
  function mediaError(error) {
    if (error && ["NotAllowedError", "SecurityError", "PermissionDeniedError"].includes(error.name)) {
      return "Permission was denied or blocked. Check browser and macOS privacy settings, then retry.";
    }
    if (error && ["NotFoundError", "DevicesNotFoundError"].includes(error.name)) {
      return "No matching device was available. Check the device and browser and macOS permissions, then retry.";
    }
    return "Could not start this test. Check the device, browser and macOS permissions, then retry.";
  }
  async function startMedia(id) {
    const state = media[id];
    if (state.pending || state.stream) return;
    beginTest(id);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || (id === "microphone" && !(window.AudioContext || window.webkitAudioContext))) {
      unavailable(id);
      $(`#${id}-message`).textContent = "This browser cannot run the test here. A secure local context and browser support are required.";
      return;
    }
    const generation = ++state.generation;
    state.pending = true;
    mediaControls(id, true);
    $(`#${id}-message`).textContent = "Waiting for permission. You can stop or cancel this test at any time.";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(id === "camera" ? { video: true, audio: false } : { audio: true, video: false });
      if (state.generation !== generation || document.hidden) { stopTracks(stream); return; }
      state.stream = stream;
      if (id === "camera") {
        $("#camera-preview").srcObject = stream;
        $("#camera-workspace").hidden = false;
        $("#camera-message").textContent = "Live preview is local. Stop when you are finished.";
      } else {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        state.context = context;
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        await context.resume();
        if (state.generation !== generation || document.hidden) { stopTracks(stream); closeContext(context); return; }
        const samples = new Float32Array(analyser.fftSize);
        const updateLevel = () => {
          if (state.generation !== generation) return;
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) sum += sample * sample;
          $("#microphone-level").value = Math.min(100, Math.round(Math.sqrt(sum / samples.length) * 400));
          state.frame = requestAnimationFrame(updateLevel);
        };
        $("#microphone-workspace").hidden = false;
        $("#microphone-message").textContent = "Input level is processed locally. No audio is played back or recorded.";
        updateLevel();
      }
      state.pending = false;
      enableFeedback(id, true);
      stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
        if (state.generation === generation) stopMedia(id, "The device stopped. Start again if you want to retry.");
      }));
    } catch (error) {
      if (state.generation !== generation) { stopTracks(stream); return; }
      stopTracks(stream);
      stopMedia(id, mediaError(error));
      unavailable(id);
    }
  }
  ["camera", "microphone"].forEach((id) => {
    action(`start-${id}`).addEventListener("click", () => startMedia(id));
    action(`stop-${id}`).addEventListener("click", () => stopMedia(id, "Stopped. No media was saved or recorded."));
  });

  let audioContext = null;
  let audioGeneration = 0;
  let audioTimer = 0;
  function stopAudio(message) {
    audioGeneration += 1;
    clearTimeout(audioTimer);
    closeContext(audioContext);
    audioContext = null;
    action("start-audio").disabled = false;
    action("stop-audio").disabled = true;
    if (message) $("#audio-message").textContent = message;
  }
  action("start-audio").addEventListener("click", async () => {
    beginTest("audio");
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      unavailable("audio");
      $("#audio-message").textContent = "Web Audio is not available in this browser.";
      return;
    }
    const generation = ++audioGeneration;
    action("start-audio").disabled = true;
    action("stop-audio").disabled = false;
    $("#audio-message").textContent = "Preparing tones…";
    try {
      const context = new AudioContext();
      audioContext = context;
      await context.resume();
      if (audioGeneration !== generation || document.hidden) { closeContext(context); return; }
      const merger = context.createChannelMerger(2);
      merger.connect(context.destination);
      const start = context.currentTime + 0.1;
      [0, 1].forEach((channel) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = start + channel * 0.8;
        oscillator.frequency.value = 440;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.03);
        gain.gain.setValueAtTime(0.12, at + 0.47);
        gain.gain.linearRampToValueAtTime(0, at + 0.5);
        oscillator.connect(gain);
        gain.connect(merger, 0, channel);
        oscillator.start(at);
        oscillator.stop(at + 0.51);
      });
      enableFeedback("audio", true);
      $("#audio-message").textContent = "Playing left, then right. Confirm what you heard below.";
      audioTimer = setTimeout(() => {
        if (audioGeneration === generation) stopAudio("Tones finished. Confirm what you heard below.");
      }, 1700);
    } catch {
      if (audioGeneration !== generation) return;
      stopAudio("Could not play the tones. Check browser and audio output settings, then retry.");
      unavailable("audio");
    }
  });
  action("stop-audio").addEventListener("click", () => stopAudio("Tones stopped."));

  let gl = null;
  const canvas = $("#gpu-canvas");
  function stopGpu(message) {
    if (gl && !gl.isContextLost()) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl = null;
    $("#gpu-workspace").hidden = true;
    action("stop-gpu").disabled = true;
    action("start-gpu").disabled = false;
    if (message) $("#gpu-message").textContent = message;
  }
  action("start-gpu").addEventListener("click", () => {
    beginTest("gpu");
    try {
      const options = { preserveDrawingBuffer: true };
      gl = canvas.getContext("webgl", options) || canvas.getContext("experimental-webgl", options);
      if (!gl || gl.isContextLost()) throw new Error("WebGL unavailable");
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.enable(gl.SCISSOR_TEST);
      [[0.82, 0.44, 0.34], [0.94, 0.84, 0.62], [0.34, 0.57, 0.48]].forEach((color, index) => {
        gl.scissor(index * 160, 0, 160, 160);
        gl.clearColor(color[0], color[1], color[2], 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      });
      gl.disable(gl.SCISSOR_TEST);
      $("#gpu-workspace").hidden = false;
      action("start-gpu").disabled = true;
      action("stop-gpu").disabled = false;
      $("#gpu-message").textContent = "Look for coral, cream and teal blocks, then confirm below.";
      enableFeedback("gpu", true);
    } catch {
      gl = null;
      unavailable("gpu");
      $("#gpu-message").textContent = "WebGL could not be started. Check browser and graphics settings.";
    }
  });
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    if (gl) {
      gl = null;
      $("#gpu-workspace").hidden = true;
      action("stop-gpu").disabled = true;
      action("start-gpu").disabled = false;
      unavailable("gpu");
      $("#gpu-message").textContent = "The graphics context was lost. Retry when the browser restores it.";
    }
  });
  action("stop-gpu").addEventListener("click", () => stopGpu("Graphics test stopped."));

  const LOAD_CPU_DURATION_MS = 8_000;
  const LOAD_GPU_DURATION_MS = 6_000;
  const LOAD_TEST_TIMEOUT_MS = 20_000;
  const LOAD_CPU_WORKERS = 2;
  let loadPreflightReady = false;
  let loadThermalUnavailableAtStart = false;
  let loadGeneration = 0;
  let loadWorkers = [];
  let loadWorkerCancellations = new Set();
  let loadFrame = 0;
  let loadTimer = 0;
  let loadSafetyTimer = 0;
  let loadSafetyController = null;
  let loadGl = null;
  let loadStartedAt = 0;
  let loadGpuCleanup = () => {};

  function updateLoadStatus(status, message) {
    loadTest.status = status;
    if (message) $("#load-test-message").textContent = message;
    renderLoadTest();
  }
  function blockLoadTest(message) {
    loadTest.startedAt = null;
    loadTest.durationSeconds = null;
    loadTest.components = { cpu: "not-run", memory: "not-run", gpu: "not-run" };
    updateLoadStatus("blocked", message);
  }
  function updateLoadComponent(name, status) {
    loadTest.components[name] = status;
  }
  function renderPreflight(checksToShow) {
    const results = $("#load-preflight-results");
    results.replaceChildren();
    const names = { memory_pressure: "Memory pressure", thermal: "Thermal warning" };
    const statuses = { info: "Normal snapshot", warning: "Warning", unavailable: "Unavailable", unknown: "Unknown" };
    checksToShow.forEach((check) => {
      if (!check || !names[check.id]) return;
      const row = document.createElement("div");
      row.className = "load-preflight-row";
      const label = document.createElement("span");
      label.textContent = names[check.id];
      const value = document.createElement("strong");
      value.textContent = statuses[check.status] || "Unknown";
      row.append(label, value);
      results.append(row);
    });
    results.hidden = results.childElementCount === 0;
  }
  async function checkLoadReadiness() {
    const button = $("#load-preflight");
    const confirmation = $("#load-confirmation");
    const checkbox = $("#load-confirmed");
    const start = $("#load-start");
    button.disabled = true;
    loadPreflightReady = false;
    checkbox.checked = false;
    confirmation.hidden = true;
    start.disabled = true;
    renderPreflight([]);
    $("#load-preflight-state").textContent = "Checking current macOS memory-pressure and thermal-warning signals…";
    if (!token) {
      $("#load-preflight-state").textContent = "A session token is required for the local readiness check.";
      loadTest.preflight = { memory_pressure: "unavailable", thermal: "unavailable" };
      blockLoadTest("The readiness check could not run without the local session token.");
      button.disabled = false;
      return;
    }
    try {
      const response = await fetch("/api/load-test/preflight", {
        method: "GET", headers: { "X-Macdry-Token": token }, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer"
      });
      if (!response.ok) throw new Error("The local readiness check failed.");
      const data = await response.json();
      const pressure = data?.checks?.find((check) => check?.id === "memory_pressure");
      const thermal = data?.checks?.find((check) => check?.id === "thermal");
      const valid = data && Array.isArray(data.checks) && data.checks.length === 2 && pressure && thermal &&
        ["info", "warning", "unavailable", "unknown"].includes(pressure.status) &&
        ["info", "warning", "unavailable", "unknown"].includes(thermal.status);
      if (!valid) throw new Error("The local readiness check returned invalid data.");
      renderPreflight(data.checks);
      loadTest.preflight = { memory_pressure: pressure.status, thermal: thermal.status };
      loadThermalUnavailableAtStart = thermal.status === "unavailable";
      loadPreflightReady = data.eligible === true && pressure.status === "info" &&
        ["info", "unavailable"].includes(thermal.status);
      if (loadPreflightReady) {
        confirmation.hidden = false;
        $("#load-preflight-state").textContent = thermal.status === "unavailable"
          ? "Memory pressure is normal, but the thermal-warning signal is unavailable. MacDry cannot monitor heat; continue only if the Mac is cool and you will stop if it heats or macOS warns."
          : "Memory pressure and the thermal-warning snapshot are normal. Neither reports temperature or guarantees safe conditions.";
        $("#load-test-message").textContent = "Review the checklist and explicitly confirm before starting the workload.";
        if (loadTest.status === "blocked") {
          loadTest.startedAt = null;
          loadTest.durationSeconds = null;
          loadTest.components = { cpu: "not-run", memory: "not-run", gpu: "not-run" };
          updateLoadStatus("not-run");
        }
      } else {
        $("#load-preflight-state").textContent = "A memory-pressure or thermal-warning snapshot is warning, unknown or unavailable. The workload is blocked unless memory pressure is normal and no thermal warning is reported.";
        blockLoadTest("The readiness check reported unsafe or insufficient memory-pressure/thermal-warning signals; no workload ran.");
      }
    } catch {
      $("#load-preflight-state").textContent = "Could not verify readiness from the local server. No workload ran; check the session link and retry.";
      loadTest.preflight = { memory_pressure: "unavailable", thermal: "unavailable" };
      blockLoadTest("The local readiness check was unavailable; no workload ran.");
    } finally {
      button.disabled = false;
    }
  }
  $("#load-preflight").addEventListener("click", checkLoadReadiness);
  $("#load-confirmed").addEventListener("change", (event) => {
    $("#load-start").disabled = !loadPreflightReady || !event.currentTarget.checked || loadTest.status === "running";
  });

  function workerPhase(worker, type, generation) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        loadWorkerCancellations.delete(cancel);
        resolve(status);
      };
      const onMessage = (event) => {
        if (generation !== loadGeneration || event.data?.type !== type) return;
        const allowed = ["no-anomaly-detected", "anomaly-detected", "unavailable", "interrupted"];
        finish(allowed.includes(event.data.status) ? event.data.status : "unavailable");
      };
      const onError = () => finish("unavailable");
      const cancel = () => finish("interrupted");
      const timer = setTimeout(() => finish("unavailable"), type === "cpu" ? LOAD_CPU_DURATION_MS + 1_000 : 5_000);
      loadWorkerCancellations.add(cancel);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError, { once: true });
      try {
        worker.postMessage({ type });
      } catch {
        finish("unavailable");
      }
    });
  }
  function combineWorkerStatuses(statuses) {
    if (statuses.includes("anomaly-detected")) return "anomaly-detected";
    if (statuses.includes("interrupted")) return "interrupted";
    return statuses.length > 0 && statuses.every((status) => status === "no-anomaly-detected") ? "no-anomaly-detected" : "unavailable";
  }
  function cleanupLoadResources() {
    clearTimeout(loadTimer);
    clearTimeout(loadSafetyTimer);
    loadTimer = 0;
    loadSafetyTimer = 0;
    loadSafetyController?.abort();
    loadSafetyController = null;
    if (loadFrame) cancelAnimationFrame(loadFrame);
    loadFrame = 0;
    loadGpuCleanup();
    loadGpuCleanup = () => {};
    loadGl = null;
    for (const cancel of [...loadWorkerCancellations]) cancel();
    loadWorkers.forEach((worker) => worker.terminate());
    loadWorkers = [];
    $("#load-test-workspace").hidden = true;
    $("#load-preflight").disabled = false;
    $("#load-confirmation").hidden = true;
    $("#load-confirmed").checked = false;
    $("#load-start").disabled = true;
    $("#load-stop").disabled = true;
  }
  function finishLoadTest(generation, status, message) {
    if (generation !== loadGeneration) return;
    cleanupLoadResources();
    loadGeneration++;
    for (const name of Object.keys(loadTest.components)) {
      if (loadTest.components[name] === "running") {
        loadTest.components[name] = status === "interrupted" ? "interrupted" : "unavailable";
      }
    }
    loadTest.status = status;
    loadTest.durationSeconds = loadStartedAt ? Math.min(20, Math.ceil((Date.now() - loadStartedAt) / 1000)) : null;
    $("#load-test-message").textContent = message;
    renderLoadTest();
  }
  function stopLoadTest(message = "Stopped. No further workload will run.") {
    if (loadTest.status !== "running") return;
    finishLoadTest(loadGeneration, "interrupted", message);
  }
  $("#load-stop").addEventListener("click", () => stopLoadTest());

  function scheduleLoadSafetyCheck(generation) {
    if (generation !== loadGeneration || loadTest.status !== "running") return;
    loadSafetyTimer = setTimeout(() => runLoadSafetyCheck(generation), 2_500);
  }
  async function runLoadSafetyCheck(generation) {
    if (generation !== loadGeneration || loadTest.status !== "running") return;
    const controller = new AbortController();
    loadSafetyController = controller;
    const timeout = setTimeout(() => controller.abort(), 4_500);
    try {
      const response = await fetch("/api/load-test/preflight", {
        method: "GET", headers: { "X-Macdry-Token": token }, cache: "no-store", credentials: "same-origin", referrerPolicy: "no-referrer", signal: controller.signal
      });
      if (!response.ok) throw new Error("Safety snapshot unavailable");
      const data = await response.json();
      const pressure = data?.checks?.find((check) => check?.id === "memory_pressure");
      const thermal = data?.checks?.find((check) => check?.id === "thermal");
      const thermalSafe = thermal?.status === "info" ||
        (loadThermalUnavailableAtStart && thermal?.status === "unavailable");
      const safe = data?.eligible === true && Array.isArray(data.checks) && data.checks.length === 2 &&
        pressure?.status === "info" && thermalSafe;
      if (!safe) {
        stopLoadTest("Stopped because memory pressure became abnormal or a thermal warning appeared or changed while running.");
        return;
      }
      scheduleLoadSafetyCheck(generation);
    } catch {
      if (generation === loadGeneration && loadTest.status === "running") {
        stopLoadTest("Stopped because the current memory-pressure or thermal-warning snapshot could not be verified.");
      }
    } finally {
      clearTimeout(timeout);
      if (loadSafetyController === controller) loadSafetyController = null;
    }
  }

  function compileLoadShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("Shader unavailable");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("Shader compilation failed");
    return shader;
  }
  function runGpuLoad(generation) {
    return new Promise((resolve) => {
      const canvas = $("#load-canvas");
      let finished = false;
      let context;
      let program;
      let buffer;
      const finish = (status) => {
        if (finished) return;
        finished = true;
        canvas.removeEventListener("webglcontextlost", onContextLost);
        if (buffer && context && !context.isContextLost()) context.deleteBuffer(buffer);
        loadGpuCleanup = () => {};
        resolve(status);
      };
      const onContextLost = (event) => {
        event.preventDefault();
        finish("unavailable");
      };
      try {
        context = canvas.getContext("webgl", { antialias: false, powerPreference: "low-power" });
        if (!context || context.isContextLost()) throw new Error("WebGL unavailable");
        const vertex = compileLoadShader(context, context.VERTEX_SHADER,
          "attribute vec2 a_position; varying vec2 v_uv; void main(){ v_uv=(a_position+1.0)*0.5; gl_Position=vec4(a_position,0.0,1.0); }");
        const fragment = compileLoadShader(context, context.FRAGMENT_SHADER,
          "precision mediump float; uniform float u_time; varying vec2 v_uv; void main(){ vec2 p=(v_uv-0.5)*2.0; float value=0.25; for(int i=0;i<24;i++){ p=vec2(p.x*p.x-p.y*p.y,2.0*p.x*p.y)+vec2(sin(u_time*0.1)*0.01,cos(u_time*0.1)*0.01); value=fract(value+dot(p,p)*0.017); } gl_FragColor=vec4(value,fract(value*1.7),fract(value*2.3),1.0); }");
        program = context.createProgram();
        if (!program) throw new Error("Program unavailable");
        context.attachShader(program, vertex);
        context.attachShader(program, fragment);
        context.linkProgram(program);
        if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error("Program link failed");
        context.useProgram(program);
        const location = context.getAttribLocation(program, "a_position");
        if (location < 0) throw new Error("Attribute unavailable");
        buffer = context.createBuffer();
        if (!buffer) throw new Error("Buffer unavailable");
        context.bindBuffer(context.ARRAY_BUFFER, buffer);
        context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), context.STATIC_DRAW);
        context.enableVertexAttribArray(location);
        context.vertexAttribPointer(location, 2, context.FLOAT, false, 0, 0);
        context.viewport(0, 0, canvas.width, canvas.height);
        const timeLocation = context.getUniformLocation(program, "u_time");
        const started = performance.now();
        loadGl = context;
        loadGpuCleanup = () => finish("interrupted");
        canvas.addEventListener("webglcontextlost", onContextLost);
        $("#load-test-workspace").hidden = false;
        const draw = (now) => {
          if (generation !== loadGeneration || context.isContextLost()) {
            finish("unavailable");
            return;
          }
          context.uniform1f(timeLocation, (now - started) / 1000);
          context.drawArrays(context.TRIANGLES, 0, 6);
          if (context.getError() !== context.NO_ERROR) {
            finish("anomaly-detected");
            return;
          }
          if (now - started >= LOAD_GPU_DURATION_MS) {
            finish("no-anomaly-detected");
            return;
          }
          loadFrame = requestAnimationFrame(draw);
        };
        loadFrame = requestAnimationFrame(draw);
      } catch {
        if (context && buffer && !context.isContextLost()) context.deleteBuffer(buffer);
        finish("unavailable");
      }
    });
  }
  async function startLoadTest() {
    if (!loadPreflightReady || !$("#load-confirmed").checked || loadTest.status === "running") return;
    if (typeof Worker !== "function") {
      updateLoadStatus("incomplete", "This browser cannot run the bounded CPU and memory workers.");
      return;
    }
    const generation = ++loadGeneration;
    loadStartedAt = Date.now();
    loadTest.startedAt = new Date(loadStartedAt).toISOString();
    loadTest.durationSeconds = null;
    loadTest.components = { cpu: "running", memory: "not-run", gpu: "not-run" };
    loadPreflightReady = false;
    $("#load-preflight").disabled = true;
    $("#load-confirmation").hidden = true;
    $("#load-start").disabled = true;
    $("#load-stop").disabled = false;
    $("#load-test-workspace").hidden = false;
    $("#load-test-message").textContent = "CPU workload running on at most two workers. Stop at any time.";
    updateLoadStatus("running", "The bounded workload is running.");
    loadTimer = setTimeout(() => finishLoadTest(generation, "incomplete", "The fixed maximum duration was reached; the test stopped."), LOAD_TEST_TIMEOUT_MS);
    void runLoadSafetyCheck(generation);
    try {
      for (let index = 0; index < LOAD_CPU_WORKERS; index++) loadWorkers.push(new Worker("/load-worker.js"));
    } catch {
      finishLoadTest(generation, "incomplete", "The local workload worker could not start.");
      return;
    }
    const cpu = combineWorkerStatuses(await Promise.all(loadWorkers.map((worker) => workerPhase(worker, "cpu", generation))));
    if (generation !== loadGeneration) return;
    updateLoadComponent("cpu", cpu);
    if (cpu !== "no-anomaly-detected") {
      finishLoadTest(generation, cpu === "anomaly-detected" ? "anomaly-detected" : cpu === "interrupted" ? "interrupted" : "incomplete",
        cpu === "anomaly-detected" ? "The CPU workload produced an inconsistent result. This is not a hardware diagnosis." : "The CPU workload did not complete; remaining phases were not run.");
      return;
    }
    updateLoadComponent("memory", "running");
    $("#load-test-message").textContent = "Checking a bounded 16 MiB memory buffer. Stop at any time.";
    const memory = await workerPhase(loadWorkers[0], "memory", generation);
    if (generation !== loadGeneration) return;
    updateLoadComponent("memory", memory);
    if (memory !== "no-anomaly-detected") {
      finishLoadTest(generation, memory === "anomaly-detected" ? "anomaly-detected" : memory === "interrupted" ? "interrupted" : "incomplete",
        memory === "anomaly-detected" ? "The memory workload found a pattern mismatch. This is not a hardware diagnosis." : "The memory workload did not complete; the graphics phase was not run.");
      return;
    }
    updateLoadComponent("gpu", "running");
    $("#load-test-message").textContent = "Running a short WebGL workload through the browser graphics stack.";
    const gpu = await runGpuLoad(generation);
    if (generation !== loadGeneration) return;
    updateLoadComponent("gpu", gpu);
    if (gpu !== "no-anomaly-detected") {
      finishLoadTest(generation, gpu === "anomaly-detected" ? "anomaly-detected" : "incomplete",
        gpu === "anomaly-detected" ? "The WebGL workload reported a graphics error. This is not a hardware diagnosis." : "The WebGL workload was unavailable or did not complete.");
      return;
    }
    finishLoadTest(generation, "no-anomaly-detected", "Nothing unusual was detected during this test. It does not certify that the Mac is healthy.");
  }
  $("#load-start").addEventListener("click", startLoadTest);

  function stopActiveTests() {
    stopKeyboard();
    stopPointer();
    if (media.camera.stream || media.camera.pending) stopMedia("camera", "Stopped because the page was hidden or closed.");
    if (media.microphone.stream || media.microphone.pending) stopMedia("microphone", "Stopped because the page was hidden or closed.");
    if (audioContext) stopAudio("Tones stopped because the page was hidden or closed.");
    if (gl) stopGpu("Graphics test stopped because the page was hidden or closed.");
    if (loadTest.status === "running") stopLoadTest("Stopped because the page was hidden or closed.");
  }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopActiveTests(); });
  window.addEventListener("pagehide", stopActiveTests);

  $("#export-report").addEventListener("click", () => {
    const report = {
      version: 2,
      date: new Date().toISOString(),
      limitations: "Guided pass and fail are human responses to limited tests, not proof of hardware health. The controlled load test reports only what happened during its bounded CPU, memory and browser graphics workloads; no-anomaly-detected is not a hardware guarantee. Local checks are not a complete diagnosis.",
      summary: { checks: checkCounts(), tests: testCounts() },
      checks_state: checksState,
      checks: checks === null ? null : checks.map(reportCheck),
      tests: testIds.map((id) => ({ id, status: results[id], recommendation: testRecommendation(id, results[id]) })),
      hardware_load_test: {
        status: loadTest.status,
        started_at: loadTest.startedAt,
        duration_seconds: loadTest.durationSeconds,
        components: { ...loadTest.components },
        preflight: { ...loadTest.preflight },
        limitations: "Preflight statuses are retained; an unavailable thermal-warning signal is not a normal reading and means MacDry cannot monitor heat. The 16 MiB memory pattern, bounded CPU calculation and WebGL workload cover only a small portion of the hardware. WebGL may use software rendering. No-anomaly-detected is not proof of hardware health."
      }
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "macdry-report.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  if (!token) {
    const state = $("#checks-state");
    state.classList.add("is-error");
    state.textContent = "No session token found. Open the complete local link provided by MacDry to run checks.";
  }
})();
