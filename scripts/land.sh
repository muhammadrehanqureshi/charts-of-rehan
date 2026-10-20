#!/usr/bin/env bash
# land.sh: stage, commit, sync, validate, and land one local change on master
# through a pull request, with the repository identity checked before anything
# is staged or published.
#
# The flow is deliberately the same as quant-of-rehan's: one path to master,
# a hardcoded co-author line, a rebase onto the latest base branch, and a
# publish phase that opens and merges a pull request with gh. It never writes
# to master directly.
#
# The guard that matters here is the first one: this checkout declares its
# repository in .repo-identity, and origin must name the same repository.
# Running a copy of this script from the other project tree is how a change
# lands in the wrong public repository, so that mismatch aborts before the
# commit phase.
#
# Phases: commit, sync, validate, publish (the default runs all four)
#   commit   stage and commit everything (or only the paths after --)
#   sync     fetch origin, rebase the branch onto the latest base branch
#   validate skipped by default (validation runs in the PR's CI);
#            --local-checks runs the sanitize gate and the Python suite here
#   publish  push, open or reuse the PR, wait for CI, merge, resync master
#
# Usage examples:
#   scripts/land.sh -m "Fix the capture mirror fallthrough"
#   scripts/land.sh -y -m "Docs: explain the landing flow" -- docs/landing.md
#   scripts/land.sh --dry-run -m "Preview what would be staged"
#   scripts/land.sh -m "Stop after local checks" --until validate
#
# A rerun after a conflict is safe: if the work is already committed, the
# commit phase is skipped and the script continues from the sync step, so a
# hand-resolved rebase can be finished with one more land.sh run.
#
# Exit codes: 0 success, 1 aborted (conflict, failed check, refused state)
set -Eeuo pipefail

BASE="master"
MESSAGE=""
PATHS=()
ASSUME_YES=0
DRY_RUN=0
LOCAL_CHECKS=0
UNTIL="publish"
DELETE_BRANCH=0

OWNER_NAME="Mr. Rehan"
OWNER_EMAIL="muhammadrehanqureshi@users.noreply.github.com"
OWNER_EMAIL_ALT="111383512+muhammadrehanqureshi@users.noreply.github.com"

# The agent is the owner's co-author on every commit, every PR body and every
# merge. Written once here so the commit, the pull request and the merge commit
# cannot drift apart.
COAUTHOR="Co-Authored-By: Codebuff <noreply@codebuff.com>"

now_pkt() { date -u -d "+5 hours" "+%Y-%m-%d %H:%M:%S PKT"; }
step()    { printf "\n== %s ==\n" "$*"; }
note()    { printf "   %s\n" "$*"; }
warn()    { printf "   ! %s\n" "$*"; }
die()     { printf "\nABORT: %s\n" "$*" >&2; exit 1; }

on_err() {
    local code=$?
    printf "\nland.sh stopped early (exit %s). Nothing was merged unless a step above said so.\n" "$code" >&2
    exit "$code"
}
trap on_err ERR

usage() {
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

# ---------------------------------------------------------------- arguments
while (( $# )); do
    case "$1" in
        -m|--message)    MESSAGE="${2:-}"; shift 2 ;;
        -b|--base)       BASE="${2:-}"; shift 2 ;;
        -y|--yes)        ASSUME_YES=1; shift ;;
        -n|--dry-run)    DRY_RUN=1; shift ;;
        --local-checks)  LOCAL_CHECKS=1; shift ;;
        --until)         UNTIL="${2:-}"; shift 2 ;;
        --delete-branch) DELETE_BRANCH=1; shift ;;
        -h|--help)       usage; exit 0 ;;
        --)              shift; PATHS=("$@"); break ;;
        *)               die "unknown argument: $1 (try --help)" ;;
    esac
done

case "$UNTIL" in
    commit|sync|validate|publish) ;;
    *) die "--until must be one of: commit, sync, validate, publish" ;;
