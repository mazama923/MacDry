const MAX_OUTPUT = 2 * 1024 * 1024;
const LOG_MAX_OUTPUT = 512 * 1024;
const SHORT_TIMEOUT = 4_000;
const PROFILER_TIMEOUT = 20_000;
const NETWORK_TIMEOUT = 20_000;
const FILESYSTEM_TIMEOUT = 120_000;
const LOG_TIMEOUT = 15_000;
const VOLUME_VERIFY_APPLESCRIPT = 'do shell script "/usr/sbin/diskutil verifyVolume /" with administrator privileges';
const LOG_PREDICATE = 'messageType == fault OR (messageType == error AND (eventMessage CONTAINS[c] "panic" OR eventMessage CONTAINS[c] "I/O error" OR eventMessage CONTAINS[c] "APFS" OR eventMessage CONTAINS[c] "battery" OR eventMessage CONTAINS[c] "thermal" OR eventMessage CONTAINS[c] "sensor"))';

async function run(path, args, timeout, maxOutput = MAX_OUTPUT, signal = undefined) {
  let child;
  try {
    child = new Deno.Command(path, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
  } catch {
    return { error: "The system command could not be started." };
  }

  let timedOut = false;
  let tooLarge = false;
  let aborted = false;
  const stop = () => {
    try { child.kill("SIGKILL"); } catch { /* The process already exited. */ }
  };
  const reader = child.stdout.getReader();
  const abort = () => {
    aborted = true;
    stop();
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
    reader.cancel().catch(() => {});
  }, timeout);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > maxOutput) {
        tooLarge = true;
        stop();
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
    }
    const status = await child.status;
    if (timedOut) return { error: "The system command timed out." };
    if (aborted) return { error: "The system command was interrupted." };
    if (tooLarge) return { error: "The system command produced too much data." };
    if (!status.success) return { error: "The system command failed." };
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { value: new TextDecoder().decode(bytes).trim() };
  } catch {
    stop();
    await child.status.catch(() => {});
    return { error: timedOut ? "The system command timed out." : aborted ? "The system command was interrupted." : "The system command could not be read." };
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timer);
  }
}

function integer(value) {
  if (typeof value !== "string" && typeof value !== "number") return -1;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return -1;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : -1;
}

function label(value) {
  if (typeof value !== "string") return "";
  const s = value.trim();
  return s.length <= 100 && /^[A-Za-z0-9][A-Za-z0-9 ,.()+/_-]*$/.test(s) ? s : "";
}

const missing = "The system did not report a usable value.";

function normaliseThermal(result) {
  const facts = {};
  const lines = result.value?.split(/\r?\n/).filter((line) => /Thermal Warning Level|No thermal warning level/i.test(line)) ?? [];
  if (lines.length === 1) {
    const match = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4} )?Thermal Warning Level = (\d+)$/.exec(lines[0].trim());
    if (match) {
      const level = integer(match[1]);
      if (level >= 0) facts.thermal_warning_level = level;
    }
  }
  if (facts.thermal_warning_level === undefined) facts.thermal_warning_level_issue = result.error || missing;
  return facts;
}

export function normaliseLoadSignals(pressure, thermal) {
  const facts = {};
  const level = integer(pressure.value);
  if (level >= 0) facts.memory_pressure_level = level;
  else facts.memory_pressure_level_issue = pressure.error || missing;
  return { ...facts, ...normaliseThermal(thermal) };
}

