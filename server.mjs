import { checks } from "./build/dev/javascript/macdry/macdry.mjs";
import { collectFacts } from "./src/system.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function reply(body, status, contentType = "text/plain; charset=utf-8") {
  return new Response(body, { status, headers: { ...securityHeaders, "content-type": contentType } });
}

function sameToken(actual, expected) {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

export function createHandler({ port, token, readAsset, scan = collectFacts }) {
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  let pendingScan;
  return async (request) => {
    if (request.headers.get("host") !== host ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin) ||
      request.headers.get("sec-fetch-site") === "cross-site") {
      return reply("Forbidden", 403);
    }
    if (request.method !== "GET") return reply("Method not allowed", 405);
    const path = new URL(request.url).pathname;
    if (path === "/api/checks") {
      if (!sameToken(request.headers.get("x-macdry-token") ?? "", token)) return reply("Unauthorized", 401);
      try {
        pendingScan ??= Promise.resolve().then(scan).finally(() => { pendingScan = undefined; });
        const facts = await pendingScan;
        return reply(JSON.stringify({ checks: Array.from(checks(facts)) }), 200, "application/json; charset=utf-8");
      } catch {
        return reply("Diagnostic unavailable", 500);
      }
    }
    const asset = assets.get(path);
    if (!asset) return reply("Not found", 404);
    try {
      const body = await readAsset(asset[0]);
      return reply(body, 200, asset[1]);
    } catch {
      return reply("Asset unavailable", 404);
    }
  };
}

function usage() {
  console.log(`MacDry — local macOS Apple Silicon diagnostics

Build: gleam build --target javascript
Run:   deno run --no-prompt --no-remote --no-npm --allow-read=public --allow-net=127.0.0.1 --allow-run=/usr/bin/sw_vers,/usr/sbin/sysctl,/bin/df,/usr/sbin/system_profiler,/usr/bin/pmset,/usr/bin/open server.mjs
Pack:  deno compile --no-prompt --no-remote --no-npm --allow-read=public --allow-net=127.0.0.1 --allow-run=/usr/bin/sw_vers,/usr/sbin/sysctl,/bin/df,/usr/sbin/system_profiler,/usr/bin/pmset,/usr/bin/open --include public --output macdry server.mjs

Run the binary, then open the printed URL if the browser did not open.
Use --no-open to skip opening the browser. The URL fragment is a secret.
Press Ctrl+C to stop the server. No data is sent externally.
Inventory is not a hardware health test. Storage warns at 90% usage;
battery condition and power are reported by macOS and may be unavailable.
Memory pressure and thermal levels are snapshots, not hardware health tests.`);
}

async function main() {
  if (Deno.args.includes("--help")) { usage(); return; }
  if (Deno.args.some((arg) => arg !== "--no-open")) {
    console.error("Unknown argument. Use --help for usage.");
    Deno.exitCode = 2;
    return;
  }
  if (Deno.build.os !== "darwin" || Deno.build.arch !== "aarch64") {
    console.error("MacDry requires macOS on Apple Silicon.");
    Deno.exitCode = 1;
    return;
  }
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen() {},
  }, (request) => handler(request));
  const port = server.addr.port;
  const handler = createHandler({
    port,
    token,
    readAsset: (name) => Deno.readFile(new URL(`./public/${name}`, import.meta.url)),
  });
  const url = `http://127.0.0.1:${port}/#${token}`;
  console.log(`MacDry is listening on 127.0.0.1:${port}.\nOpen: ${url}\nKeep this URL private. Press Ctrl+C to stop.`);
  if (!Deno.args.includes("--no-open")) {
    try {
      const child = new Deno.Command("/usr/bin/open", { args: [url], stdin: "null", stdout: "null", stderr: "null" }).spawn();
      child.status.then((status) => {
        if (!status.success) console.error("Could not open the browser; use the URL above.");
      }).catch(() => console.error("Could not open the browser; use the URL above."));
    } catch {
      console.error("Could not open the browser; use the URL above.");
    }
  }
  await server.finished;
}

if (import.meta.main) await main();
