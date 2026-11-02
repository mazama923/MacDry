pub type Facts {
  Facts
}

pub type Check {
  Check(
    id: String,
    title: String,
    status: String,
    summary: String,
    details: String,
    source: String,
    recommendation: String,
  )
}

@external(javascript, "./bridge.mjs", "text")
fn text(facts: Facts, key: String) -> String

@external(javascript, "./bridge.mjs", "number")
fn number(facts: Facts, key: String) -> Int

@external(javascript, "./bridge.mjs", "numberText")
fn number_text(value: Int) -> String

fn issue(facts: Facts, key: String) -> String {
  case text(facts, key) {
    "" -> "The system did not report a usable value."
    reason -> reason
  }
}

fn inventory(
  id: String,
  title: String,
  value: String,
  reason: String,
  source: String,
) -> Check {
  case value {
    "" ->
      Check(
        id,
        title,
        "unavailable",
        "Information unavailable.",
        reason <> " This is not a health assessment.",
        source,
        "Retry the inventory or check System Information; this does not test hardware.",
      )
    _ ->
      Check(
        id,
        title,
        "info",
        value,
        "Inventory only; this does not assess hardware health.",
        source,
        "Use a dedicated diagnostic for hardware health; inventory is not a test.",
      )
  }
}

fn memory(facts: Facts) -> Check {
  let bytes = number(facts, "memory_bytes")
  case bytes > 0 {
    True ->
      Check(
        "memory",
        "Memory",
        "info",
        number_text(bytes / 1_073_741_824) <> " GiB unified memory",
        "Installed memory inventory only; no memory test was performed.",
        "sysctl hw.memsize",
        "Installed capacity is inventory only; use a dedicated memory diagnostic if needed.",
      )
    False ->
      Check(
        "memory",
        "Memory",
        "unavailable",
        "Memory information unavailable.",
        issue(facts, "memory_bytes_issue"),
        "sysctl hw.memsize",
        "Retry System Information; installed capacity is not a memory health test.",
      )
  }
}

fn cpu(facts: Facts) -> Check {
  let name = text(facts, "cpu")
  let cores = number(facts, "cores")
  case name, cores > 0 {
    "", False ->
      inventory(
        "cpu",
        "CPU",
        "",
        issue(facts, "cpu_issue"),
        "sysctl machdep.cpu.brand_string, hw.ncpu",
      )
    "", True ->
      Check(
        "cpu",
        "CPU",
        "info",
        number_text(cores) <> " logical CPUs",
        "CPU model unavailable. "
          <> issue(facts, "cpu_issue")
          <> " Inventory only; no processor health test was performed.",
        "sysctl machdep.cpu.brand_string, hw.ncpu",
        "Retry System Information if needed; CPU inventory is not a health test.",
      )
    _, False ->
      Check(
        "cpu",
        "CPU",
        "info",
        name,
        "Logical CPU count unavailable. "
          <> issue(facts, "cores_issue")
          <> " Inventory only; no processor health test was performed.",
        "sysctl machdep.cpu.brand_string, hw.ncpu",
        "Retry System Information if needed; CPU inventory is not a health test.",
      )
    _, True ->
      inventory(
        "cpu",
        "CPU",
        name <> " · " <> number_text(cores) <> " logical CPUs",
        "",
        "sysctl machdep.cpu.brand_string, hw.ncpu",
      )
  }
}

fn storage(facts: Facts) -> Check {
  let used = number(facts, "disk_used_percent")
  let available = number(facts, "disk_available_kib")
  let source = "df -k /System/Volumes/Data"
  case used >= 0 && used <= 100 && available >= 0 {
    False ->
      Check(
        "storage",
        "Storage space",
        "unavailable",
        "Storage space unavailable.",
        issue(facts, "disk_issue") <> " No disk health test was performed.",
        source,
        "Check available space in macOS; this does not test the disk.",
      )
    True -> {
      let summary =
        number_text(used)
        <> "% used · "
        <> number_text(available / 1_048_576)
        <> " GiB available"
      case used >= 90 {
        True ->
          Check(
            "storage",
            "Storage space",
            "warning",
            summary,
            "At least 90% of the Data volume is used. This is a space warning, not a disk health assessment.",
            source,
            "Review storage and free space safely; this does not diagnose disk health.",
          )
        False ->
          Check(
            "storage",
            "Storage space",
            "info",
            summary,
            "Data volume space only; no disk health or SMART test was performed.",
            source,
            "Monitor free space; this does not diagnose disk health.",
          )
      }
    }
  }
}

