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
    memory_pressure_level: 1,
    battery_charge_percent: 75,
    battery_charging: 1,
    charger_connected: 1,
    thermal_warning_level: 0,
  };
  const overrides = {
    pressure_2: { memory_pressure_level: 2 },
    pressure_4: { memory_pressure_level: 4 },
    pressure_unknown: { memory_pressure_level: 3 },
    thermal_5: { thermal_warning_level: 5 },
    thermal_10: { thermal_warning_level: 10 },
    thermal_100: { thermal_warning_level: 100 },
    thermal_unknown: { thermal_warning_level: 6 },
    power_empty: { battery_charge_percent: 0, battery_charging: 0, charger_connected: 0 },
    power_full: { battery_charge_percent: 100, battery_charging: 0, charger_connected: 1 },
    power_partial: { battery_charge_percent: -1 },
    power_invalid: { battery_charge_percent: 101 },
    power_conflict: { battery_charging: 1, charger_connected: 0 },
    power_unknown_charging: { battery_charging: -1 },
    power_unknown_connection: { charger_connected: -1 },
  };
  if (Object.hasOwn(overrides, scenario)) return { ...base, ...overrides[scenario] };
  if (scenario === "warning") return { ...base, disk_used_percent: 90, battery_condition: "service recommended", smart_failing: 1 };
  if (scenario === "unknown") return { ...base, disk_used_percent: 101, battery_condition: "unrecognised", smart_unknown: 1 };
  if (scenario === "smart_failed_with_unknown") return { ...base, smart_verified: 0, smart_failing: 1, smart_unknown: 1 };
  if (scenario === "smart_absent") return { ...base, smart_verified: 0, smart_failing: 0, smart_unknown: 0 };
  if (scenario === "cpu_partial") return { ...base, cpu: "", cpu_issue: "The system command timed out." };
  return base;
}
