# dsh-caffeinate

Keep the **DSH host** awake while one or more DSH agents are running. Targets DSH **0.2.1-rc.2**, Node **24+**, Linux and macOS.

## Install and configure

Once a release is published, install its GitHub release tarball (this example does not claim the release is already published):

```sh
dsh plugin --profile headless add https://github.com/LIghtJUNction/dsh-caffeinate/releases/download/v0.1.0/lightjunction-dsh-caffeinate-0.1.0.tgz
```

The included bundle patch enables automatic lifecycle tracking. Restart DSH if HMR is disabled. Optional profile patch configuration:

```yaml
- id: dsh-caffeinate
  name: '@lightjunction/dsh-caffeinate'
  config:
    enabled: true
    mode: sleep
```

`mode: sleep` blocks system sleep; `mode: display` also requests display/idle inhibition. Direct TypeScript registration uses `import * as plugin` and `await ctx.plugin(plugin, { enabled: true, mode: 'sleep' })`.

Linux uses `systemd-inhibit --what=sleep` (or `idle:sleep`) with a foreground Node stdin holder. logind must be available and permit the inhibit request. macOS uses `caffeinate -i -w <DSH-pid>` plus `-d` in display mode. The child process stays owned by the plugin; stdin EOF releases the Linux holder if DSH exits abruptly, and macOS `-w` binds the inhibitor to the DSH PID.

## Tool example

```text
caffeinate {"action":"status"}
caffeinate {"action":"disable","revision":2}
caffeinate {"action":"enable","revision":3}
```

Use the actual revision returned by status; agent transitions also change it. Status returns `enabled`, `activeAgents`, `pid` (0 means no owned live process), `mode`, `revision` and `error`. Read `error`: a PID alone is not proof that the OS granted inhibition. A spawn failure or unexpected exit is reported without crashing an agent. Enabling while agents are running retries a failed start; no automatic crash loop is used.

Running agents form a set: duplicate transitions cannot increment the count twice, and one agent becoming idle cannot release another agent's inhibitor. Serialized lifecycle operations own at most one process per plugin instance. The last idle/disposed agent, explicit disable, or plugin unload closes stdin, sends SIGTERM to the process group, escalates to SIGKILL if necessary, and waits for reaping. Cancelling an agent releases its reference when DSH reaches idle. Aborting a status call does not stop other agents' inhibitor.

An optional trusted `command` argv array overrides the backend for unusual hosts or diagnostics, e.g. `["node", "-e", "process.stdin.resume()"]` for a foreground lifecycle probe. This example **does not inhibit sleep**. There is no shell expansion. Overrides must stay in the foreground and release on stdin EOF; arbitrary backgrounding programs are unsupported.

## Limits and verification

- This controls the local DSH process host, not a remote world, remote filesystem, remote machine or sandbox. No Windows/WSL PowerShell backend is implemented.
- Linux display mode requests logind idle inhibition; some compositors ignore it. This version has no D-Bus ScreenSaver portal/compositor fallback and cannot promise a lit display on all desktops. No Pi menus/status bar, saved preferences, or Pi environment-variable compatibility.
- Reference counting is shared across agents **within one plugin instance**, not across independent DSH processes or duplicate plugin instances. OS locks are normally additive.
- OS policy, missing executables and permissions may prevent inhibition. A foreground custom override has its own semantics. SIGKILL of DSH closes Linux stdin/macOS parent binding, but power loss and hostile custom programs are outside plugin guarantees.

```sh
npm run check --workspace @lightjunction/dsh-caffeinate
```

Tests run real DSH agent loops against a cancellable offline model and real foreground Node processes: two simultaneous agents share a PID, one cancellation preserves the other reference, last cancellation/disable/unload proves PID death, stale revisions and invalid/aborted calls fail, and missing executables report errors. Linux/macOS command construction is checked; process fixtures do not prove OS sleep behavior or macOS device acceptance. See [UPSTREAM.md](UPSTREAM.md) and [NOTICE](NOTICE).
