# RHODES · LAN-3.2 · PHASE 1 (v2) — safe Windows transfer instructions

Target: **LAN-3.1 baseline `bbb51a7`**. This procedure copies 25 files into a working tree.
It deletes nothing, stages nothing, commits nothing, and touches nothing outside `server/`.

Windows 10/11 or Windows Server, PowerShell 5.1. Every command is review-only: it reads
hashes and copies files. Nothing here creates a service, edits the registry, touches
ACLs/firewall, or writes to `C:\ProgramData\RHODES`.

---

## 0 · What you are receiving

```
RHODES-LAN-3.2-PHASE1-TRANSFER/            (v2)
├── MANIFEST.md                          ← 25 files, ADD/REPLACE, per-file sha256, what changed in v2
├── SHA256SUMS                           ← checksums for every artefact
├── TRANSFER.md                          ← this file
├── RHODES-LAN-3.2-PHASE1-REVIEW.patch   ← complete contents of the same 25 files (reading copy)
└── files/                               ← the 25 files, relative paths preserved
    ├── server/ARCHITECTURE.md
    ├── server/src/{shutdown.ts, serviceMode.ts, db/index.ts, server.ts, startup.ts, index.ts, config.ts, logger.ts}
    └── server/test/{…, startup-cleanup.test.ts, fixtures/…}
```

**11 files are additions, 14 are replacements.** Nothing else changes.

---

## 1 · Unpack and verify before anything touches the repository

```powershell
# 1. Unpack to a scratch area, never into the repository
Expand-Archive -LiteralPath .\RHODES-LAN-3.2-PHASE1-TRANSFER.zip -DestinationPath $env:TEMP\rhodes-xfer -Force
Set-Location $env:TEMP\rhodes-xfer\RHODES-LAN-3.2-PHASE1-TRANSFER

# 2. Verify every artefact against SHA256SUMS (expect OK on every line)
Get-Content .\SHA256SUMS | ForEach-Object {
  if ($_ -match '^([0-9a-f]{64})  (.+)$') {
    $expected = $Matches[1]; $file = $Matches[2] -replace '/', '\'
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLower()
    "{0}  {1}" -f $(if ($actual -eq $expected) { 'OK  ' } else { 'FAIL' }), $file
  }
}
```

Every line must read `OK`. The manifest also states one aggregate digest for the whole file
set (`fileset digest`); compute it as the SHA-256 of the sorted `"<hash>  <path>"` lines if you
want a single value to record in the change ticket.

---

## 2 · Confirm the baseline and the classification

```powershell
Set-Location C:\path\to\rhodes-meeting-assistant
git rev-parse --short HEAD          # must print bbb51a7
git status --porcelain              # must be empty; if not, stop and resolve first

# For each manifest row: ADD means the path must be absent at bbb51a7, REPLACE means present.
Select-String -Path $env:TEMP\rhodes-xfer\RHODES-LAN-3.2-PHASE1-TRANSFER\MANIFEST.md `
              -Pattern '^\| \d+ \| `([^`]+)` \| \*\*(ADD|REPLACE)\*\*' | ForEach-Object {
  $path = $_.Matches[0].Groups[1].Value
  $claim = $_.Matches[0].Groups[2].Value
  git cat-file -e "bbb51a7:$path" 2>$null
  $actual = if ($LASTEXITCODE -eq 0) { 'REPLACE' } else { 'ADD' }
  "{0}  expected {1,-7} found {2,-7} {3}" -f $(if ($actual -eq $claim) { 'OK  ' } else { 'FAIL' }), $claim, $actual, $path
}
```

**Any `FAIL` is a stop condition** — it means the tree is not the baseline this package was
built against.

---

## 3 · Rollback point (no stash, no commit)

```powershell
git archive -o "$env:TEMP\rhodes-bbb51a7-server.zip" bbb51a7 server/
```

Rollback after a bad copy, without touching the index:

```powershell
git checkout -- server/            # restores the 14 replaced files
Remove-Item server\src\shutdown.ts, server\src\serviceMode.ts,
            server\test\db-close.test.ts, server\test\shutdown.test.ts,
            server\test\service-mode.test.ts, server\test\config-production-tls.test.ts,
            server\test\service-process.test.ts, server\test\logging-sink.test.ts,
            server\test\startup-cleanup.test.ts,
            server\test\fixtures\crash-child.ts, server\test\fixtures\log-probe.ts
```

---

## 4 · Copy

```powershell
Set-Location C:\path\to\rhodes-meeting-assistant
$src = "$env:TEMP\rhodes-xfer\RHODES-LAN-3.2-PHASE1-TRANSFER\files"
Copy-Item -Path "$src\*" -Destination . -Recurse -Force
```

This creates the 11 new paths and overwrites the 14 existing ones. It deletes nothing and
touches no other file.

---

## 5 · Verify what landed

```powershell
git status --porcelain -uall -- server/     # exactly 14 " M" and 11 "??"
git diff --stat -- server/                  # 14 files changed, 0 deletions of whole files

# Byte-identity spot-check (should be silent if identical):
$check = @('server/src/startup.ts','server/src/db/index.ts','server/test/shutdown.test.ts')
foreach ($f in $check) {
  Compare-Object (Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash `
                 (Get-FileHash -Algorithm SHA256 -LiteralPath "$src\$($f -replace '/','\')").Hash
}
```

For all 25, compare against the `sha256` column in `MANIFEST.md`.

---

## 6 · Accept or reject on evidence

```powershell
Set-Location server
npm ci
npm run typecheck      # expect: no output, exit 0
npm test               # expect: # tests 232  # pass 232  # fail 0  # skipped 0
npm run build          # expect: exit 0, migrations copied to dist/
```

Expected: **232 declared = 232 reported = 232 passed, 0 failed, 0 skipped**, clean typecheck,
successful production build.

> Reference environment for those numbers: Windows-independent Node layer — Node v22.22.3,
> npm 10.9.8, better-sqlite3 13.1.1 (shipped N-API prebuild, ABI 127), verified on Linux x64.
> A Windows run must reproduce them; that is part of the Windows acceptance pass, not
> something this package claims.

---

## 7 · Rules for this transfer

- No `git add`, `git commit`, `git push`, `git reset`, `git stash`, no branch switching.
- No deletion of any file, including the pre-existing review artefacts
  (`RHODES-LAN-1.1-REVIEW.patch`, `RHODES-LAN-1.1a-REVIEW.patch`,
  `RHODES-LAN-1.1a-PORTABILITY-REVIEW.patch`, `RHODES-LAN-2-REVIEW.patch`,
  `RHODES-LAN-2.1-REVIEW.patch`, `RHODES-LAN-2.1a-REVIEW.patch`).
- No change to `package.json`, `package-lock.json`, migrations, the production database or
  its location, ACLs, the registry, the firewall, service configuration, or the visual UI.
- No Windows service host and no installer — that work is not part of this package.
