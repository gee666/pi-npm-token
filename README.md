# oira666_pi-npm-token

Tested against Pi 1.4.0

Load an npm token from a settings file so local commands such as `npm publish` work inside Pi. You do not need to export environment variables or change how you launch Pi.

## Install

```bash
pi install npm:oira666_pi-npm-token
```

Until the first npm release is published, install from GitHub:

```bash
pi install git:github.com/gee666/pi-npm-token
```

Restart Pi or run `/reload` after installation.

## Set up your token

Create a granular npm token with read/write access only to the packages you intend to publish. For unattended publishing, the token needs npm's bypass-2FA permission and the package must allow it. This extension cannot bypass npm's token permissions, expiry, IP restrictions, or package publishing policy. It does not handle interactive 2FA, open browser verification links, or run publishing in the background. If npm requests verification, normal shell-tool interaction and timeout limits apply.

Save the token in either:

- Global settings: `~/.pi/agent/npm-auth.json`.
- Project settings: `<project>/.pi/npm-auth.json`.

If Pi uses a custom agent directory, put the global file there instead. A trusted project's settings take precedence over global settings. The files are not merged. Untrusted project settings are ignored.

```json
{
  "token": "YOUR_NPM_TOKEN"
}
```

On Linux, macOS, and WSL, make the file private before adding the token. For global settings:

```bash
mkdir -p ~/.pi/agent
touch ~/.pi/agent/npm-auth.json
chmod 600 ~/.pi/agent/npm-auth.json
```

Open that file in your editor and add the JSON above with your real token. Do not paste the token into chat or put it in a shell command. For project settings, also add `.pi/npm-auth.json` to the project's `.gitignore`. On Windows, restrict access using file permissions.

Run `/reload` or `/npm-token` after saving. The extension is silent on success and does not add anything to the status line. Errors appear as plain TUI notifications. To verify the token, run `npm whoami`.

Now you or the assistant can run a normal local shell command:

```bash
npm whoami
npm publish
```

Publishing still needs your authorization. The extension does not publish anything automatically.

## How it works

At session startup, the extension reads the settings and sets `NPM_TOKEN` in Pi's process environment. It creates a private npm user config under `<project>/tmp/pi-npm-token-*/npmrc`, preserving your existing user-config settings and adding authentication scoped to `registry.npmjs.org`. Both npm user-config environment variables point to this file.

The generated authentication entry references the environment variable, not the literal token. The copied npmrc can still contain other literal credentials from your existing user config, so it must remain private. Your existing `~/.npmrc` is never modified. The project must have a writable `tmp` directory. On POSIX it must be owned by you and not writable by other users. A symlinked `tmp` is rejected. Ignore `tmp/` in version control.

Local child processes inherit authentication, including Pi's bash tool, local `!` commands, and npm lifecycle scripts. Custom registries are not supported. A `userconfig` setting in a project or ancestor `.npmrc` is explicitly rejected rather than silently overridden. If you select a custom user config, use `NPM_CONFIG_USERCONFIG` before starting Pi instead. Normal npm precedence still applies: other project `.npmrc` settings, command-line options, and npm environment settings can override the generated user config. Only one extension instance can manage credentials in a Pi process.

Shutdown, session replacement, and `/reload` restore the previous environment and remove the generated directory. A forced kill can leave a private temporary directory behind. You can remove leftover `tmp/pi-npm-token-*` directories once their Pi processes have exited.

If settings are missing, the extension leaves your normal npm authentication alone. Invalid settings show an error without terminating Pi. A malformed project file never silently falls back to a global token. `/npm-token` reloads settings after waiting for the agent to become idle.

## Security and limits

Treat the settings file as a password. Never commit it, share it in a transcript, or publish it in an npm tarball. The extension's own package includes only its source, README, and license.

The extension does not print tokens or put them in prompts or session entries. However, the token is available to Pi, installed extensions, and local subprocesses. Untrusted scripts can read it. Commands such as `env`, `printenv`, or reading the settings file can expose it in tool output. This is credential convenience, not a secret sandbox. Use it only with trusted projects and extensions.

This extension does not forward credentials to SSH hosts. Other extensions control their own forwarding behavior. With a remote-shell extension, run `npm publish` through a local tool or configure authentication separately on the remote host. Already-running processes do not gain the token, and child processes that survive Pi may retain their inherited environment.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

`npm test` first installs the latest stable Pi coding-agent development dependency from npm, runs strict TypeScript checking, and then runs the test suite. Registry access is required for the dependency refresh, which can update `package.json` and `package-lock.json`. Dependency lifecycle scripts are disabled during the refresh. If the update or typecheck fails, tests do not run. `npm run typecheck` checks the currently installed dependencies without refreshing them.

Tests use dummy credentials and local subprocesses. They cover configuration, project trust, private-file handling, npm environment inheritance, lifecycle behavior, and cleanup. They do not contact npm to authenticate or publish a package, and do not prove that a real token has publishing permission.

Before every release, update the tested-against line at the top of this README to the actual Pi version that passed the checks. Keep the supported Pi peer range in `package.json` accurate, and inspect `npm pack --dry-run --ignore-scripts` to ensure no credentials or temporary files are packaged. The tracked root `AGENTS.md` contains the release instructions and code quality bar.
