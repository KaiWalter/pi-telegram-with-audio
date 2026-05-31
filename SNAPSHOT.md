# pi-telegram-sandbox — Upstream Snapshot Provenance

This sandbox extension is a **vendored fork** of upstream `git:github.com/llblab/pi-telegram`.

## Base snapshot

- **Upstream:** https://github.com/llblab/pi-telegram
- **Commit SHA:** `8418c059f4277a6c0b59fab190a08dc50b2cbea5`
- **Subject:** `Merge pull request #59 from llblab/dev` (includes `0.13.1` + `0.13.2` hotfix lineage)
- **Date:** 2026-05-26 01:44:43 +0400
- **Vendored on:** 2026-05-25 (initial), uplifted on 2026-05-27

## Intent

- Local-only, owned by this nix-config tree.
- Initial scope: assigned to XO (Chief of Staff) lane only.
- CE / BB-8 / XA remain on upstream `pi-telegram` package.
- All local `telegram-*` capabilities (audio I/O, image I/O, new-session-bridge, reboot-bridge) are folded into this sandbox under `folded/`.
- Reboot bridge is active for XO by explicit operator request (no confirmation blocker; immediate reboot on reboot intent).

## Update policy

- Treat this directory as a deliberate fork, not as a tracking checkout.
- When pulling future upstream changes, port them in selectively and update this SNAPSHOT.md with the new base SHA.
- Do NOT auto-sync from upstream.
