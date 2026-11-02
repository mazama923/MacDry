import { createHandler } from "../server.mjs";
import { normalise } from "../src/system.mjs";

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
  equal(data.checks.length, 8);
  equal(data.checks.find((item) => item.id === "smart").status, "unavailable");
  assert(data.checks.every((item) => ["info", "warning", "unavailable", "fail"].includes(item.status)));
  assert(data.checks.every((item) => ["id", "title", "status", "summary", "details", "source"].every((key) => typeof item[key] === "string")));
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
