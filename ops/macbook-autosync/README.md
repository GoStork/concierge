# MacBook auto-sync

Versioned copy of what runs on the MacBook. Installed as:

    ~/.gostork/auto-sync.sh                        <- auto-sync.sh
    ~/Library/LaunchAgents/com.gostork.autosync.plist

Was unversioned until 2026-08-25, which is exactly how the two dev boxes
drifted apart without anyone noticing.

## Install it atomically

    cp auto-sync.sh ~/.gostork/auto-sync.sh.new && mv ~/.gostork/auto-sync.sh.new ~/.gostork/auto-sync.sh

Use `mv`, never a plain `cp` over the live file. The LaunchAgent fires every 60
seconds, so a straight overwrite has a good chance of landing while bash is
mid-execution - and bash reads a script incrementally by byte offset, so it
resumes at whatever now sits at that offset. Doing exactly that on 2026-08-25
produced:

    ~/.gostork/auto-sync.sh: line 23: om.gostork.nightly-sync: command not found

which is bash resuming into the middle of a comment line in the new file. One
cycle, harmless here, but the same trick on a script that *does* something
destructive mid-file would not be. `mv` swaps the inode; anything already
running keeps reading the old one to completion.

## This is NOT the iMac's mechanism

`ops/imac-nightly-sync/` is a different design. Do not install one over the
other - a well-meant "just point REPO at the other path" swap breaks both:

| | MacBook (here) | iMac |
|---|---|---|
| who pulls | this script, with `--autostash` | the server daemon, inside `run-server.sh` |
| when it restarts | only after a pull that **moved HEAD** | whenever `local != remote` |
| launchd target | `gui/<uid>/com.gostork.server` (user agent) | `system/com.gostork.nightly-sync` (root daemon) |
| repo path | `GS_REPO_DIR` from the plist (required) | `$HOME/GitHub-iMac/concierge` |

`system/com.gostork.nightly-sync` **does not exist on the MacBook**. Installing
the iMac script here would make every kickstart a silent no-op and stop
auto-deploy entirely, while still looking healthy in the log.

## Why the MacBook never had the iMac's restart storm

The iMac kickstarted the daemon on every cycle where `local != remote` and let
the daemon do the pull. When that pull could not succeed, nothing advanced HEAD,
the condition stayed true, and it restarted every 60s - 8,772 times over six
days. The MacBook only kickstarts *after* its own pull succeeds, and it pulls
with `--autostash`, which survives the dirty-tree case that wedged the iMac.

It did share the other half of the bug though: **silent staleness**. A pull that
fails every cycle logged one identical line a minute forever. Hence the cap.

## Failure behaviour (verified 2026-08-25 against a throwaway repo)

Attempts are counted per remote SHA, so every new push starts fresh.

- attempts 1-5: pull, and on failure log `PULL FAILED` plus `git status --porcelain`
- attempts 6-29: silent, to avoid flooding the log
- every 30th attempt: log `WEDGED ... running STALE CODE` with the diagnostic
  commands, **and retry** - so fixing the tree self-heals within ~30 minutes
  rather than requiring you to know a state file exists
- a pull that exits 0 without moving HEAD counts as a failure (`PULL FAILED
  SILENTLY`) instead of resetting the counter, which would recreate the bug

State lives in `~/.gostork/autosync-state` and is deleted the moment the box is
in sync.
