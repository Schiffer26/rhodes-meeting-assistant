# RHODES · LAN-3.2 · PHASE 1 — transfer manifest (**v2**, source-review corrections)

**Package:** `RHODES-LAN-3.2-PHASE1-TRANSFER` v2 · 2026-11-08
**Contents:** exactly **25** files under `files/`, relative paths preserved.
**Target baseline:** LAN-3.1 commit `bbb51a7`.
**Supersedes:** v1 of this package. Keep v1 only if you need the pre-correction state for
comparison; v1 lacks the shutdown-verdict fix, the startup-cleanup fix and their tests.

## What changed in v2

| finding | file | change |
| --- | --- | --- |
| 1 · shutdown verdict | `server/src/startup.ts` | `ShutdownResult.ok` is now `listenerClosed && CloseResult.ok`. `checkpointed` and `databaseClosed` remain separate factual fields. A close that reported an error after the handle closed (checkpointed true, closed true, CloseResult.ok false) now fails the shutdown and exits 69. |
| 2 · regression test | `server/test/shutdown.test.ts` | new test: a CloseResult with checkpointed true, closed true, ok false and an error ⇒ `Runtime.shutdown().ok === false`, and `performShutdown()` returns 69 for a requested clean stop. |
| 3 · startup cleanup | `server/src/startup.ts` | one boot sequence: a failure after the database opens closes it; a failure after the listener is bound closes the listener and then the database; the original error is rethrown and the tidying is recorded in `service.startup_cleanup`. `createApp`/`startServer` are injectable for tests only. |
| 3 · tests | `server/test/startup-cleanup.test.ts` (new) | createApp failure, post-listening failure, and a real `EADDRINUSE` bind failure. |
| docs | `server/ARCHITECTURE.md` | §10.1 states the new `ok` derivation, the 69 case, and startup cleanup. |

## Provenance

| item | value |
| --- | --- |
| source branch | `arena/3852a45f-rhodes-meeting-assistant` |
| source HEAD | `ad48893f5a33f95eeff0a56f97649c13e8f90c65` (uncommitted working tree; nothing staged) |
| suite at source | **232 declared / 232 passed / 0 failed / 0 skipped** |
| typecheck / build | 0 errors / success |
| fileset digest | sha256 over every `<sha256>  <path>` line, sorted by path: **`e6b87112ae785916c6ba87f1943d223ae633557885a91a83bff559db89bf7e96`** |

`bbb51a7` is not present in the sandbox that produced this package, so ADD/REPLACE below comes from
the Phase 1 change inventory, not from a tree diff against that commit. `TRANSFER.md` §3 gives the
command that confirms every row on the receiving machine **before** anything is copied.

## 1 · Files to **add** (11)

| # | relative path | action | bytes | lines | sha256 |
| --- | --- | --- | ---: | ---: | --- |
| 1 | `server/src/shutdown.ts` | **ADD** | 3745 | 111 | `607558cde07b94dc6a5e74de0a8ab7b96582641b70a225db2b9397be825dbbe2` |
| 2 | `server/src/serviceMode.ts` | **ADD** | 8482 | 244 | `11a8d088ecc9c4f0ec9012f88291e866c74a4e37eeb7a0f0ed827575b6ee190d` |
| 3 | `server/test/db-close.test.ts` | **ADD** | 14151 | 388 | `eb67295f630d9e1ef214bc6396637a778a2acbd5460a246a89692134958ae084` |
| 4 | `server/test/shutdown.test.ts` | **ADD** | 11665 | 346 | `092459064d64fd760bd61021526865f4e672d08317fa7d503bcaaea0caebd165` |
| 5 | `server/test/service-mode.test.ts` | **ADD** | 11615 | 359 | `6eb08b12380667e882051798567a4d43d9e49465dd1bbf70c8fbb69523467b47` |
| 6 | `server/test/config-production-tls.test.ts` | **ADD** | 5846 | 174 | `98a84e3ef3baa9000d7f64827df48b6f4a4b5095acd932af46964edd41ce5a26` |
| 7 | `server/test/service-process.test.ts` | **ADD** | 9032 | 253 | `e51daab49c27ebf211f915c066f4c9209368ccf9b20311234d3fa48f5d0a7776` |
| 8 | `server/test/logging-sink.test.ts` | **ADD** | 4449 | 127 | `48ff7a886cfcf3dcad9f5d838302df4e6e0d6e0402f342904f55f0d5daa89099` |
| 9 | `server/test/startup-cleanup.test.ts` | **ADD** | 5181 | 152 | `0b0502af48cc5b4de35f709a2243efef8880f00810c0476206e1ab963c8d101b` |
| 10 | `server/test/fixtures/crash-child.ts` | **ADD** | 1273 | 33 | `e92cd8673951b5d3b6259260cc1d16a36876dad94b9728a0a9f441ffdd7774b2` |
| 11 | `server/test/fixtures/log-probe.ts` | **ADD** | 599 | 16 | `c298405ec765012c423e09ac08069e6ef60ee4aa77b4fc8daea9e0797b87838d` |

