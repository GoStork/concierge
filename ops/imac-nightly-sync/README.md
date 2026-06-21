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

1. Make sure the iMac's `.env` has `DATABASE_URL` (prod), GCS creds, and scraper
   settings - same as the dev env. **Do NOT** add `ENABLE_NIGHTLY_SCHEDULER`
   there; the launchd wrapper sets it (so only this launchd-managed process is
   the scheduler).

2. Edit paths if the repo is not at `~/Documents/GitHub/concierge`:
   - `ops/imac-nightly-sync/run-server.sh` -> `REPO_DIR` / `GOSTORK_REPO_DIR`
   - `ops/imac-nightly-sync/com.gostork.nightly-sync.plist` -> the `run-server.sh`
     path and `GOSTORK_REPO_DIR`

3. Install and start the agent:
   ```bash
   chmod +x ops/imac-nightly-sync/run-server.sh
   cp ops/imac-nightly-sync/com.gostork.nightly-sync.plist ~/Library/LaunchAgents/
   launchctl unload ~/Library/LaunchAgents/com.gostork.nightly-sync.plist 2>/dev/null
   launchctl load  ~/Library/LaunchAgents/com.gostork.nightly-sync.plist
   ```

4. Verify it is running and scheduled:
   ```bash
   launchctl list | grep gostork
   grep "In-process scheduler ENABLED" /tmp/gostork-server.log
   ```
   You should see `[nightly-sync] In-process scheduler ENABLED on this host`.

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
