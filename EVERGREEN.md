## Summary
- Provide silent, session-scoped npm authentication for ordinary local commands.
- Prefer trusted project settings over global settings; never silently fall back on invalid project settings.
- Use Pi's public extension lifecycle, trust, command, notification, and agent-directory APIs.
- No internal or undocumented Pi APIs are used by the extension.
- Process-wide environment ownership and npm config precedence are the main integration risks.
- Protect credentials, original npm settings, and cleanup without claiming a secret sandbox.

## Intent
Users store a granular token in private npm-auth.json, not launch-time shell exports.
Local bash, user shell commands, and npm lifecycle scripts inherit authentication.
The extension never publishes automatically and never adds tokens to prompts or sessions.
Successful startup/reload is silent; invalid settings report an error without terminating Pi.
Missing settings leave existing authentication alone. Custom registries and remote forwarding are outside scope.

## Pi integration (public APIs)
The package exports a TypeScript factory using ExtensionAPI and ExtensionContext.
getAgentDir() locates global settings, including PI_CODING_AGENT_DIR overrides.
pi.on(session_start/session_shutdown) sets up and disposes credentials.
ctx.cwd and ctx.isProjectTrusted() select permitted settings.
pi.registerCommand("npm-token") waits through ctx.waitForIdle() before reconfiguration.
ctx.ui.notify reports errors; no status, context, tool interception, or session entries are added.
Local tools inherit process.env; generated npmrc references ${NPM_TOKEN}, not its literal value.

## Internal Pi APIs
None. No deep imports, private fields, undocumented events, or Pi monkey patches.
The extension's own global owner marker prevents separately loaded copies from overlapping.
Tests additionally use public SDK resource loading, sessions, reload, bash execution, and provider hooks.

## Weak points
Authentication lives in process.env and is readable by trusted extensions and child processes.
Other environment writers must not be overwritten during cleanup; only one active owner is supported.
Trust decisions and shutdown/reload event ordering must remain compatible with Pi.
npm CLI precedence can override auth; project/ancestor userconfig directives are rejected.
A private, owned, non-symlink project tmp directory is required; forced kills can leave files.
Copied npmrc settings can contain unrelated credentials and must remain private.
POSIX permission checks do not establish equivalent Windows ACL protection.

## Tests
npm run test:evergreen refreshes the latest stable Pi dev dependency, typechecks, then runs all layers.
Unit: test/auth.test.ts covers trust, malformed/private files, ownership, npm and lifecycle inheritance,
config preservation, environment restoration, idle waiting, silence, and safe diagnostics.
Integration: test/runtime.integration.ts loads the actual extension in Pi's SDK, runs npm through
Pi's shell, and proves command/runtime reload, invalid-settings recovery, and settings removal.
E2E: test/runtime.e2e.mjs launches EVERGREEN_PI_BIN (or pi on PATH) with stdin ignored.
EVERGREEN_E2E_MODEL is required and selects real model calls using the caller's model login.
Real bash/npm probes verify trusted-project precedence, untrusted global fallback, and missing settings.
Provider payloads, CLI output, and persisted sessions must not contain dummy credentials.
Shutdown must restore the environment, remove generated configs, and preserve the original npmrc.
All npm credentials are fake; no npm authentication or publishing is attempted.
Not covered: retry/compaction, session replacement, interactive UI, forced-kill cleanup, real publishing policy.
Tested with global Pi 1.4.0; no lint script is configured.

## Relevant changelog topics
Watch extension loading/package exports, getAgentDir and agent-directory overrides, project trust,
session_start/session_shutdown ordering on reload/replacement, command waitForIdle, and notifications.
Watch bash subprocess environment inheritance and TypeScript extension loading/dependency resolution.
Test harness compatibility also depends on SDK binding/reload, JSON events, provider payload hooks,
model selection/auth discovery, and persisted session formats.
