# Reference demos

Which file is the spec depends on the round; the owner's rule for the demo-parity round is that the demo is the spec, except for the KEEP list (`scripts/web-shots/demo-diff.keep.json`).

- `redesign-demo.html` is the owner's approved demo for the demo-parity round (`nexa-web-admin-demo.html`: it carries `<script type="application/json" id="nx-data">`, a fetch shim and the `__NXH` history object that `pnpm web:demo-diff` uses). It is NOT committed yet: the file was not delivered to the session that built the comparison tool. Place the owner's file at this path unchanged; `pnpm web:demo-diff` picks it up by itself and otherwise falls back to `approved-demo.html` with a loud warning. It must not be recreated or reconstructed.
- `approved-demo.html` is the older reference (hash routing, no `#nx-data`), kept for history. Earlier redesign PRs were built against it.
- `../../v095/approved-demo.html` holds four screens only (the v0.9.5 approval).

The PNGs and `pairs/` here are older captures of the earlier demo.
