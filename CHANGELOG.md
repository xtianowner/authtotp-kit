<!-- purpose: AuthTOTP Kit 版本记录 -->

# Changelog

## 0.1.0 · first public release

- Public TOTP tool: paste a Base32 secret, get the code in the browser. Static files only; the page's CSP blocks every network request and the secret is never stored.
- Private vault: per-entry AES-256-GCM data keys wrapped by a master key file; login with an admin password plus an authenticator code, with 10 one-time recovery codes.
- Code API and share links: per-entry Bearer tokens with a chosen lifetime (24 h to never; default 30 days), revocable, rate limited and audited. Each token comes with a link a colleague can open to read the current code.
- Hardening: the vault listens on `127.0.0.1` only behind Caddy; first-time setup only through an SSH tunnel; the service runs in a systemd sandbox with no outbound network.
- Agent-first delivery: `AGENTS.md` takes an AI coding tool from an empty server to a verified install; `deploy/install.sh` is safe to re-run and never overwrites the master key or data.
- Character art: the XTian figures ship by default (CC BY 4.0). Each deployment can keep them, use its own or show none; the choice lives in `src/brand/local/` and survives updates.
