import macdry.{type Check, type Facts}

@external(javascript, "./fixtures.mjs", "facts")
fn facts(scenario: String) -> Facts

fn expect(check: Check, id: String, status: String) {
  case check.id == id && check.status == status {
    True -> Nil
    False -> panic as "Unexpected check or status"
  }
}

fn expect_summary(check: Check, expected: String) {
  case check.summary == expected {
    True -> Nil
    False -> panic as "Unexpected summary"
  }
}

pub fn main() {
  let assert [macos, model, cpu, memory, gpu, storage, smart, battery] =
    macdry.checks(facts("normal"))
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

  let assert [_, _, _, _, _, storage, smart, battery] =
    macdry.checks(facts("warning"))
  expect(storage, "storage", "warning")
  expect(smart, "smart", "warning")
  expect_summary(
    smart,
    "macOS reports SMART status Failing for at least one NVMe device.",
  )
  expect(battery, "battery", "warning")

  let assert [_, _, _, _, _, storage, smart, battery] =
    macdry.checks(facts("unknown"))
  expect(storage, "storage", "unavailable")
  expect(smart, "smart", "unavailable")
  expect(battery, "battery", "unavailable")

  let assert [_, _, _, _, _, _, smart, _] =
    macdry.checks(facts("smart_failed_with_unknown"))
  expect(smart, "smart", "warning")
  let assert [_, _, _, _, _, _, smart, _] = macdry.checks(facts("smart_absent"))
  expect(smart, "smart", "unavailable")

  let assert [_, _, cpu, _, _, _, _, _] = macdry.checks(facts("cpu_partial"))
  expect(cpu, "cpu", "info")
  expect_summary(cpu, "10 logical CPUs")
  case
    cpu.details
    == "CPU model unavailable. The system command timed out. Inventory only; no processor health test was performed."
  {
    True -> Nil
    False -> panic as "Missing partial CPU error"
  }

  let assert [macos, model, cpu, memory, gpu, storage, smart, battery] =
    macdry.checks(facts("empty"))
  expect(macos, "macos", "unavailable")
  expect(model, "model", "unavailable")
  expect(cpu, "cpu", "unavailable")
  expect(memory, "memory", "unavailable")
  expect(gpu, "gpu", "unavailable")
  expect(storage, "storage", "unavailable")
  expect(smart, "smart", "unavailable")
  expect(battery, "battery", "unavailable")
}
