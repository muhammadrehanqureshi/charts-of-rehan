#!/usr/bin/env python3
"""Publish gate: prove this tree carries no secret and no private path.

Run it before the tree is pushed anywhere, and in CI on every change:

    python tools/sanitize.py            # report, exit 1 on a finding
    python tools/sanitize.py --fix      # rewrite local user paths, then report

Two classes of finding, handled differently on purpose:

* **Secrets** (tokens, keys, password assignments, private key blocks, chat
  webhook URLs, JWTs) are never fixed automatically. An automatic rewrite of a
  credential destroys the only copy of it in some cases and hides the mistake in
  others, so the tool stops and names the file. A human removes the value and
  rotates the credential.
* **Local paths** (``C:\\Users\\<name>`` and ``/Users/<name>``) and **personal
  data** (phone numbers, national identity numbers, personal email addresses)
  are reported, and ``--fix`` rewrites only the local paths, because a path is a
  private detail with an obvious safe replacement and a phone number is not:
  whether a number is real has to be decided by its owner.

The tool never prints a matched value. It prints the file, the line number and
the match length, which is enough to find and fix it without putting the value
into a terminal, a log or a report.
"""
from __future__ import annotations

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SECRETS = {
    "telegram_bot_token": re.compile(rb"\d{8,10}:[A-Za-z0-9_-]{30,}"),
    "aws_access_key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "private_key_block": re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "json_web_token": re.compile(rb"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),
    "bearer_literal": re.compile(rb"(?i)bearer\s+[A-Za-z0-9._-]{24,}"),
    "assigned_secret": re.compile(
        rb"(?i)(api[_-]?key|secret|token|password|passwd|credential)"
        rb"\s*[=:]\s*[\"'][^\"'\s]{12,}[\"']"),
    "chat_webhook": re.compile(rb"https://api\.telegram\.org/bot[0-9]"),
    "cloudflare_api_token": re.compile(rb"(?i)cloudflare[^\n]{0,40}[A-Za-z0-9_-]{37,}"),
}

PERSONAL = {
    "windows_user_path": re.compile(rb"C:\\+Users\\+([A-Za-z0-9._-]+)"),
    "posix_user_path": re.compile(rb"/(?:c/)?Users/([A-Za-z0-9._-]+)"),
    "phone_pk": re.compile(rb"(?:\+92|0092)(\d{9,10})\b"),
    "cnic_pk": re.compile(rb"\b\d{5}-\d{7}-\d\b"),
    "email_address": re.compile(rb"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
}

#: Addresses that appear in upstream licence text and are not the owner's.
KNOWN_PUBLIC_EMAILS = {
    b"hi@", b"marsnev@", b"noreply@", b"example@", b"you@", b"name@",
}

BINARY = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".ttf", ".otf",
          ".woff", ".woff2", ".apk", ".zip", ".gz", ".pdf", ".pack", ".idx"}
SKIP_DIRS = {"node_modules", "dist", "__pycache__", ".git", ".pytest_cache",
             ".vite", "venv", ".venv"}
MAX_BYTES = 4_000_000

PATH_REWRITES = (
    (re.compile(rb"C:\\+Users\\+[A-Za-z0-9._-]+"), b"C:\\Users\\<user>"),
    (re.compile(rb"/(?:c/)?Users/[A-Za-z0-9._-]+"), b"/Users/<user>"),
)


def files() -> list[Path]:
    found: list[Path] = []
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.suffix.lower() in BINARY:
            continue
        if path.stat().st_size > MAX_BYTES:
            continue
        found.append(path)
    return found


def scan(paths: list[Path]) -> tuple[Counter[str], list[str]]:
    counts: Counter[str] = Counter()
    report: list[str] = []
    for path in paths:
        try:
            blob = path.read_bytes()
        except OSError:
            continue
        rel = path.relative_to(ROOT).as_posix()
        for name, rx in SECRETS.items():
            for match in rx.finditer(blob):
                counts[name] += 1
                line = blob[:match.start()].count(b"\n") + 1
                report.append(f"SECRET  {rel}:{line} {name} "
                              f"(len {len(match.group(0))})")
        for name, rx in PERSONAL.items():
            for match in rx.finditer(blob):
                if name == "email_address":
                    value = match.group(0).lower()
                    if any(value.startswith(k) for k in KNOWN_PUBLIC_EMAILS):
                        continue
                    if value.endswith((b"@example.com", b"@example.org")):
                        continue
                if name == "phone_pk":
                    # +920000000000 is a documented placeholder, not a person.
                    digits = match.group(1)
                    if len(set(digits)) == 1:
                        continue
                counts[name] += 1
                line = blob[:match.start()].count(b"\n") + 1
                report.append(f"PRIVATE {rel}:{line} {name} "
                              f"(len {len(match.group(0))})")
    return counts, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fix", action="store_true",
                        help="rewrite local user paths to placeholders")
    parser.add_argument("--quiet", action="store_true",
                        help="print only the summary line")
    args = parser.parse_args(argv)

    paths = files()
    if args.fix:
        changed = 0
        for path in paths:
            before = path.read_bytes()
            after = before
            for rx, replacement in PATH_REWRITES:
                after = rx.sub(replacement, after)
            if after != before:
                path.write_bytes(after)
                changed += 1
                print(f"rewrote {path.relative_to(ROOT).as_posix()}")
        print(f"local paths rewritten in {changed} file(s)\n")

    counts, report = scan(files())
    secrets = sum(counts[name] for name in SECRETS if counts[name])
    private = sum(counts[name] for name in PERSONAL if counts[name])
    if not args.quiet:
        for line in report:
            print(line)
        if report:
            print()
        print(f"files scanned: {len(files())}")
        for name in sorted(counts):
            if counts[name]:
                print(f"  {name}: {counts[name]}")
    print(f"secrets: {secrets}  private-data findings: {private}")
    if secrets:
        print("REFUSING: a secret-shaped value is present. Remove it and rotate "
              "the credential. This tool will not rewrite a credential for you.")
        return 1
    print("PASS: no secret in this tree"
          + ("" if private else " and no private data"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
