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

## One-time install on the iMac

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

5. Install and start the agent. **Edit the INSTALLED copy** in `~/Library/
   LaunchAgents/`, not the repo file - `run-server.sh` self-`git pull`s, so any
   edit to the repo plist would be reverted on the next restart anyway:
   ```bash
   chmod +x ops/imac-nightly-sync/run-server.sh
   cp ops/imac-nightly-sync/com.gostork.nightly-sync.plist ~/Library/LaunchAgents/
   # verify the paths in the installed copy point at GitHub-iMac:
   #   ~/Library/LaunchAgents/com.gostork.nightly-sync.plist
   launchctl unload ~/Library/LaunchAgents/com.gostork.nightly-sync.plist 2>/dev/null
   launchctl load  ~/Library/LaunchAgents/com.gostork.nightly-sync.plist
   ```

6. Verify it is running and scheduled:
   ```bash
   launchctl list | grep gostork                       # shows a PID, not just "-"
   grep "In-process scheduler ENABLED" /tmp/gostork-server.log
   ```
   You should see `[nightly-sync] In-process scheduler ENABLED on this host` and
   `Scheduler started - runs daily at 2:00 AM ET`. The iMac's public tunnel is
   `polygynous-vergie-coyly-imac.ngrok-free.dev` -> 5001.

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

- **Restart the host:** `launchctl kickstart -k gui/$(id -u)/com.gostork.nightly-sync`
- **Stop driving the nightly here:** `launchctl unload ~/Library/LaunchAgents/com.gostork.nightly-sync.plist`
- **Manually trigger a run:** admin UI "Trigger nightly", or `POST /api/scrapers/trigger-nightly`.
- **Logs:** `/tmp/gostork-server.log`