export function normalise(results) {
  const facts = {};
  const simple = (key, result, parse) => {
    const value = result.value === undefined ? undefined : parse(result.value);
    if (value !== undefined && value !== "" && value !== -1) facts[key] = value;
    else facts[`${key}_issue`] = result.error || missing;
  };
  simple("macos", results.macos, (v) => /^\d+(?:\.\d+){1,2}$/.test(v) ? `macOS ${v}` : "");
  simple("model", results.model, label);
  simple("cpu", results.cpu, label);
  simple("cores", results.cores, integer);
  simple("memory_bytes", results.memory, integer);
  simple("memory_pressure_level", results.pressure ?? {}, integer);

  let profile;
  try {
    profile = results.profile.value === undefined ? null : JSON.parse(results.profile.value);
  } catch {
    profile = null;
  }
  const profileIssue = results.profile.error || missing;
  const displays = Array.isArray(profile?.SPDisplaysDataType) ? profile.SPDisplaysDataType : [];
  const names = displays.map((display) => label(display?.sppci_model)).filter(Boolean);
  if (names.length) facts.gpu = [...new Set(names)].slice(0, 4).join(", ");
  else facts.gpu_issue = profileIssue;

  const power = Array.isArray(profile?.SPPowerDataType) ? profile.SPPowerDataType : [];
  const battery = power.find((entry) => entry?.sppower_battery_health_info &&
    typeof entry.sppower_battery_health_info === "object")?.sppower_battery_health_info;
  if (battery) {
    const condition = typeof battery.sppower_battery_health === "string"
      ? battery.sppower_battery_health.trim().toLowerCase() : "";
    const supported = ["good", "normal", "service recommended", "service battery", "replace soon", "replace now"];
    if (supported.includes(condition)) facts.battery_condition = condition;
    const capacity = String(battery.sppower_battery_health_maximum_capacity ?? "").trim();
    const match = /^(\d{1,3})\s*%$/.exec(capacity);
    if (match && integer(match[1]) <= 100) facts.battery_capacity = integer(match[1]);
    const cycles = integer(battery.sppower_battery_cycle_count);
    if (cycles >= 0) facts.battery_cycles = cycles;
  }
  if (!facts.battery_condition) facts.battery_condition_issue = profileIssue;

  const chargeEntries = power.filter((entry) => Object.hasOwn(entry ?? {}, "sppower_battery_charge_info"));
  const chargerEntries = power.filter((entry) => Object.hasOwn(entry ?? {}, "sppower_battery_charger_connected"));
  const bool = (v) => v === true || v === "TRUE" ? 1 : v === false || v === "FALSE" ? 0 : -1;
  const charge = chargeEntries.length === 1 ? chargeEntries[0].sppower_battery_charge_info : null;
  if (charge && typeof charge === "object" && !Array.isArray(charge)) {
    const percent = integer(charge.sppower_battery_state_of_charge);
    if (percent >= 0 && percent <= 100) facts.battery_charge_percent = percent;
    const charging = bool(charge.sppower_battery_is_charging);
    if (charging >= 0) facts.battery_charging = charging;
  }
  if (chargerEntries.length === 1) {
    const charger = chargerEntries[0];
    const connected = bool(charger.sppower_battery_charger_connected);
    if (connected >= 0) facts.charger_connected = connected;
    if (Object.hasOwn(charger, "sppower_battery_is_charging") &&
      bool(charger.sppower_battery_is_charging) !== facts.battery_charging) {
      delete facts.battery_charging;
    }
  }
  facts.battery_power_issue = profileIssue;

  Object.assign(facts, normaliseThermal(results.thermal ?? {}));

  const nvmeResult = results.nvme ?? {};
  let nvme;
  try {
    nvme = nvmeResult.value === undefined ? null : JSON.parse(nvmeResult.value);
  } catch {
    nvme = null;
  }
  facts.smart_verified = 0;
  facts.smart_failing = 0;
  facts.smart_unknown = 0;
  const devices = Array.isArray(nvme?.SPNVMeDataType) ? [...nvme.SPNVMeDataType] : [];
  if (!devices.length) facts.smart_unknown++;
  while (devices.length) {
    const device = devices.pop();
    if (!device || typeof device !== "object" || Array.isArray(device)) {
      facts.smart_unknown++;
      continue;
    }
    const hasStatus = Object.hasOwn(device, "smart_status");
    if (hasStatus) {
      const status = typeof device.smart_status === "string" ? device.smart_status.trim().toLowerCase() : "";
      if (status === "verified") facts.smart_verified++;
      else if (status === "failing") facts.smart_failing++;
      else facts.smart_unknown++;
    }
    if (Object.hasOwn(device, "_items")) {
      if (!Array.isArray(device._items) || (!device._items.length && !hasStatus)) facts.smart_unknown++;
      else for (const item of device._items) devices.push(item);
    } else if (!hasStatus) {
      facts.smart_unknown++;
    }
  }
  if (facts.smart_unknown) facts.smart_issue = nvmeResult.error || missing;

  const lines = results.disk.value?.split(/\r?\n/) ?? [];
  const row = lines.slice(1).find((line) => /\s\/System\/Volumes\/Data\s*$/.test(line));
  const fields = row?.trim().split(/\s+/) ?? [];
  const used = /^\d{1,3}%$/.test(fields[4] ?? "") ? integer(fields[4].slice(0, -1)) : -1;
  const available = integer(fields[3]);
  if (used >= 0 && used <= 100 && available >= 0) {
    facts.disk_used_percent = used;
    facts.disk_available_kib = available;
  } else {
    facts.disk_issue = results.disk.error || missing;
  }
  return facts;
}

