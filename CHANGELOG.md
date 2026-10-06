<!-- purpose: AuthTOTP Kit 版本记录 -->

# Changelog

## 0.2.0 · installer checks first, and your own HTTPS front

- `deploy/install.sh` runs every check before it changes anything on the server. An existing `/etc/authtotp/env` is read with the vault's own origin rules, so several origins, an explicit `:443`, quotes and spaces are accepted on updates; a commented-out line, a look-alike domain or an invalid origin are refused with the reason. Before, a valid multi-origin setting blocked updates, and a failed check came after the new code was already copied.
- `--external-https`: for servers where another web server (for example nginx) already owns ports 80/443, or where 80/443 cannot be reached. The installer leaves HTTPS and every web server alone, accepts addresses with a port, and writes reference configs for nginx and Caddy to `/etc/authtotp/proxy/`. The mode is remembered; a re-run in the other mode is refused.
- `AGENTS.md`: §2 picks the HTTPS mode with the user (including plain words about home broadband and ICP filing for servers in mainland China), new §12 for your own HTTPS front, and the final check now confirms that an internet visitor cannot use the first-setup path reserved for the SSH tunnel.

## 0.1.0 · first public release

- Public TOTP tool: paste a Base32 secret, get the code in the browser. Static files only; the page's CSP blocks every network request and the secret is never stored.
- Private vault: per-entry AES-256-GCM data keys wrapped by a master key file; login with an admin password plus an authenticator code, with 10 one-time recovery codes.
- Code API and share links: per-entry Bearer tokens with a chosen lifetime (24 h to never; default 30 days), revocable, rate limited and audited. Each token comes with a link a colleague can open to read the current code.
- Hardening: the vault listens on `127.0.0.1` only behind Caddy; first-time setup only through an SSH tunnel; the service runs in a systemd sandbox with no outbound network.
- Agent-first delivery: `AGENTS.md` takes an AI coding tool from an empty server to a verified install; `deploy/install.sh` is safe to re-run and never overwrites the master key or data.
- Character art: the XTian figures ship by default (CC BY 4.0). Each deployment can keep them, use its own or show none; the choice lives in `src/brand/local/` and survives updates.
