# Working rules for agent sessions in this checkout

These rules are standing owner orders. Every agent session must obey them
before changing anything, and the landing flow below already encodes them so
the rules are checked by the machine, not by memory.

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
