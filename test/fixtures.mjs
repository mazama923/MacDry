export function facts(scenario) {
  if (scenario === "empty") return {};
  const base = {
    macos: "macOS 15.1",
    model: "MacBookPro18,1",
    cpu: "Apple M1 Pro",
    cores: 10,
    memory_bytes: 17179869184,
    gpu: "Apple M1 Pro",
    disk_used_percent: 89,
    disk_available_kib: 10485760,
    smart_verified: 1,
    smart_failing: 0,
    smart_unknown: 0,
    battery_condition: "normal",
    battery_capacity: 80,
    battery_cycles: 549,
  };
  if (scenario === "warning") return { ...base, disk_used_percent: 90, battery_condition: "service recommended", smart_failing: 1 };
  if (scenario === "unknown") return { ...base, disk_used_percent: 101, battery_condition: "unrecognised", smart_unknown: 1 };
  if (scenario === "smart_failed_with_unknown") return { ...base, smart_verified: 0, smart_failing: 1, smart_unknown: 1 };
  if (scenario === "smart_absent") return { ...base, smart_verified: 0, smart_failing: 0, smart_unknown: 0 };
  if (scenario === "cpu_partial") return { ...base, cpu: "", cpu_issue: "The system command timed out." };
  return base;
}
