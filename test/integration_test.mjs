function assert(value, message) {
  if (!value) throw new Error(message);
}

const runPermissions = "--allow-run=/usr/bin/sw_vers,/usr/sbin/sysctl,/bin/df,/usr/sbin/system_profiler,/usr/bin/pmset,/usr/bin/open";
const sandbox = await Deno.makeTempDir({ dir: "test", prefix: "integration-" });
try {
  await Deno.mkdir(`${sandbox}/public`, { recursive: true });
  await Deno.mkdir(`${sandbox}/src`, { recursive: true });
  await Deno.mkdir(`${sandbox}/build/dev/javascript/macdry`, { recursive: true });
  await Deno.copyFile("server.mjs", `${sandbox}/server.mjs`);
  await Deno.copyFile("src/system.mjs", `${sandbox}/src/system.mjs`);
  for (const name of ["macdry.mjs", "gleam.mjs", "bridge.mjs"]) {
    await Deno.copyFile(`build/dev/javascript/macdry/${name}`, `${sandbox}/build/dev/javascript/macdry/${name}`);
  }
  await Deno.copyFile("build/dev/javascript/prelude.mjs", `${sandbox}/build/dev/javascript/prelude.mjs`);
  const expectedAssets = {};
  for (const name of ["index.html", "style.css", "app.js", "load-worker.js"]) {
    expectedAssets[name] = Deno.args.includes("--real-assets")
      ? await Deno.readTextFile(`public/${name}`)
      : `fixture ${name}`;
    await Deno.writeTextFile(`${sandbox}/public/${name}`, expectedAssets[name]);
  }
  const compile = await new Deno.Command(Deno.execPath(), {
    cwd: sandbox,
    args: ["compile", "--no-prompt", "--no-remote", "--no-npm", "--allow-read=public", "--allow-net=127.0.0.1", runPermissions, "--include", "public", "--output", "macdry-test", "server.mjs"],
    stdout: "null", stderr: "piped",
  }).output();
  assert(compile.success, `Deno compilation failed: ${new TextDecoder().decode(compile.stderr)}`);

  const probe = async (command, options) => {
    const child = new Deno.Command(command, { ...options, stdout: "piped", stderr: "piped", stdin: "null" }).spawn();
    const reader = child.stdout.getReader();
    let timer;
    try {
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Server startup timed out")), 10_000); });
      let output = "";
      let match;
      while (!match) {
        const chunk = await Promise.race([reader.read(), deadline]);
        assert(!chunk.done, "Server exited before printing its URL");
        output += new TextDecoder().decode(chunk.value);
        assert(output.length < 4096, "Server startup output was unexpected");
        match = /Open: (http:\/\/127\.0\.0\.1:\d+\/)#([0-9a-f]{64})/.exec(output);
      }
      clearTimeout(timer);
      const [, url, token] = match;
      for (const name of ["", "index.html", "style.css", "app.js", "load-worker.js"]) {
        const response = await fetch(url + name);
        assert(response.status === 200, `Asset ${name} failed`);
        assert((await response.text()) === expectedAssets[name || "index.html"], `Asset ${name} did not match`);
      }
      assert((await fetch(url + "api/checks")).status === 401, "Missing token was accepted");
      assert((await fetch(url + "api/load-test/preflight")).status === 401, "Load-test preflight accepted a missing token");
      assert((await fetch(url + "api/checks", { headers: { "x-macdry-token": "b".repeat(64) } })).status === 401, "Invalid token was accepted");
      assert((await fetch(url, { headers: { origin: "http://attacker.example" } })).status === 403, "Foreign Origin was accepted");
      const port = Number(new URL(url).port);
      const connection = await Deno.connect({ hostname: "127.0.0.1", port });
      try {
        await connection.write(new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: rebinding.invalid:${port}\r\nConnection: close\r\n\r\n`));
        const bytes = new Uint8Array(1024);
        const count = await connection.read(bytes);
        assert(count && /^HTTP\/1\.1 403\b/.test(new TextDecoder().decode(bytes.subarray(0, count))), "Foreign Host was accepted");
      } finally {
        connection.close();
      }
      const response = await fetch(url + "api/checks", { headers: { "x-macdry-token": token } });
      assert(response.status === 200, "Authenticated diagnostic failed");
      const data = await response.json();
      assert(data.checks.length === 11, "Diagnostic check count mismatch");
      for (const id of ["macos", "model", "cpu", "memory", "gpu", "storage", "smart", "battery", "memory_pressure", "battery_power", "thermal"]) {
        assert(data.checks.some((check) => check.id === id), `Missing check ${id}`);
      }
      assert(data.checks.every((check) => ["info", "warning", "unavailable", "fail"].includes(check.status)), "Unknown diagnostic status");
      assert(data.checks.every((check) => typeof check.recommendation === "string" && check.recommendation.length > 0), "Missing recommendation");
      const preflightResponse = await fetch(url + "api/load-test/preflight", { headers: { "x-macdry-token": token } });
      assert(preflightResponse.status === 200, "Authenticated load-test preflight failed");
      const preflight = await preflightResponse.json();
      assert(typeof preflight.eligible === "boolean", "Load-test preflight omitted eligibility");
      assert(preflight.checks.length === 2, "Load-test preflight returned unexpected signals");
      assert(preflight.checks.every((check) => ["memory_pressure", "thermal"].includes(check.id)), "Load-test preflight returned an unexpected check");
      const pressure = preflight.checks.find((check) => check.id === "memory_pressure");
      const thermal = preflight.checks.find((check) => check.id === "thermal");
      assert(preflight.eligible === (pressure.status === "info" && ["info", "unavailable"].includes(thermal.status)), "Load-test preflight eligibility was inconsistent");
      const smart = data.checks.find((check) => check.id === "smart");
      assert(smart.source === "system_profiler SPNVMeDataType", "Unexpected SMART source");
      assert(["info", "warning", "unavailable"].includes(smart.status), "Unexpected SMART status");
      console.log(`${options.label}: ${data.checks.map((check) => `${check.id}=${check.status}`).join(", ")}`);
    } finally {
      clearTimeout(timer);
      try { child.kill("SIGINT"); } catch { /* The process already exited. */ }
      await reader.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
      await child.status;
    }
  };

  await probe(Deno.execPath(), {
    cwd: sandbox,
    args: ["run", "--no-prompt", "--no-remote", "--no-npm", "--allow-read=public", "--allow-net=127.0.0.1", runPermissions, "server.mjs", "--no-open"],
    label: "development",
  });
  const executable = await Deno.realPath(`${sandbox}/macdry-test`);
  await Deno.remove(`${sandbox}/public`, { recursive: true });
  await Deno.remove(`${sandbox}/src`, { recursive: true });
  await Deno.remove(`${sandbox}/build`, { recursive: true });
  await Deno.remove(`${sandbox}/server.mjs`);
  await probe(executable, { cwd: "/", args: ["--no-open"], label: "compiled" });
} finally {
  await Deno.remove(sandbox, { recursive: true });
}