export async function collectLoadSignals() {
  const [pressure, thermal] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], SHORT_TIMEOUT),
    run("/usr/bin/pmset", ["-g", "therm"], SHORT_TIMEOUT),
  ]);
  return normaliseLoadSignals(pressure, thermal);
}

function numericMetric(value, maximum = 1_000_000_000_000) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
}

export function normaliseNetworkQuality(result) {
  const unavailable = (reason) => ({
    status: "unavailable",
    summary: "The Internet quality test did not return usable measurements.",
    details: reason || missing,
    source: "networkQuality -c -s -M 15",
    metrics: {},
  });
  if (result.value === undefined) return unavailable(result.error);
  try {
    const data = JSON.parse(result.value);
    if (!data || typeof data !== "object" || Array.isArray(data) || data.error_code || data.error_domain) {
      return unavailable(missing);
    }
    const metrics = {};
    const downlink = numericMetric(data.dl_throughput);
    const uplink = numericMetric(data.ul_throughput);
    const latency = numericMetric(data.base_rtt, 1_000_000);
    const downlinkResponsiveness = numericMetric(data.dl_responsiveness, 1_000_000);
    const uplinkResponsiveness = numericMetric(data.ul_responsiveness, 1_000_000);
    if (downlink !== null) metrics.download_mbps = Math.round(downlink / 100_000) / 10;
    if (uplink !== null) metrics.upload_mbps = Math.round(uplink / 100_000) / 10;
    if (latency !== null) metrics.base_rtt_ms = Math.round(latency * 10) / 10;
    if (downlinkResponsiveness !== null) metrics.download_responsiveness_rpm = Math.round(downlinkResponsiveness);
    if (uplinkResponsiveness !== null) metrics.upload_responsiveness_rpm = Math.round(uplinkResponsiveness);
    if (!Object.keys(metrics).length) return unavailable(missing);
    return {
      status: "measurement-recorded",
      summary: "The connection quality measurement completed; no hardware verdict is implied.",
      details: "A short Internet-path snapshot from Apple's networkQuality tool. Results vary with the service plan, Wi-Fi, VPN, other traffic and test server. This test transfers external data.",
      source: "networkQuality -c -s -M 15",
      metrics,
    };
  } catch {
    return unavailable(missing);
  }
}

export async function collectNetworkQuality(signal = undefined) {
  const result = await run(
    "/usr/bin/networkQuality",
    ["-c", "-s", "-M", "15"],
    NETWORK_TIMEOUT,
    MAX_OUTPUT,
    signal,
  );
  return normaliseNetworkQuality(result);
}

