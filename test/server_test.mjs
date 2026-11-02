import { createHandler } from "../server.mjs";
import { collectFacts, collectLoadSignals, normalise, normaliseLoadSignals } from "../src/system.mjs";

function equal(actual, expected) {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assert(value, message = "Assertion failed") {
  if (!value) throw new Error(message);
}

const token = "a".repeat(64);
const host = "127.0.0.1:12345";
const handler = createHandler({ port: 12345, token, readAsset: (name) => new TextEncoder().encode(name), scan: () => ({}) });
function request(path, headers = {}, method = "GET") {
  return handler(new Request(`http://${host}${path}`, { method, headers: { host, ...headers } }));
}

Deno.test("HTTP routes, token, host, origin, methods and headers", async () => {
  equal((await request("/", {})).status, 200);
  equal(await (await request("/app.js")).text(), "app.js");
  equal((await request("/style.css")).status, 200);
  equal(await (await request("/load-worker.js")).text(), "load-worker.js");
  equal((await request("/secret")).status, 404);
  equal((await request("/server.mjs")).status, 404);
  equal((await request("/api/checks")).status, 401);
  equal((await request("/api/checks", { "x-macdry-token": "b".repeat(64) })).status, 401);
  equal((await request("/api/checks", { "x-macdry-token": token }, "POST")).status, 405);
  equal((await request("/", { host: "localhost:12345" })).status, 403);
  equal((await request("/", { origin: "http://attacker.example" })).status, 403);
  equal((await request("/", { origin: "null" })).status, 403);
  equal((await request("/", { "sec-fetch-site": "cross-site" })).status, 403);
  const response = await request("/api/checks", { "x-macdry-token": token, origin: `http://${host}` });
  equal(response.status, 200);
  equal(response.headers.get("cache-control"), "no-store");
  assert(response.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  const data = await response.json();
  equal(data.checks.length, 11);
  equal(data.checks.find((item) => item.id === "smart").status, "unavailable");
  assert(data.checks.every((item) => ["info", "warning", "unavailable", "fail"].includes(item.status)));
  assert(data.checks.every((item) => ["id", "title", "status", "summary", "details", "source", "recommendation"].every((key) => typeof item[key] === "string" && item[key].length > 0)));
});

Deno.test("normalisation filters identifiers and handles alternate or missing fields", () => {
  const profile = JSON.stringify({
    SPDisplaysDataType: [{ sppci_model: "Apple M1 Pro", serial_number: "SECRET-GPU" }],
    SPPowerDataType: [{ sppower_battery_health_info: { sppower_battery_health: "Service Recommended", sppower_battery_cycle_count: 600, sppower_battery_health_maximum_capacity: "79 %" }, sppower_battery_model_info: { sppower_battery_serial_number: "SECRET-BATTERY" } }],
    SPHardwareDataType: [{ serial_number: "SECRET-MAC" }],
  });
  const facts = normalise({
    macos: { value: "15.2" }, model: { value: "MacBookPro18,1" }, cpu: { value: "Apple M1 Pro" },
    cores: { value: "10" }, memory: { value: "17179869184" },
    disk: { value: "Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/secret 1000 900 100 90% 1 1 0% /System/Volumes/Data" },
    profile: { value: profile },
    nvme: { value: JSON.stringify({ SPNVMeDataType: [{ _items: [{ smart_status: "Verified", device_serial: "SECRET-NVME" }] }] }) },
  });
  equal(facts.battery_condition, "service recommended");
  equal(facts.battery_capacity, 79);
  equal(facts.disk_used_percent, 90);
  equal(facts.smart_verified, 1);
  equal(facts.smart_failing, 0);
  equal(facts.smart_unknown, 0);
  assert(!JSON.stringify(facts).includes("SECRET"));
  assert(!JSON.stringify(facts).includes("/dev/secret"));
  const broken = normalise({ macos: { error: "The system command timed out." }, model: {}, cpu: {}, cores: {}, memory: {}, disk: { value: "bad" }, profile: { value: "not json" } });
  equal(broken.macos_issue, "The system command timed out.");
  assert(!("disk_used_percent" in broken));
  assert(!("battery_condition" in broken));
  assert(!("gpu" in broken));
  const safeSignals = normaliseLoadSignals({ value: "1" }, { value: "Thermal Warning Level = 0" });
  equal(safeSignals.memory_pressure_level, 1);
  equal(safeSignals.thermal_warning_level, 0);
  const unavailableSignals = normaliseLoadSignals({ error: "The system command timed out." }, {});
  equal(unavailableSignals.memory_pressure_level_issue, "The system command timed out.");
  assert(!("thermal_warning_level" in unavailableSignals));
});

Deno.test("load-test preflight is authenticated and preserves unavailable thermal signals", async () => {
  const safeFacts = normaliseLoadSignals({ value: "1" }, { value: "Thermal Warning Level = 0" });
  const readyHandler = createHandler({ port: 12345, token, readAsset: () => "", scan: () => ({}), loadSignals: () => safeFacts });
  const path = `http://${host}/api/load-test/preflight`;
  equal((await readyHandler(new Request(path, { headers: { host } }))).status, 401);
  const readyResponse = await readyHandler(new Request(path, { headers: { host, "x-macdry-token": token } }));
  equal(readyResponse.status, 200);
  const ready = await readyResponse.json();
  equal(ready.eligible, true);
  equal(JSON.stringify(ready.checks.map(({ id, status }) => ({ id, status }))), JSON.stringify([
    { id: "memory_pressure", status: "info" }, { id: "thermal", status: "info" },
  ]));

  const noThermalRecord = normaliseLoadSignals(
    { value: "1" },
    { value: "Note: No thermal warning level has been recorded" },
  );
  const manualThermalHandler = createHandler({
    port: 12345,
    token,
    readAsset: () => "",
    scan: () => ({}),
    loadSignals: () => noThermalRecord,
  });
  const manualThermalResponse = await manualThermalHandler(new Request(path, { headers: { host, "x-macdry-token": token } }));
  const manualThermal = await manualThermalResponse.json();
  equal(manualThermal.eligible, true);
  equal(manualThermal.checks.find((check) => check.id === "memory_pressure").status, "info");
  equal(manualThermal.checks.find((check) => check.id === "thermal").status, "unavailable");

  const blockedHandler = createHandler({
    port: 12345,
    token,
    readAsset: () => "",
    scan: () => ({}),
    loadSignals: () => normaliseLoadSignals({ value: "2" }, { value: "Thermal Warning Level = 10" }),
  });
  const blockedResponse = await blockedHandler(new Request(path, { headers: { host, "x-macdry-token": token } }));
  equal((await blockedResponse.json()).eligible, false);
});

Deno.test("load-test signal collection uses only fixed bounded read-only commands", async () => {
  const original = Deno.Command;
  const calls = [];
  Deno.Command = class {
    constructor(path, options) { this.path = path; this.options = options; }
    spawn() {
      calls.push([this.path, this.options.args]);
      const output = this.path === "/usr/sbin/sysctl" ? "1" : "Thermal Warning Level = 0";
      return {
        stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(output)); controller.close(); } }),
        status: Promise.resolve({ success: true }),
        kill() {},
      };
    }
  };
  try {
    const signals = await collectLoadSignals();
    equal(signals.memory_pressure_level, 1);
    equal(signals.thermal_warning_level, 0);
    equal(JSON.stringify(calls), JSON.stringify([
      ["/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]],
      ["/usr/bin/pmset", ["-g", "therm"]],
    ]));
  } finally {
    Deno.Command = original;
  }
});

