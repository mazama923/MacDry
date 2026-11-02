import macdry.{type Check, type Facts}

@external(javascript, "./fixtures.mjs", "facts")
fn facts(scenario: String) -> Facts

fn expect(check: Check, id: String, status: String) {
  case check.id == id && check.status == status && check.recommendation != "" {
    True -> Nil
    False -> panic as "Unexpected check, status or recommendation"
  }
}

fn expect_summary(check: Check, expected: String) {
  case check.summary == expected {
    True -> Nil
    False -> panic as "Unexpected summary"
  }
}

fn expect_load_eligibility(facts: Facts, expected: Bool) {
  case macdry.load_test_eligible(facts) == expected {
    True -> Nil
    False -> panic as "Unexpected load-test eligibility"
  }
}

fn expect_recommendations(checks: List(Check)) {
  case checks {
    [] -> Nil
    [check, ..rest] -> {
      case check.recommendation != "" {
        True -> Nil
        False -> panic as "Missing recommendation"
      }
      expect_recommendations(rest)
    }
  }
}

fn expect_new_checks(scenarios: List(#(String, String, String, String))) {
  case scenarios {
    [] -> Nil
    [#(scenario, pressure_status, power_status, thermal_status), ..rest] -> {
      let checks = macdry.checks(facts(scenario))
      let assert [_, _, _, _, _, _, _, _, pressure, power, thermal] = checks
      expect(pressure, "memory_pressure", pressure_status)
      expect(power, "battery_power", power_status)
      expect(thermal, "thermal", thermal_status)
      expect_recommendations(checks)
      expect_new_checks(rest)
    }
  }
}

pub fn main() {
  let normal_checks = macdry.checks(facts("normal"))
  let assert [
    macos,
    model,
    cpu,
    memory,
    gpu,
    storage,
    smart,
    battery,
    pressure,
    power,
    thermal,
  ] = normal_checks
  expect_recommendations(normal_checks)
  expect(macos, "macos", "info")
  expect(model, "model", "info")
  expect(cpu, "cpu", "info")
  expect(memory, "memory", "info")
  expect_summary(memory, "16 GiB unified memory")
  expect(gpu, "gpu", "info")
  expect(storage, "storage", "info")
  expect_summary(storage, "89% used · 10 GiB available")
  expect(smart, "smart", "info")
  expect_summary(
    smart,
    "macOS reports SMART status Verified for all reported NVMe devices.",
  )
  expect(battery, "battery", "info")
  expect(pressure, "memory_pressure", "info")
  expect(power, "battery_power", "info")
  expect_summary(power, "Charge: 75%. Charger connected. Charging. ")
  expect(thermal, "thermal", "info")
  expect_load_eligibility(facts("normal"), True)
  expect_load_eligibility(facts("thermal_unknown"), True)
  expect_load_eligibility(facts("thermal_10"), False)
  expect_load_eligibility(facts("pressure_2"), False)
  expect_load_eligibility(facts("pressure_unknown"), False)

  let warning_checks = macdry.checks(facts("warning"))
  let assert [_, _, _, _, _, storage, smart, battery, _, _, _] = warning_checks
  expect_recommendations(warning_checks)
  expect(storage, "storage", "warning")
  expect(smart, "smart", "warning")
  expect_summary(
    smart,
    "macOS reports SMART status Failing for at least one NVMe device.",
  )
  expect(battery, "battery", "warning")

  let unknown_checks = macdry.checks(facts("unknown"))
  let assert [_, _, _, _, _, storage, smart, battery, _, _, _] = unknown_checks
  expect_recommendations(unknown_checks)
  expect(storage, "storage", "unavailable")
  expect(smart, "smart", "unavailable")
  expect(battery, "battery", "unavailable")

  let assert [_, _, _, _, _, _, smart, _, _, _, _] =
    macdry.checks(facts("smart_failed_with_unknown"))
  expect(smart, "smart", "warning")
  let assert [_, _, _, _, _, _, smart, _, _, _, _] =
    macdry.checks(facts("smart_absent"))
  expect(smart, "smart", "unavailable")

  let assert [_, _, cpu, _, _, _, _, _, _, _, _] =
    macdry.checks(facts("cpu_partial"))
  expect(cpu, "cpu", "info")
  expect_summary(cpu, "10 logical CPUs")
  case
    cpu.details
    == "CPU model unavailable. The system command timed out. Inventory only; no processor health test was performed."
  {
    True -> Nil
    False -> panic as "Missing partial CPU error"
  }

  let empty_checks = macdry.checks(facts("empty"))
  let assert [
    macos,
    model,
    cpu,
    memory,
    gpu,
    storage,
    smart,
    battery,
    pressure,
    power,
    thermal,
  ] = empty_checks
  expect_recommendations(empty_checks)
  expect(macos, "macos", "unavailable")
  expect(model, "model", "unavailable")
  expect(cpu, "cpu", "unavailable")
  expect(memory, "memory", "unavailable")
  expect(gpu, "gpu", "unavailable")
  expect(storage, "storage", "unavailable")
  expect(smart, "smart", "unavailable")
  expect(battery, "battery", "unavailable")
  expect(pressure, "memory_pressure", "unavailable")
  expect(power, "battery_power", "unavailable")
  expect(thermal, "thermal", "unavailable")

  expect_new_checks([
    #("pressure_2", "warning", "info", "info"),
    #("pressure_4", "warning", "info", "info"),
    #("pressure_unknown", "unavailable", "info", "info"),
    #("thermal_5", "info", "info", "unavailable"),
    #("thermal_10", "info", "info", "warning"),
    #("thermal_100", "info", "info", "warning"),
    #("thermal_unknown", "info", "info", "unavailable"),
    #("power_empty", "info", "info", "info"),
    #("power_full", "info", "info", "info"),
    #("power_partial", "info", "unavailable", "info"),
    #("power_invalid", "info", "unavailable", "info"),
    #("power_conflict", "info", "unavailable", "info"),
    #("power_unknown_charging", "info", "unavailable", "info"),
    #("power_unknown_connection", "info", "unavailable", "info"),
  ])
}
