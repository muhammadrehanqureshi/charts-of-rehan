# Licence and asset position

This project is proprietary (see LICENSE). This standalone public source tree
contains no font binaries. Market recordings and archived sessions are local
runtime data and are excluded from publication; do not redistribute them without
written permission from the relevant data provider. This release's archive
content is intentionally omitted.

## The typefaces

| Asset | Source | Terms | Where it is used |
|---|---|---|---|
| Bonskin | personal download | "free for personal use"; commercial use requires a purchase | the brand line |
| LEMON MILK Bold and Light | donationware | free for personal use; commercial use asks for a donation | labels, buttons, the status badge, card values and captions |
| Great Vibes | SIL Open Font License | redistributable under the OFL | decorative text |

The two personal-use faces were found in the parent project's Android assets;
this standalone Charts export contains no Android app, font files, or references
to those font files. They are not part of this public repository.

No standalone Android package or APK is produced here. Do not copy restricted
font binaries or Android assets into this repository.

The Charts front end uses system fonts. The independent Android app's asset
licences are outside this standalone release and are not cleared by this file.

## Source code

All Python and TypeScript in this tree is the owner's own work. It vendors
fourteen modules from the parent project (`src/`), which are the owner's own code
under the same licence, with hashes recorded in PROVENANCE.md.

## Front end dependencies

`web/package.json` lists React, React DOM, Vite, Vitest and TypeScript, all under
permissive licences (MIT for React, Vite, Vitest and TypeScript; React DOM
likewise). `web/package-lock.json` pins them, and no dependency is vendored into
this repository.

## Market data

Market data is not licensed for redistribution by this repository. Personal
recordings and archived sessions stay outside GitHub, are excluded by
`.gitignore`, and must be stored in a private data location. Anyone running this
service must obtain and retain data under their own agreement with their venue.