Deno.test("collection uses fixed commands and enforces output and timeout limits", async () => {
  const original = Deno.Command;
  const calls = [];
  Deno.Command = class {
    constructor(path, options) { this.path = path; this.options = options; }
    spawn() {
      calls.push([this.path, this.options.args]);
      equal(this.options.stdin, "null");
      equal(this.options.stdout, "piped");
      equal(this.options.stderr, "null");
      const pressure = this.options.args.includes("kern.memorystatus_vm_pressure_level");
      const thermal = this.path === "/usr/bin/pmset";
      let finish;
      const status = new Promise((resolve) => { finish = resolve; });
      const stdout = new ReadableStream({
        start(controller) {
          if (thermal) return;
          controller.enqueue(pressure ? new Uint8Array(2 * 1024 * 1024 + 1) : new TextEncoder().encode("1"));
          controller.close();
          finish({ success: true });
        },
      });
      return { stdout, status, kill(signal) { equal(signal, "SIGKILL"); finish({ success: false }); } };
    }
  };
  try {
    const facts = await collectFacts();
    equal(facts.memory_pressure_level_issue, "The system command produced too much data.");
    equal(facts.thermal_warning_level_issue, "The system command timed out.");
    equal(JSON.stringify(calls), JSON.stringify([
      ["/usr/bin/sw_vers", ["-productVersion"]],
      ["/usr/sbin/sysctl", ["-n", "hw.model"]],
      ["/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]],
      ["/usr/sbin/sysctl", ["-n", "hw.ncpu"]],
      ["/usr/sbin/sysctl", ["-n", "hw.memsize"]],
      ["/bin/df", ["-k", "/System/Volumes/Data"]],
      ["/usr/sbin/system_profiler", ["-json", "SPDisplaysDataType", "SPPowerDataType"]],
      ["/usr/sbin/system_profiler", ["-json", "SPNVMeDataType"]],
      ["/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]],
      ["/usr/bin/pmset", ["-g", "therm"]],
    ]));
  } finally {
    Deno.Command = original;
  }
});

function systemFacts({ power = [], pressure = { value: "1" }, thermal = { value: "Thermal Warning Level = 0" }, profile } = {}) {
  return normalise({
    macos: {}, model: {}, cpu: {}, cores: {}, memory: {}, disk: {}, nvme: {}, pressure, thermal,
    profile: profile ?? { value: JSON.stringify({ SPPowerDataType: power }) },
  });
}

const chargeInfo = (percent = 75, charging = "TRUE") => ({
  sppower_battery_charge_info: { sppower_battery_state_of_charge: percent, sppower_battery_is_charging: charging },
  sppower_battery_model_info: { sppower_battery_serial_number: "SECRET-BATTERY" },
});
const chargerInfo = (connected = "TRUE", charging = "TRUE") => ({
  sppower_battery_charger_connected: connected, sppower_battery_is_charging: charging, serial_number: "SECRET-CHARGER",
});

async function apiChecks(facts) {
  const h = createHandler({ port: 12345, token, readAsset: () => "", scan: () => facts });
  const response = await h(new Request(`http://${host}/api/checks`, { headers: { host, "x-macdry-token": token } }));
  equal(response.status, 200);
  const body = await response.text();
  assert(!body.includes("SECRET"));
  return JSON.parse(body).checks;
}

Deno.test("power normalisation rejects ambiguous or invalid fields and preserves partial results", async () => {
  for (const [power, status] of [
    [[chargeInfo(), chargerInfo()], "info"],
    [[chargeInfo(0, "FALSE"), chargerInfo("FALSE", "FALSE")], "info"],
    [[chargeInfo(100, "FALSE"), chargerInfo("TRUE", "FALSE")], "info"],
    [[chargeInfo(101), chargerInfo()], "unavailable"],
    [[chargeInfo([75]), chargerInfo()], "unavailable"],
    [[chargeInfo("75%"), chargerInfo()], "unavailable"],
    [[chargeInfo(75, "false"), chargerInfo()], "unavailable"],
    [[chargeInfo(), chargerInfo("FALSE", "TRUE")], "unavailable"],
    [[chargeInfo(), chargerInfo("TRUE", "FALSE")], "unavailable"],
    [[chargeInfo(), chargerInfo("TRUE", "unexpected")], "unavailable"],
    [[chargeInfo(), { sppower_battery_charger_connected: "unknown" }], "unavailable"],
    [[chargeInfo()], "unavailable"],
    [[chargerInfo()], "unavailable"],
    [[chargeInfo(), chargeInfo(), chargerInfo()], "unavailable"],
    [[chargeInfo(), { sppower_battery_charge_info: null }, chargerInfo()], "unavailable"],
    [[chargeInfo(), chargerInfo(), chargerInfo()], "unavailable"],
    [[chargeInfo(), { sppower_battery_charger_connected: "TRUE" }], "info"],
    [[], "unavailable"],
  ]) {
    const facts = systemFacts({ power });
    assert(!JSON.stringify(facts).includes("SECRET"));
    const check = (await apiChecks(facts)).find((item) => item.id === "battery_power");
    equal(check.status, status);
    assert(check.details.includes("percentage"));
    assert(check.details.includes("not maximum capacity or battery health"));
  }
  const partial = systemFacts({ power: [chargeInfo(20, "FALSE")] });
  equal(partial.battery_charge_percent, 20);
  equal(partial.battery_charging, 0);
  assert(!Object.hasOwn(partial, "charger_connected"));
  for (const profile of [{ value: "not json" }, { error: "The system command timed out." }]) {
    const check = (await apiChecks(systemFacts({ profile }))).find((item) => item.id === "battery_power");
    equal(check.status, "unavailable");
    if (profile.error) assert(check.details.includes("timed out"));
  }
});

Deno.test("memory pressure categories remain distinct from free-memory percentages", async () => {
  for (const [pressure, status] of [
    [{ value: "1" }, "info"], [{ value: "2" }, "warning"], [{ value: "4" }, "warning"],
    [{ value: "0" }, "unavailable"], [{ value: "3" }, "unavailable"], [{ value: "99" }, "unavailable"],
    [{ value: "1%" }, "unavailable"], [{ value: "SECRET" }, "unavailable"],
    [{ error: "The system command timed out." }, "unavailable"], [{}, "unavailable"],
  ]) {
    const check = (await apiChecks(systemFacts({ pressure }))).find((item) => item.id === "memory_pressure");
    equal(check.status, status);
    assert(check.details.includes("unitless"));
    assert(check.details.includes("not a memory hardware test"));
    if (pressure.error) assert(check.details.includes("timed out"));
  }
});

Deno.test("thermal output requires one recognised level and never interprets missing notifications as normal", async () => {
  for (const [thermal, status] of [
    [{ value: "Thermal Warning Level = 0" }, "info"],
    [{ value: "2026-01-02 12:34:56 +0000 Thermal Warning Level = 5" }, "unavailable"],
    [{ value: "2026-01-02 12:34:56 -0800 Thermal Warning Level = 100\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded" }, "warning"],
    [{ value: "Thermal Warning Level = 10" }, "warning"],
    [{ value: "Thermal Warning Level = 100" }, "warning"],
    [{ value: "Thermal Warning Level = 1" }, "unavailable"],
    [{ value: "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded" }, "unavailable"],
    [{ value: "Thermal Warning Level = 0\nThermal Warning Level = 5" }, "unavailable"],
    [{ value: "No thermal warning level has been recorded\nThermal Warning Level = 0" }, "unavailable"],
    [{ value: "Thermal Warning Level = 5 SECRET" }, "unavailable"],
    [{ value: "Thermal Warning Level = SECRET" }, "unavailable"],
    [{ value: "" }, "unavailable"], [{ error: "The system command timed out." }, "unavailable"],
  ]) {
    const check = (await apiChecks(systemFacts({ thermal }))).find((item) => item.id === "thermal");
    equal(check.status, status);
    assert(check.details.includes("unitless"));
    assert(check.details.includes("not a temperature"));
    if (thermal.value === "2026-01-02 12:34:56 +0000 Thermal Warning Level = 5") {
      assert(check.details.includes("not listed among the return values documented"));
    }
    if (thermal.error) assert(check.details.includes("timed out"));
  }
});

function nvmeFacts(nvme) {
  return normalise({ macos: {}, model: {}, cpu: {}, cores: {}, memory: {}, disk: {}, profile: {}, nvme });
}

Deno.test("SMART normalisation handles unknown, missing and contradictory devices without identifiers", () => {
  const profile = (devices) => ({ value: JSON.stringify({ SPNVMeDataType: [{ _items: devices }] }) });
  const verified = { smart_status: "Verified", device_serial: "SECRET-NVME" };
  const failing = { smart_status: "Failing", device_serial: "SECRET-FAILING" };
  const unknown = { smart_status: "Unrecognised", device_serial: "SECRET-UNKNOWN" };
  for (const [devices, counts] of [
    [[verified], [1, 0, 0]],
    [[verified, verified], [2, 0, 0]],
    [[verified, failing], [1, 1, 0]],
    [[failing], [0, 1, 0]],
    [[unknown], [0, 0, 1]],
    [[failing, unknown], [0, 1, 1]],
    [[verified, unknown], [1, 0, 1]],
    [[verified, {}], [1, 0, 1]],
    [[{ smart_status: null }], [0, 0, 1]],
  ]) {
    const facts = nvmeFacts(profile(devices));
    equal(JSON.stringify([facts.smart_verified, facts.smart_failing, facts.smart_unknown]), JSON.stringify(counts));
    assert(!JSON.stringify(facts).includes("SECRET"));
  }
  const empty = nvmeFacts(profile([]));
  assert(empty.smart_unknown > 0);
  const nested = nvmeFacts({ value: JSON.stringify({ SPNVMeDataType: [{ _items: [{ _items: [verified] }] }] }) });
  equal(nested.smart_verified, 1);
  equal(nested.smart_unknown, 0);
  const invalid = nvmeFacts({ value: "not json" });
  equal(invalid.smart_verified, 0);
  equal(invalid.smart_failing, 0);
  assert(invalid.smart_unknown > 0);
  const timeout = nvmeFacts({ error: "The system command timed out." });
  equal(timeout.smart_issue, "The system command timed out.");
  assert(timeout.smart_unknown > 0);
});

Deno.test("SMART API reports mixed and unknown states without NVMe identifiers", async () => {
  for (const [states, expected] of [
    [["Verified"], "info"],
    [["Verified", "Failing"], "warning"],
    [["Failing", "Unexpected"], "warning"],
    [["Verified", "Unexpected"], "unavailable"],
    [["Unexpected"], "unavailable"],
    [[], "unavailable"],
  ]) {
    const nvme = { value: JSON.stringify({ SPNVMeDataType: [{ _items: states.map((state) => ({
      smart_status: state, device_serial: "SECRET-SERIAL", bsd_name: "SECRET-DISK", _name: "SECRET-NAME",
    })) }] }) };
    const h = createHandler({ port: 12345, token, readAsset: () => "", scan: () => nvmeFacts(nvme) });
    const response = await h(new Request(`http://${host}/api/checks`, { headers: { host, "x-macdry-token": token } }));
    const body = await response.text();
    assert(!body.includes("SECRET"));
    const smart = JSON.parse(body).checks.find((item) => item.id === "smart");
    equal(smart.status, expected);
    equal(smart.source, "system_profiler SPNVMeDataType");
  }
  const h = createHandler({ port: 12345, token, readAsset: () => "", scan: () => nvmeFacts({ error: "The system command timed out." }) });
  const response = await h(new Request(`http://${host}/api/checks`, { headers: { host, "x-macdry-token": token } }));
  const smart = (await response.json()).checks.find((item) => item.id === "smart");
  equal(smart.status, "unavailable");
  assert(smart.details.includes("timed out"));
});

Deno.test("concurrent scans share one diagnostic", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHandler({ port: 12345, token, readAsset: () => "", scan: async () => { calls++; await gate; return {}; } });
  const make = () => h(new Request(`http://${host}/api/checks`, { headers: { host, "x-macdry-token": token } }));
  const one = make();
  const two = make();
  await Promise.resolve();
  equal(calls, 1);
  release();
  equal((await one).status, 200);
  equal((await two).status, 200);
  equal((await make()).status, 200);
  equal(calls, 2);
});
