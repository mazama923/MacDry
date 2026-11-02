# MacDry agent instructions

- Code, comments, documentation and identifiers are in English.
- Keep the product offline by default, non-destructive and compatible with Apple Silicon. The separately confirmed Internet-quality test is the only intentional external network access. Do not add stress or write-heavy tests without explicit opt-in and a clear preflight.
- Keep diagnostic rules and result semantics in Gleam where practical. JavaScript is the boundary for Deno, macOS commands and browser APIs; avoid adding dependencies without a concrete need.
- Never report inventory, a successful command, a browser permission or SMART `Verified` as proof that hardware is healthy. Preserve unavailable/unknown results and explain each test's limits.
- Keep system commands fixed and allowlisted. Bound runtime and output; never run MacDry as root or require general `sudo`. A test may request macOS administrator authorization only for one fixed command after explicit user action. Never invoke a shell with user input.
- Do not persist or export serial numbers, raw system-profiler output, typed keys, camera footage or microphone audio. Request media permissions only after a user action and stop streams when no longer needed.
- Preserve the loopback-only server, origin/host checks, session token, fixed asset routes and offline assets. Do not add telemetry or external CDNs.
- Update `README.md`, `docs/architecture.md` and targeted tests when behavior changes. See the README for build and test commands.