esac

# ---------------------------------------------------------------- preflight
step "0/4 preflight ($(now_pkt))"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a git repository"
cd "$ROOT"
note "repository: $ROOT"

if [[ -n "$(git ls-files -u)" ]]; then
    die "the index has unresolved conflicts; finish or abort that merge first"
fi

BRANCH=$(git symbolic-ref --short -q HEAD) || die "detached HEAD: check out a feature branch first"
[[ "$BRANCH" != "$BASE" ]] || die "refusing to land on $BASE itself (every change is a pull request)"
git remote get-url origin >/dev/null 2>&1 || die "remote 'origin' is not configured"

if command -v python >/dev/null 2>&1; then
    PYTHON=python
elif command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
else
    die "python is required for the repository identity check"
fi

IDENTITY_FILE="$ROOT/.repo-identity"
[[ -f "$IDENTITY_FILE" ]] || die "no .repo-identity in this checkout: the landing flow refuses to guess which repository it is publishing to"
EXPECTED_REPO=$(tr -d "[:space:]" < "$IDENTITY_FILE")
[[ -n "$EXPECTED_REPO" ]] || die ".repo-identity is empty"
[[ -f scripts/repo_identity.py ]] || die "scripts/repo_identity.py is missing; cannot verify the repository identity"

# The helper parses an https URL, an scp style remote and a Windows local path
# the same way, so the comparison never has to guess.
origin_url=$(git remote get-url origin)
actual_repo=$("$PYTHON" scripts/repo_identity.py "$origin_url")
[[ "$actual_repo" == "$EXPECTED_REPO" ]] || die "origin points at repository '$actual_repo' but this checkout declares '$EXPECTED_REPO'; refusing to land into the wrong repository"
note "repository identity: $EXPECTED_REPO (origin agrees)"
note "branch: $BRANCH  ->  base: $BASE"

got_name=$(git config user.name || true)
got_email=$(git config user.email || true)
if [[ "$got_name" != "$OWNER_NAME" ]] || { [[ "$got_email" != "$OWNER_EMAIL" ]] && [[ "$got_email" != "$OWNER_EMAIL_ALT" ]]; }; then
    warn "git identity is '$got_name <$got_email>'"
    die "the landing flow requires the owner identity. Fix once with:
     git config user.name \"$OWNER_NAME\"
     git config user.email \"$OWNER_EMAIL\""
fi
note "author identity ok"

[[ -n "$MESSAGE" ]] || die "a commit message is required: -m \"...\" (the flow appends the co-author line itself)"

validate_message() {
    "$PYTHON" - "$1" <<'PY' || die "commit message rejected by the landing message validator"
import sys
msg = sys.argv[1]
if not msg.strip():
    print("message is empty", file=sys.stderr)
    sys.exit(1)
first = msg.strip().splitlines()[0].strip()
if len(first) < 8:
    print(f"first line is too short to be a useful subject: {first!r}", file=sys.stderr)
    sys.exit(1)
banned = "\u2014\u2013\u2012\u2015\u2e3a\u2e3b"
for ch in msg:
    if ch in banned:
        print(f"banned dash character U+{ord(ch):04X} in the message", file=sys.stderr)
        sys.exit(1)
if "co-authored-by:" in msg.lower():
    print("the co-author line is appended by land.sh itself; leave it out of -m",
          file=sys.stderr)
    sys.exit(1)
for trailer in ("generated with", "generated-by:", "signed-off-by:"):
    if trailer in msg.lower():
        print(f"banned trailer pattern {trailer!r} in the message", file=sys.stderr)
        sys.exit(1)
print("   message passes the style rules; land.sh appends the co-author line")
PY
}
validate_message "$MESSAGE"

# The message the commit, the pull request and the merge all carry. The
# caller's words first, then the co-author line as the last line.
FULL_MESSAGE=$(printf '%s\n\n%s\n' "$MESSAGE" "$COAUTHOR")