export function normaliseVolumeVerification(result) {
  const source = "diskutil verifyVolume / (macOS administrator authorization)";
  if (typeof result.value !== "string") {
    return {
      status: "unavailable",
      summary: "The startup volume verification did not complete.",
      details: `${result.error || missing} Authorization may have been cancelled, or macOS may not expose this check. No repair was requested.`,
      source,
    };
  }
  const output = result.value.toLowerCase();
  if (/appears to be (?:ok|valid)|file system check exit code is 0/.test(output)) {
    return {
      status: "no-anomaly-detected",
      summary: "Disk Utility completed the volume verification without reporting an error.",
      details: "This is a read-only filesystem verification snapshot, not an SSD health test or guarantee. MacDry does not repair the volume.",
      source,
    };
  }
  if (/corrupt|needs? repair|failed|error:|exit code [1-9]|not valid/.test(output)) {
    return {
      status: "anomaly-detected",
      summary: "Disk Utility reported an issue during volume verification.",
      details: "The output is intentionally not retained. Back up important data and review Disk Utility or consult a qualified technician; MacDry does not repair the volume.",
      source,
    };
  }
  return {
    status: "unavailable",
    summary: "The volume verification output was not recognised.",
    details: "MacDry could not interpret the result, so it cannot report a successful verification. No repair was requested.",
    source,
  };
}

export async function verifyStartupVolume(signal = undefined) {
  const result = await run(
    "/usr/bin/osascript",
    ["-e", VOLUME_VERIFY_APPLESCRIPT],
    FILESYSTEM_TIMEOUT,
    MAX_OUTPUT,
    signal,
  );
  return normaliseVolumeVerification(result);
}

export function normaliseRecentLogs(result) {
  const source = "macOS unified log · last 15 minutes · aggregate only";
  const unavailable = (reason) => ({
    status: "unavailable",
    summary: "Recent system-log events could not be summarised.",
    details: reason || missing,
    source,
    matches: 0,
  });
  if (result.value === undefined) return unavailable(result.error);
  let entries;
  try {
    entries = result.value.trim() ? JSON.parse(result.value) : [];
  } catch {
    return unavailable(missing);
  }
  if (!Array.isArray(entries)) return unavailable(missing);
  const matches = { panic: 0, storage: 0, battery: 0, thermal: 0, sensor: 0 };
  let inspected = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.eventMessage !== "string") continue;
    inspected++;
    const message = entry.eventMessage.toLowerCase();
    if (message.includes("panic")) matches.panic++;
    if (message.includes("i/o error") || message.includes("apfs")) matches.storage++;
    if (message.includes("battery")) matches.battery++;
    if (message.includes("thermal")) matches.thermal++;
    if (message.includes("sensor")) matches.sensor++;
  }
  if (entries.length > 0 && inspected === 0) return unavailable(missing);
  const total = entries.length;
  return {
    status: total ? "warning" : "no-anomaly-detected",
    summary: total
      ? `${total} filtered error or fault log entr${total === 1 ? "y" : "ies"} found.`
      : "No matching error or fault entries were found in the selected log window.",
    details: "The scan reports aggregate keyword counts only; log messages are not returned, saved or exported. Matches can be unrelated to hardware, and an empty window does not establish hardware health.",
    source,
    matches,
  };
}

export async function collectRecentLogs(signal = undefined) {
  const result = await run(
    "/usr/bin/log",
    ["show", "--last", "15m", "--style", "json", "--predicate", LOG_PREDICATE],
    LOG_TIMEOUT,
    LOG_MAX_OUTPUT,
    signal,
  );
  return normaliseRecentLogs(result);
}

export async function collectFacts() {
  const [macos, model, cpu, cores, memory, disk, profile, nvme, pressure, thermal] = await Promise.all([
    run("/usr/bin/sw_vers", ["-productVersion"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.model"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.ncpu"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.memsize"], SHORT_TIMEOUT),
    run("/bin/df", ["-k", "/System/Volumes/Data"], SHORT_TIMEOUT),
    run("/usr/sbin/system_profiler", ["-json", "SPDisplaysDataType", "SPPowerDataType"], PROFILER_TIMEOUT),
    run("/usr/sbin/system_profiler", ["-json", "SPNVMeDataType"], PROFILER_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], SHORT_TIMEOUT),
    run("/usr/bin/pmset", ["-g", "therm"], SHORT_TIMEOUT),
  ]);
  return normalise({ macos, model, cpu, cores, memory, disk, profile, nvme, pressure, thermal });
}
