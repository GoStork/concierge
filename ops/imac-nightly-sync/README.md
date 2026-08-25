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

> The iMac's actual working clone is **`~/GitHub-iMac/concierge`** (verified
> Aug 5 2026 against the installed plist's `GOSTORK_REPO_DIR`) - NOT
> `~/Documents/GitHub/concierge`, and NOT under `~/Documents` at all. The
> committed plist + `run-server.sh` point at it via an absolute path. The notes
> below are the steps that actually worked on Jun 21 2026 - the earlier "happy
> path" missed four macOS specifics (TCC, PATH, which plist copy to edit, port
> 5001).

1. Make sure the clone is current and the env is set:
   ```bash
   cd ~/GitHub-iMac/concierge
   git pull origin main --ff-only   # safe fast-forward; refuses rather than clobbers
   ```
   This clone doubles as the dev workspace, so do NOT `git reset --hard` here - it
   would silently discard uncommitted local work. Commit or stash first if the tree
   is dirty, then `--ff-only`. (`run-server.sh` self-`git pull --rebase`s on each
   restart, which needs a clean tree, so keep this clone tidy.)
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
   # Write to a temp name and mv into place - never overwrite a live launchd
   # file in situ (see "Install live files atomically" below).
   sudo cp ops/imac-nightly-sync/com.gostork.nightly-sync.daemon.plist \
           /Library/LaunchDaemons/.com.gostork.nightly-sync.plist.new
   sudo mv /Library/LaunchDaemons/.com.gostork.nightly-sync.plist.new \
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

## Auto-sync (pull + restart ~60s after a push to main)

Separate from the daemon above. `~/.gostork/auto-sync.sh`, driven by the
`com.gostork.autosync` LaunchAgent (StartInterval 60), notices when
`origin/main` has moved and kickstarts the daemon, which does the actual pull
inside `run-server.sh`. The versioned copy is `auto-sync.sh` in this directory -
it was unversioned until 2026-08-25, which is how the two dev boxes silently
drifted apart.

    cp ops/imac-nightly-sync/auto-sync.sh ~/.gostork/auto-sync.sh.new
    mv ~/.gostork/auto-sync.sh.new ~/.gostork/auto-sync.sh
    chmod +x ~/.gostork/auto-sync.sh

### Install live files atomically

Use `cp` to a temp name then `mv`, never a plain `cp` over the live file. The
agent fires every 60 seconds, so a straight overwrite can land while bash is
mid-execution - and bash reads a script incrementally by byte offset, so it
resumes at whatever now sits at that offset. On 2026-08-25 the MacBook did
exactly this and got:

    ~/.gostork/auto-sync.sh: line 23: om.gostork.nightly-sync: command not found

bash resuming into the middle of a comment line. Harmless that time; on a script
that does something destructive mid-file, or one running as root, it would not
be. `mv` swaps the inode, so anything already running finishes on the old file.

`run-server.sh` is covered against the same hazard from the other direction: the
daemon runs it straight from the repo and it `git pull`s itself, so its body is
wrapped in `main()` - bash parses the whole function before executing any of it.
Keep `main "$@"` as the last line.

### Failure behaviour

Attempts are counted per remote SHA, so every new push starts fresh. The counter
clears the moment the box is in sync.

- attempts 1-5: kickstart the daemon each cycle
- attempts 6-29: silent, so a wedge does not flood the log
- every 30th attempt: log `WEDGED ... running STALE CODE` with the diagnostic
  commands **and kickstart anyway** - so a tree an operator has since cleaned
  self-heals within ~30 minutes instead of staying stale forever
- the daemon's pull exiting 0 without moving HEAD is inherently counted as a
  failure here, because only `local == remote` clears the counter

Why the cap exists: before 2026-08-25 this kickstarted every 60s for as long as
`local != remote`. When the daemon's pull could not succeed - a dirty
`package-lock.json` aborts `git pull --rebase` - nothing advanced HEAD, the
condition stayed true, and the iMac restarted **8,772 times over six days** on
70-commit-stale code while every log line looked like normal progress.

### Do not cross-install with the MacBook

`ops/macbook-autosync/` is a deliberately different design - it pulls inside the
agent with `--autostash` and kickstarts `gui/<uid>/com.gostork.server` only
after HEAD actually moves. That launchd label **does not exist on the iMac**,
and `system/com.gostork.nightly-sync` does not exist on the MacBook. Installing
either script on the other box makes every kickstart a silent no-op - auto-deploy
stops while the log still looks healthy. Comparison table:
`ops/macbook-autosync/README.md`.

## Keeping the Mac awake

`run-server.sh` runs the server under `caffeinate -is`, which blocks idle system
+ disk sleep for as long as the process runs. With launchd `KeepAlive` the
process is always running, so the iMac will not idle-sleep and the 2 AM cron
fires. (Lid-closed clamshell sleep on a desktop iMac is not a factor; if this
ever moves to a laptop, also set `pmset -c sleep 0` on AC power.)

If the 2 AM run is missed for any reason, the boot-time `runCatchUpIfStale`
fires a catch-up ~30s after the server next starts, whenever the **current 2 AM
ET period** still has no successful nightly (`total > 0`). It shares the
`lastNightlySlotStart()` boundary with the dedup gate in `runNightlySync`, so
the two can never disagree about whether a period has been satisfied.

> **Do not reintroduce rolling-hour windows here.** Until Aug 5 2026 the dedup
> used "last 20h" and the catch-up used ">25h", and the 5-hour gap between them
> deadlocked: a catch-up that ran mid-morning was <20h before the next 2 AM cron
> (so the cron skipped) and <25h at the next morning's boot (so the catch-up
> skipped too), losing a full day, then repeating. Aug 2 and Aug 5 2026 ran not
> at all; Aug 3 and Aug 4 ran at 08:13 and 11:20 ET instead of 02:00.

Note the cron can also miss its tick while the process is alive: on Aug 5 2026
node-cron logged `missed execution ... Possible blocking IO or high CPU` for
several slots, including 02:00. The iMac also hosts the `nutrition-planner`
(port 5002, launchd `com.nutrition-planner.server`) and `AI-Health` servers, so
event-loop pressure is real. The catch-up now covers a missed tick same-day,
but if `missed execution` warnings become frequent, reduce what else runs here.

## Operating

The daemon lives in the `system` domain, so its `launchctl` commands need `sudo`:

- **Restart the server:** `sudo launchctl kickstart -k system/com.gostork.nightly-sync`
- **Status:** `sudo launchctl print system/com.gostork.nightly-sync | head -30`
- **Stop / disable:** `sudo launchctl bootout system/com.gostork.nightly-sync`
  (re-enable with the `bootstrap` command from install step 5)
- **After editing the plist:** `bootout` then `bootstrap` again to re-read it.
- **Manually trigger a run:** admin UI "Trigger nightly", or `POST /api/scrapers/trigger-nightly`.
- **Logs:** `/tmp/gostork-server.log`