note "base commit: $(git rev-parse --short "origin/$BASE" 2>/dev/null || echo 'origin/'$BASE' not fetched yet')"

if (( DRY_RUN )); then
    step "dry run: nothing will be staged, committed, pushed, or merged"
    note "would stage:"; git status --short | sed "s/^/     /"
    note "with message: $(printf "%s" "$MESSAGE" | head -n1)"
    note "phases: commit -> sync -> validate -> publish (until: $UNTIL)"
    note "run without --dry-run to execute"
    exit 0
fi

# ------------------------------------------------------------- 1/4 commit
step "1/4 commit"
if (( ${#PATHS[@]} )); then
    note "staging only the given paths"
    git add -- "${PATHS[@]}"
else
    note "staging every change under the repository (respects .gitignore)"
    git add -A
fi
git status --short | sed "s/^/     /"
if git diff --cached --quiet; then
    # The resume path, for example after a rebase conflict was resolved by
    # hand: the work is already committed, so this phase is a no-op instead of
    # an error, and the run continues from the sync step.
    ahead=$(git rev-list --count "origin/$BASE..HEAD" 2>/dev/null || echo 0)
    (( ahead > 0 )) || die "nothing to commit and no commits ahead of origin/$BASE: there is nothing to land"
    note "nothing new to commit; continuing with the $ahead commit(s) already ahead of origin/$BASE"
else
    if (( ! ASSUME_YES )); then
        [[ -t 0 ]] || die "no terminal for confirmation; pass --yes to accept the staged set"
        read -r -p "   commit these changes as '$OWNER_NAME'? [y/N] " answer
        [[ "$answer" == [Yy] ]] || die "declined at the confirmation prompt"
    fi
    git commit -m "$FULL_MESSAGE"
    note "commit: $(git log --oneline -1)"
    note "co-author line: $COAUTHOR"
fi
if [[ "$UNTIL" == "commit" ]]; then
    printf "\nStopping after the commit phase (--until commit). Nothing was pushed.\n"
    exit 0
fi

# --------------------------------------------------------------- 2/4 sync
step "2/4 sync with origin/$BASE"
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    die "the working tree is not clean after the commit phase. Keep unrelated work out of this landing and use a clean worktree"
fi
git fetch origin --prune
note "rebasing $BRANCH onto origin/$BASE"
if ! git rebase "origin/$BASE"; then
    git rebase --abort 2>/dev/null || true
    die "rebase conflict against origin/$BASE. Resolve it by hand (fix the files, git add them, git rebase --continue), then rerun land.sh: the work is already committed, so it skips the commit phase and continues. The rebase was aborted; your branch is unchanged."
fi
note "branch is now on top of $(git rev-parse --short "origin/$BASE")"
note "commits to land:"; git log --oneline "origin/$BASE..HEAD" | sed "s/^/     /"
if [[ "$UNTIL" == "sync" ]]; then
    printf "\nStopping after the sync phase (--until sync). Nothing was pushed.\n"
    exit 0
fi

# ----------------------------------------------------------- 3/4 validate
# The owner's machine is not used for validation. The pull request's CI runs
# the sanitize gate, the Python suite and the web checks, so the default here
# spends none of the owner's CPU on work the cloud is about to repeat.
if (( LOCAL_CHECKS )); then
    step "3/4 validate locally (--local-checks)"
    if [[ -f tools/sanitize.py ]]; then
        "$PYTHON" tools/sanitize.py
        note "sanitize: passed"
    else
        warn "tools/sanitize.py is missing; the publish gate runs in CI only"
    fi
    "$PYTHON" -m unittest discover -s tests
    note "tests: passed"
    if [[ -f examples/charts_demo.py ]]; then
        "$PYTHON" examples/charts_demo.py >/dev/null
        note "offline demo: passed"
    fi
    if [[ -f web/package.json ]]; then
        if command -v npm >/dev/null 2>&1; then
            ( cd web && npm run typecheck && npm test --silent )
            note "web typecheck and tests: passed"
        else
            warn "npm is not installed here; the web checks run in CI only"
        fi
    fi
else
    step "3/4 validate (skipped, CI-first)"
    note "the sanitize gate, the Python suite and the web checks run in the PR's CI"
    note "add --local-checks only when the owner asks for a local run"
fi
if [[ "$UNTIL" == "validate" ]]; then
    printf "\nStopping after the validate phase (--until validate). Nothing was pushed.\n"
    exit 0
fi

# ------------------------------------------------------------ 4/4 publish
step "4/4 publish"
command -v gh >/dev/null 2>&1 || die "gh is required to open and merge the pull request"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"

# gh resolves a repository from the checkout, GH_REPO, or its own defaults.
# The origin guard above cannot see GH_REPO, so ask gh which repository it is
# actually pointed at before it can create a pull request somewhere else.
gh_repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null) || die "gh cannot name the repository it is pointed at; refusing to publish"
[[ "${gh_repo##*/}" == "$EXPECTED_REPO" ]] || die "gh is pointed at repository '$gh_repo' but this checkout declares '$EXPECTED_REPO'; refusing to open a pull request in the wrong repository"
note "gh target: $gh_repo"

git push -u origin HEAD
note "pushed $BRANCH"

TITLE=$(printf "%s" "$MESSAGE" | head -n1)
if pr=$(gh pr view --json number --jq .number 2>/dev/null); then
    note "reusing the open pull request #$pr"
else
    gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body "$FULL_MESSAGE" >/dev/null
    pr=$(gh pr view --json number --jq .number)
    note "opened pull request #$pr"
fi

step "waiting for CI checks on PR #$pr"
for _ in $(seq 1 18); do
    names=$(gh pr checks "$pr" --json name --jq ".[].name" 2>/dev/null || true)
    [[ -n "$names" ]] && break
    sleep 10
done
[[ -n "${names:-}" ]] || die "no CI checks appeared on PR #$pr after three minutes; refusing to merge unvalidated"
if ! gh pr checks "$pr" --watch --fail-fast; then
    gh pr checks "$pr" || true
    die "CI checks failed on PR #$pr; nothing was merged"
fi
note "all checks passed"

# GitHub computes mergeability asynchronously and often still answers UNKNOWN
# just after the checks turn green. That is not a failure, so this waits it out
# for up to three minutes rather than abandoning a pull request whose checks
# already passed.
mergeable=""
for attempt in $(seq 1 36); do
    mergeable=$(gh pr view "$pr" --json mergeable --jq .mergeable)
    [[ "$mergeable" != "UNKNOWN" ]] && break
    note "GitHub still reports UNKNOWN for PR #$pr (attempt $attempt of 36); waiting"
    sleep 5
done
[[ "${mergeable:-}" == "MERGEABLE" ]] || die "PR #$pr is not mergeable after three minutes (state: ${mergeable:-unknown}). A conflict means $BASE moved: rerun land.sh to resync."

merge_args=(--merge)
(( DELETE_BRANCH )) && merge_args+=(--delete-branch)
gh pr merge "$pr" "${merge_args[@]}" --body "$COAUTHOR"
note "merged PR #$pr into $BASE (merge commit carries the co-author line)"

merge_sha=$(gh pr view "$pr" --json mergeCommit --jq ".mergeCommit.oid" 2>/dev/null || true)
[[ -n "$merge_sha" ]] && note "merge commit: ${merge_sha:0:10}"

if git show-ref --verify --quiet "refs/heads/$BASE"; then
    git checkout "$BASE"
    git pull --ff-only origin "$BASE"
    note "local $BASE is up to date"
fi

step "landed"
note "PR #$pr: $TITLE"
note "phases completed: commit, sync, validate, publish"
note "finished $(now_pkt)"
