const MAX_OUTPUT = 2 * 1024 * 1024;
const SHORT_TIMEOUT = 4_000;
const PROFILER_TIMEOUT = 20_000;

async function run(path, args, timeout) {
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
  const stop = () => {
    try { child.kill("SIGKILL"); } catch { /* The process already exited. */ }
  };
  const reader = child.stdout.getReader();
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
      if (size > MAX_OUTPUT) {
        tooLarge = true;
        stop();
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
    }
    const status = await child.status;
    if (timedOut) return { error: "The system command timed out." };
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
    return { error: timedOut ? "The system command timed out." : "The system command could not be read." };
  } finally {
    clearTimeout(timer);
  }
}

function integer(value) {
  const raw = String(value ?? "").trim();
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

export async function collectFacts() {
  const [macos, model, cpu, cores, memory, disk, profile, nvme] = await Promise.all([
    run("/usr/bin/sw_vers", ["-productVersion"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.model"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.ncpu"], SHORT_TIMEOUT),
    run("/usr/sbin/sysctl", ["-n", "hw.memsize"], SHORT_TIMEOUT),
    run("/bin/df", ["-k", "/System/Volumes/Data"], SHORT_TIMEOUT),
    run("/usr/sbin/system_profiler", ["-json", "SPDisplaysDataType", "SPPowerDataType"], PROFILER_TIMEOUT),
    run("/usr/sbin/system_profiler", ["-json", "SPNVMeDataType"], PROFILER_TIMEOUT),
  ]);
  return normalise({ macos, model, cpu, cores, memory, disk, profile, nvme });
}