## 2 · Files to **replace** (14)

| # | relative path | action | bytes | lines | sha256 |
| --- | --- | --- | ---: | ---: | --- |
| 1 | `server/src/db/index.ts` | **REPLACE** | 16113 | 416 | `7f4d53014d95841d28f29217d761fb90e0465dd50076989a2ec0b84b55233c55` |
| 2 | `server/src/server.ts` | **REPLACE** | 7086 | 182 | `5f0108ef76a5c8235850e88b09cb5e2bc95595555018444e9a995c3108e061b1` |
| 3 | `server/src/startup.ts` | **REPLACE** | 10612 | 271 | `6241593c225856bbc586685a456c785b5d8616abf67591bd6f3bbb092976bdd0` |
| 4 | `server/src/index.ts` | **REPLACE** | 3513 | 86 | `8ad1f16c3161fc521832a02ec1ccf0e27916fe0b10744e396c0992637e22ae61` |
| 5 | `server/src/config.ts` | **REPLACE** | 20842 | 509 | `ad4d880e331bbc9fb292b37c0892d91aa423010862c7061fbe710e94549a20b1` |
| 6 | `server/src/logger.ts` | **REPLACE** | 2858 | 84 | `d21ab14599f1cd3c99a689d209e0b98a308735aa325883fdaa9a5b7ee665b00e` |
| 7 | `server/ARCHITECTURE.md` | **REPLACE** | 69844 | 1110 | `781b7414c91bb43f39154d336159eae576da4a3b391167e7c7a8b1b288290b09` |
| 8 | `server/test/helpers.ts` | **REPLACE** | 7905 | 209 | `09ec28eb0ce250dfa8e009a31d47ebabdda6c1e84c8c1e8ff3f78811527237eb` |
| 9 | `server/test/config.test.ts` | **REPLACE** | 20408 | 495 | `279b674c44b8c56f137205da8f3ce49047573b97724ae1ee1f4851ae611e3d40` |
| 10 | `server/test/health.test.ts` | **REPLACE** | 7293 | 225 | `8439c45a47435e77f8c3d1507dd7ea885b765bfe89c2d6b7adabec77e855f6bf` |
| 11 | `server/test/auth-login.test.ts` | **REPLACE** | 21646 | 488 | `e40993ed4792c59ca38892397da1cad02d459f954cca31314ffe47a4c50de17c` |
| 12 | `server/test/auth-secrets.test.ts` | **REPLACE** | 11507 | 298 | `228dadfbd82070ced736ae066efc9548e2345b743133e22c7959fbac984c86ca` |
| 13 | `server/test/authz.test.ts` | **REPLACE** | 19291 | 424 | `cdc66c5ae95475ae8e676caa23c2d53da3f758cc2f11334023dc7cfd7c27b20b` |
| 14 | `server/test/tls-transport.test.ts` | **REPLACE** | 12177 | 338 | `02ba431919894d6afc29bdde8878270e25ba9f625381af82f1fd3fcfee910f26` |

## 3 · Deliberately not shipped

`server/package.json`, `server/package-lock.json`, `server/tsconfig*.json`, `server/scripts/*`,
`server/src/db/migrations/*.sql`, and everything outside `server/`. No dependency changed; no
migration changed; the production database path is untouched.

## 4 · Integrity

`SHA256SUMS` covers every artefact (`files/…`, the review patch, this manifest, `TRANSFER.md`).
Verify with `sha256sum -c SHA256SUMS` (Linux/macOS) or the `Get-FileHash` loop in `TRANSFER.md` §2.
