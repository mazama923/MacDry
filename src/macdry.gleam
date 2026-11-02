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
      )
    _ ->
      Check(
        id,
        title,
        "info",
        value,
        "Inventory only; this does not assess hardware health.",
        source,
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
      )
    False ->
      Check(
        "memory",
        "Memory",
        "unavailable",
        "Memory information unavailable.",
        issue(facts, "memory_bytes_issue"),
        "sysctl hw.memsize",
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
          )
        False ->
          Check(
            "storage",
            "Storage space",
            "info",
            summary,
            "Data volume space only; no disk health or SMART test was performed.",
            source,
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
      )
    False, True ->
      Check(
        "smart",
        "NVMe SMART",
        "info",
        "macOS reports SMART status Verified for all reported NVMe devices.",
        "This reported indicator is not proof of disk health and does not cover every failure mode. It does not identify the device backing the Data volume.",
        source,
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
        details,
        source,
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
  ]
}