fn smart(facts: Facts) -> Check {
  let verified = number(facts, "smart_verified")
  let failing = number(facts, "smart_failing")
  let unknown = number(facts, "smart_unknown")
  let source = "system_profiler SPNVMeDataType"
  case failing > 0, verified > 0 && failing == 0 && unknown == 0 {
    True, _ ->
      Check(
        "smart",
        "NVMe SMART",
        "warning",
        "macOS reports SMART status Failing for at least one NVMe device.",
        "Other devices may report different or unavailable statuses. The affected device is not identified here.",
        source,
        "Back up important data and seek a professional disk assessment.",
      )
    False, True ->
      Check(
        "smart",
        "NVMe SMART",
        "info",
        "macOS reports SMART status Verified for all reported NVMe devices.",
        "This reported indicator is not proof of disk health and does not cover every failure mode. It does not identify the device backing the Data volume.",
        source,
        "Keep backups; SMART Verified does not rule out disk failure.",
      )
    _, _ ->
      Check(
        "smart",
        "NVMe SMART",
        "unavailable",
        "A complete NVMe SMART status is unavailable.",
        issue(facts, "smart_issue")
          <> " An unrecognised or missing status cannot establish disk health.",
        source,
        "Check disk status with an appropriate diagnostic; keep backups.",
      )
  }
}

fn battery_details(facts: Facts) -> String {
  let capacity = number(facts, "battery_capacity")
  let cycles = number(facts, "battery_cycles")
  case capacity >= 0 && capacity <= 100, cycles >= 0 {
    True, True ->
      "Maximum capacity: "
      <> number_text(capacity)
      <> "%. Cycle count: "
      <> number_text(cycles)
      <> ". Values are reported by macOS, not independently tested."
    True, False ->
      "Maximum capacity: "
      <> number_text(capacity)
      <> "%. Reported by macOS, not independently tested."
    False, True ->
      "Cycle count: "
      <> number_text(cycles)
      <> ". Reported by macOS, not independently tested."
    False, False -> "macOS did not report usable capacity or cycle information."
  }
}

fn battery(facts: Facts) -> Check {
  let condition = text(facts, "battery_condition")
  let details = battery_details(facts)
  let source = "system_profiler SPPowerDataType"
  case condition {
    "good" | "normal" ->
      Check(
        "battery",
        "Battery",
        "info",
        "macOS reports a normal battery condition.",
        details <> " Normal condition is not proof of battery health.",
        source,
        "Monitor battery behavior; the reported condition is not a battery test.",
      )
    "service recommended"
    | "service battery"
    | "replace soon"
    | "replace now" ->
      Check(
        "battery",
        "Battery",
        "warning",
        "macOS recommends battery service.",
        details,
        source,
        "Arrange battery service with a qualified technician.",
      )
    _ ->
      Check(
        "battery",
        "Battery",
        "unavailable",
        "Battery condition unavailable.",
        details
          <> " "
          <> issue(facts, "battery_condition_issue")
          <> " This can be expected on a Mac without an internal battery.",
        source,
        "Check Battery settings if this Mac has a battery; unavailable is not a pass.",
      )
  }
}

fn memory_pressure(facts: Facts) -> Check {
  let source = "sysctl kern.memorystatus_vm_pressure_level"
  let details =
    "macOS system-wide pressure category (unitless), sampled once; it is not a memory hardware test. This private interface may change."
  case number(facts, "memory_pressure_level") {
    1 ->
      Check(
        "memory_pressure",
        "Memory pressure",
        "info",
        "macOS reports normal memory pressure.",
        details,
        source,
        "A normal snapshot does not establish memory health.",
      )
    2 ->
      Check(
        "memory_pressure",
        "Memory pressure",
        "warning",
        "macOS reports elevated memory pressure.",
        details,
        source,
        "Close unnecessary apps and check Memory Pressure in Activity Monitor.",
      )
    4 ->
      Check(
        "memory_pressure",
        "Memory pressure",
        "warning",
        "macOS reports critical memory pressure.",
        details,
        source,
        "Save work, close unnecessary apps and check Activity Monitor.",
      )
    _ ->
      Check(
        "memory_pressure",
        "Memory pressure",
        "unavailable",
        "Memory pressure unavailable.",
        issue(facts, "memory_pressure_level_issue") <> " " <> details,
        source,
        "Check Memory Pressure in Activity Monitor; unavailable is not a pass.",
      )
  }
}

