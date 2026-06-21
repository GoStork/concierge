# Nightly scraper sync - iMac host setup

As of Jun 2026 the nightly donor/surrogate scraper sync runs on the **always-on
iMac**, not on Replit.

## Why not Replit

Replit Autoscale is request-scoped: it keeps a container alive only while an HTTP
request is in flight. The nightly sync is fire-and-forget background work that
runs for well over an hour, so Autoscale reaped the container mid-run - that is
what produced the Jun 21 "Interrupted - server restarted while sync was running"
failures. A long-lived host fixes this at the root.

The GitHub Actions pinger (`.github/workflows/nightly-sync.yml`) is now
**disabled** as the driver (manual `workflow_dispatch` only, kept as an emergency
trigger). The in-process `node-cron` scheduler (2 AM ET) drives the run instead,
enabled on the iMac via `ENABLE_NIGHTLY_SCHEDULER=true`.

The atomic `NightlySyncLock` row remains the cross-host safety net, so even if a
stray trigger fires elsewhere it cannot double-run.

The server runs as a **LaunchDaemon** (`com.gostork.nightly-sync.daemon.plist`),
not a LaunchAgent, so it starts at boot - before/without login - and survives a
reboot or power-failure restart unattended. It runs as the user (`UserName`), not
root, because root's HOME is `/var/root` and macOS TCC blocks even root from
`~/Documents`, so as root it could not read the repo/.env/git creds.

## Converting from the old LaunchAgent (if one is installed)

If you previously installed the LaunchAgent at
`~/Library/LaunchAgents/com.gostork.nightly-sync.plist`, remove it first so it
does not fight the daemon for port 5001:

```bash
launchctl unload ~/Library/LaunchAgents/com.gostork.nightly-sync.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.gostork.nightly-sync.plist
lsof -ti tcp:5001 | xargs kill 2>/dev/null   # free the port the agent held
```

Then follow the install steps below.

## One-time install on the iMac (LaunchDaemon)

> The iMac's actual working clone is **`~/Documents/GitHub-iMac/concierge`**, not
> `~/Documents/GitHub/concierge`. The committed plist + `run-server.sh` already
> point at `GitHub-iMac`. The notes below are the steps that actually worked on
> Jun 21 2026 - the earlier "happy path" missed four macOS specifics (TCC, PATH,
> which plist copy to edit, port 5001).

1. Make sure the clone is current and the env is set:
   ```bash
   cd ~/Documents/GitHub-iMac/concierge
   git fetch origin && git reset --hard origin/main   # it was 16 commits behind
   ```
   The iMac's `.env` must have `DATABASE_URL` (prod), GCS creds, and scraper
   settings. **Do NOT** add `ENABLE_NIGHTLY_SCHEDULER` to `.env` or the shell -
   the launchd wrapper sets it, so this one launchd process is the sole scheduler.

2. **Grant Full Disk Access to `/bin/bash`** (System Settings -> Privacy &
   Security -> Full Disk Access). launchd jobs are blocked by macOS TCC from
   reading `~/Documents`, so without this the wrapper can't even `cd` into the
   repo and the agent silently fails.

3. **Free port 5001** - stop any existing `npm run dev` / dev server so the
   launchd-managed production server can bind:
   ```bash
   lsof -ti tcp:5001 | xargs kill 2>/dev/null
   ```

4. Confirm where node lives and that the plist's `PATH` includes it - launchd
   starts with a minimal PATH that lacks node/npm/git:
   ```bash
   which node   # e.g. /usr/local/bin/node or /opt/homebrew/bin/node
   ```
   The committed plist already sets `PATH=/usr/local/bin:/opt/homebrew/bin:...`;
   adjust if node is elsewhere.

5. Install the daemon. A LaunchDaemon lives in `/Library/LaunchDaemons/`, must be
   owned `root:wheel` mode `644`, and is loaded with `sudo` into the `system`
   domain. The installed filename should be `com.gostork.nightly-sync.plist`:
   ```bash
   chmod +x ops/imac-nightly-sync/run-server.sh
   sudo cp ops/imac-nightly-sync/com.gostork.nightly-sync.daemon.plist \
           /Library/LaunchDaemons/com.gostork.nightly-sync.plist
   sudo chown root:wheel /Library/LaunchDaemons/com.gostork.nightly-sync.plist
   sudo chmod 644        /Library/LaunchDaemons/com.gostork.nightly-sync.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/com.gostork.nightly-sync.plist
   # (older macOS syntax: sudo launchctl load -w /Library/LaunchDaemons/com.gostork.nightly-sync.plist)
   ```
   The daemon plist points at the repo `run-server.sh` directly (the path is
   absolute), so unlike the old agent there is no "edit the installed copy"
   gotcha - though `run-server.sh` still self-`git pull`s on each restart, so the
   plist itself is only re-read when you reload the daemon.

6. Verify it is running and scheduled:
   ```bash
   sudo launchctl print system/com.gostork.nightly-sync | grep -E "state|pid" | head
   grep "In-process scheduler ENABLED" /tmp/gostork-server.log
   ```
   You should see the service `running` with a pid, plus
   `[nightly-sync] In-process scheduler ENABLED on this host` and
   `Scheduler started - runs daily at 2:00 AM ET` in the log. The iMac's public
   tunnel is `polygynous-vergie-coyly-imac.ngrok-free.dev` -> 5001 (the tunnel is
   only for the dashboard; the nightly sync itself needs just DB + outbound HTTP).

   If the log shows permission errors reading `~/Documents`, re-grant **Full Disk
   Access to `/bin/bash`** (step 2) - the daemon runs the same `/bin/bash`, so the
   existing grant should carry over, but a fresh grant fixes it if not.

## Keeping the Mac awake

`run-server.sh` runs the server under `caffeinate -is`, which blocks idle system
+ disk sleep for as long as the process runs. With launchd `KeepAlive` the
process is always running, so the iMac will not idle-sleep and the 2 AM cron
fires. (Lid-closed clamshell sleep on a desktop iMac is not a factor; if this
ever moves to a laptop, also set `pmset -c sleep 0` on AC power.)

If the machine is off/asleep across 2 AM for any reason, the boot-time
`runCatchUpIfStale` fires a catch-up run ~30s after the server next starts, as
long as the last successful nightly is older than 25h.

## Operating

The daemon lives in the `system` domain, so its `launchctl` commands need `sudo`:

- **Restart the server:** `sudo launchctl kickstart -k system/com.gostork.nightly-sync`
- **Status:** `sudo launchctl print system/com.gostork.nightly-sync | head -30`
- **Stop / disable:** `sudo launchctl bootout system/com.gostork.nightly-sync`
  (re-enable with the `bootstrap` command from install step 5)
- **After editing the plist:** `bootout` then `bootstrap` again to re-read it.
- **Manually trigger a run:** admin UI "Trigger nightly", or `POST /api/scrapers/trigger-nightly`.
- **Logs:** `/tmp/gostork-server.log`
