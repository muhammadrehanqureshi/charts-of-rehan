# Working rules for agent sessions in this checkout

These rules are standing owner orders. Every agent session must obey them
before changing anything, and the landing flow below already encodes them so
the rules are checked by the machine, not by memory.

**The owner's PC is the production host.** Lightweight is a release gate,
not a tuning preference. If a change cannot fit the machine budget in rule 6,
it does not ship.

1. Everything goes through a pull request. `scripts/land.sh` is the only path
   to master: feature branch, guarded repository identity, CI green, merge,
   branch deleted. Nobody writes to master directly, no exceptions.
2. The agent is the contributor. The flow hardcodes
   `Co-Authored-By: Codebuff <noreply@codebuff.com>` on every commit, every PR
   body and every merge commit, so the record shows who did the work.
3. Never idle and never sleep while working. A step that must wait (CI, a
   service boot) waits through the flow's own blocking mechanism
   (`gh pr checks --watch` or land.sh's internal wait) while useful work
   continues in parallel; issuing bare `sleep` re-check loops is forbidden.
   If nothing useful can be done in parallel, gather verification that does
   not depend on the wait (read logs, run the local gates) instead of sleeping.
4. The owner is never handed manual steps. Run the launcher, the restart and
   the verification yourself with real tool calls; a message that says "close
   that window and run X" is a failure to comply. The single legitimate ask is
   opening `start-charts.cmd` from the Desktop shortcut when the console that
   owns the service was genuinely closed.
5. Verify before claiming. Tests, typecheck, health endpoints and HTTP answers
   before any "done" is spoken; a green exit code alone is not verification.
6. **Never hammer the owner's PC; lightweight is a release gate.** Charts of
   Rehan is a guest on the same machine the owner is working on. This rule
   outranks convenience, live-feel and feature scope. It is the standing
   system instruction for every agent session in this checkout.
   - One foreground service plus the existing recorder. No extra daemon,
     worker, schedule, watcher, autostart entry or duplicate service; a second
     click reuses the running listener.
   - Every repeating job is visibility-gated and has a stop condition. On hide
     or unmount, cancel the timer or stream. Schedule the next request only
     after the previous answer completes; never overlap requests.
   - While the tab is visible, the open chart stream may tick at most once per
     second. Ancillary polls are at least 5 seconds; catalogue and health polls
     are at least 10 seconds; source polling defaults to 15 seconds with a
     5-second floor; EOD maintenance runs every 15 minutes. These are rate
     ceilings, not targets. Do not preload the universe; fetch only the open
     symbol, the two indices and what a visible panel actually shows.
   - Cache heavy reads by capture identity; use bounded queues and bounded
     caches; do not re-walk a whole capture per request or hold the whole
     market in memory.
   - Agents must not start duplicate servers, run broad or full local suites
     when CI is about to run them, repeat verification on unchanged files, or
     issue short-interval re-check loops. Use one focused check for the changed
     code; CI owns the full suite. No screenshots or browser tours unless asked.
   - If a feature cannot fit this budget, stop and report the constraint. Do
     not ship it and do not trade the owner's machine for a demo.