fn power(facts: Facts) -> Check {
  let charge = number(facts, "battery_charge_percent")
  let charging = number(facts, "battery_charging")
  let connected = number(facts, "charger_connected")
  let source = "system_profiler SPPowerDataType"
  let charge_text = case charge >= 0 && charge <= 100 {
    True -> "Charge: " <> number_text(charge) <> "%. "
    False -> "Charge percentage unavailable. "
  }
  let connection_text = case connected {
    1 -> "Charger connected. "
    0 -> "Charger not connected. "
    _ -> "Charger connection unavailable. "
  }
  let charging_text = case charging {
    1 -> "Charging. "
    0 -> "Not charging. "
    _ -> "Charging state unavailable. "
  }
  let limitation =
    "Snapshot only; charge is a percentage of current full charge, not maximum capacity or battery health. Not charging while connected can be normal."
  case charge >= 0 && charge <= 100, connected, charging {
    True, 0, 0 | True, 1, 0 | True, 1, 1 ->
      Check(
        "battery_power",
        "Battery and power",
        "info",
        charge_text <> connection_text <> charging_text,
        limitation,
        source,
        "Check Battery settings if behavior is unexpected; this is not a health test.",
      )
    _, _, _ ->
      Check(
        "battery_power",
        "Battery and power",
        "unavailable",
        "Battery or charger state incomplete or ambiguous.",
        charge_text
          <> case connected, charging {
          0, 1 -> "Connection and charging states conflict. "
          _, _ -> connection_text <> charging_text
        }
          <> issue(facts, "battery_power_issue")
          <> " "
          <> limitation,
        source,
        "Check Battery settings and retry; unavailable is not a failure.",
      )
  }
}

fn thermal(facts: Facts) -> Check {
  let source = "pmset -g therm"
  let details =
    "macOS thermal warning category (unitless), not a temperature; only levels documented for this API are interpreted. Availability varies by platform. A snapshot cannot assess cooling or hardware health."
  case number(facts, "thermal_warning_level") {
    0 ->
      Check(
        "thermal",
        "Thermal warning",
        "info",
        "macOS reports a normal thermal warning level.",
        details,
        source,
        "A normal level does not establish thermal or hardware health.",
      )
    100 ->
      Check(
        "thermal",
        "Thermal warning",
        "warning",
        "macOS reports a thermal warning.",
        details,
        source,
        "Reduce activity and let the Mac cool; seek service if warnings persist.",
      )
    10 ->
      Check(
        "thermal",
        "Thermal warning",
        "warning",
        "macOS reports a critical thermal warning.",
        details,
        source,
        "Save work, stop activity and let the Mac cool; seek service if it persists.",
      )
    5 ->
      Check(
        "thermal",
        "Thermal warning",
        "unavailable",
        "Thermal warning level unsupported.",
        "Level 5 is defined for thermal constraints, but is not listed among the return values documented for IOPMGetThermalWarningLevel. "
          <> details,
        source,
        "Check macOS thermal warnings; this level cannot be interpreted reliably here.",
      )
    _ ->
      Check(
        "thermal",
        "Thermal warning",
        "unavailable",
        "Thermal warning level unavailable or unsupported.",
        issue(facts, "thermal_warning_level_issue")
          <> " No recorded level is not a normal reading. "
          <> details,
        source,
        "Check macOS thermal warnings; unavailable is not a pass.",
      )
  }
}

pub fn checks(facts: Facts) -> List(Check) {
  [
    inventory(
      "macos",
      "macOS",
      text(facts, "macos"),
      issue(facts, "macos_issue"),
      "sw_vers -productVersion",
    ),
    inventory(
      "model",
      "Model",
      text(facts, "model"),
      issue(facts, "model_issue"),
      "sysctl hw.model",
    ),
    cpu(facts),
    memory(facts),
    inventory(
      "gpu",
      "GPU",
      text(facts, "gpu"),
      issue(facts, "gpu_issue"),
      "system_profiler SPDisplaysDataType",
    ),
    storage(facts),
    smart(facts),
    battery(facts),
    memory_pressure(facts),
    power(facts),
    thermal(facts),
  ]
}
