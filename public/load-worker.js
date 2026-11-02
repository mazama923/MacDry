const CPU_DURATION_MS = 8_000;
const CPU_BATCHES = 100_000;
const CPU_EXPECTED = 900422756;
const MEMORY_WORDS = 4 * 1024 * 1024;
const MEMORY_CHUNK_WORDS = 65_536;

let active = false;
let stopRequested = false;

function cpuBatch() {
  let state = 0x9e3779b9;
  for (let index = 0; index < CPU_BATCHES; index++) {
    state = Math.imul(state ^ index, 0x45d9f3b);
    state = ((state >>> 16) ^ state) >>> 0;
  }
  return state;
}

function delay() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function complete(type, status, message) {
  self.postMessage({ type, status, message });
}

async function runCpu() {
  const deadline = Date.now() + CPU_DURATION_MS;
  let batches = 0;
  while (Date.now() < deadline) {
    if (stopRequested) {
      complete("cpu", "interrupted", "The CPU workload was stopped.");
      return;
    }
    if (cpuBatch() !== CPU_EXPECTED) {
      complete(
        "cpu",
        "anomaly-detected",
        "The CPU workload returned an inconsistent result.",
      );
      return;
    }
    batches++;
    await delay();
  }
  complete(
    "cpu",
    batches > 0 ? "no-anomaly-detected" : "unavailable",
    "A bounded CPU workload completed.",
  );
}

function memoryPattern(index, pass) {
  const salt = pass === 0 ? 0xa5a5a5a5 : 0x5a5a5a5a;
  return (Math.imul(index, 0x9e3779b1) ^ salt) >>> 0;
}

async function runMemory() {
  let values;
  try {
    values = new Uint32Array(MEMORY_WORDS);
  } catch {
    complete(
      "memory",
      "unavailable",
      "The bounded memory buffer could not be allocated.",
    );
    return;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let start = 0; start < values.length; start += MEMORY_CHUNK_WORDS) {
      if (stopRequested) {
        complete("memory", "interrupted", "The memory workload was stopped.");
        return;
      }
      const end = Math.min(start + MEMORY_CHUNK_WORDS, values.length);
      for (let index = start; index < end; index++) {
        values[index] = memoryPattern(index, pass);
      }
      await delay();
    }
    for (let start = 0; start < values.length; start += MEMORY_CHUNK_WORDS) {
      if (stopRequested) {
        complete("memory", "interrupted", "The memory workload was stopped.");
        return;
      }
      const end = Math.min(start + MEMORY_CHUNK_WORDS, values.length);
      for (let index = start; index < end; index++) {
        if (values[index] !== memoryPattern(index, pass)) {
          complete(
            "memory",
            "anomaly-detected",
            "The memory workload found a pattern mismatch.",
          );
          return;
        }
      }
      await delay();
    }
  }
  complete(
    "memory",
    "no-anomaly-detected",
    "A 16 MiB memory buffer passed two write-and-verify patterns.",
  );
}

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "stop") {
    stopRequested = true;
    return;
  }
  if (active || (type !== "cpu" && type !== "memory")) return;
  active = true;
  stopRequested = false;
  const task = type === "cpu" ? runCpu : runMemory;
  task().catch(() =>
    complete(type, "unavailable", "The workload could not be completed.")
  ).finally(() => {
    active = false;
  });
});
