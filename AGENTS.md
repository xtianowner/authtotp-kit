<!-- purpose: 给 AI 执行者的 AuthTOTP 部署手册（agent runbook）：读完即可在用户自己的服务器上部署公开工具 + 私有保险库，并用真实输出验收 -->

# AuthTOTP · Agent Runbook

You are an AI coding agent. A user sent you something like:

> 请阅读 https://github.com/xtianowner/authtotp-kit 里的 AGENTS.md，按它帮我部署自己的 2FA 保险库。

Your job: deploy AuthTOTP on **the user's own Linux server** and stop only when the final verification (step 8) prints real, passing output. Talk to the user in the language they used. This file is the only instruction you need; the code is the payload.

**End state**

- `https://<PUBLIC>/` — public no-account TOTP tool (static files only, cannot reach the vault).
- `https://<VAULT>/vault` — private vault: admin password + authenticator app; per-entry tokens and share links for scripts or teammates.
- Daily encrypted-at-rest backups on the server; the master key never leaves the server unless the user copies it.

## 0. Rules for you (read first)

1. **Never fake a result.** Every "done" you report must quote real command output. If you could not verify something, say so.
2. **Human-in-loop steps are marked 🧑.** At those steps, stop, tell the user exactly what to do (one short list), wait for them to say it is done, then verify with a command.
3. **Secrets:** never print, log, or write the admin password, recovery codes, tokens, or `/etc/authtotp/master-key` into chat, files or shell history. The installer creates the master key on the server and never prints it. Never ask the user to paste secrets into chat.
4. **Never delete or overwrite** `/srv/authtotp/data/` or `/etc/authtotp/master-key`. If a step seems to need that, stop and ask the user.
5. **On failure, do not loop.** Read the `FAIL` line, fix the cause from the table in §9, re-run the same step once. If it fails again, stop and report the exact output.
6. **Network checks:** your own machine may sit behind a proxy/VPN that makes `nslookup`/`curl` lie. Check DNS from the server (§5) and treat that as the truth.

## 1. Ask the user (one message)

Ask for, and wait for, all of:

| Item | Example | Notes |
|---|---|---|
| SSH target for the server | `root@203.0.113.10` or `ubuntu@my-vps` | Ubuntu 24.04+ / Debian 12+, root or sudo |
| Domain for the **public tool** | `totp.example.com` | a subdomain they control in DNS |
| Domain for the **vault** | `vault.example.com` | must differ from the public one |
| Keep the default character art? | yes / my own / none | default is the XTian character; see §7 |
| Anything special about the server? | a plain VPS / it already runs a website / home broadband / it is in mainland China | decides the HTTPS mode in §2 |

Set them as shell variables for the rest of this run:

```bash
SERVER='root@203.0.113.10'      # replace
PUBLIC='totp.example.com'       # replace
VAULT='vault.example.com'       # replace
```

If the addresses need a port other than 443 (only with §12), include it, for example `VAULT='vault.example.com:8443'`; every `https://$VAULT/...` command below then works unchanged.

## 2. Preflight (silent; fix what you can)

```bash
ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" 'echo connected; . /etc/os-release; echo "$PRETTY_NAME"; python3 -V; sudo -n true && echo sudo-ok'
```

Success: prints `connected`, an Ubuntu 24.04+ or Debian 12+ name, `Python 3.11` or newer, and `sudo-ok` (or the user is root).

- `Permission denied (publickey)` → 🧑 ask the user to set up SSH key login for you, or to run the commands themselves.
- Python older than 3.11 → stop: tell the user this server's OS is too old (needs Ubuntu 24.04+ / Debian 12+).
- `sudo` asks for a password → 🧑 ask the user to run step 3 themselves in their terminal, or to enable passwordless sudo for this session.

Then see who owns the web ports:

```bash
ssh "$SERVER" 'sudo ss -Htlnp "( sport = :80 or sport = :443 )"'
```

Choose the HTTPS mode from that output and the user's answer in §1, and tell the user which one and why, in plain words:

- **Default (most servers):** nothing listens on 80/443, or only `caddy`. Continue with step 3 as written; Caddy obtains the certificates by itself.
- **Another web server owns 80/443** (`nginx`, `apache2`, `docker-proxy`, a hosting panel …): ask the user whether to put AuthTOTP behind it. With their yes, follow §12. Never stop, remove or rewrite their web server or its other sites.
- **Home broadband, or 80/443 unreachable from the internet:** say plainly that many home lines block 80/443, that a dynamic IP needs DDNS, and that the provider contract may not allow hosting a website; an ordinary VPS is the simpler path. If they still want it, follow §12 with a custom port and certificates through DNS validation.
- **Server in mainland China:** domains served from mainland servers need an ICP filing (备案); without one the provider blocks the site, and a custom port is not a way around that. Suggest a server outside mainland China or finishing the filing first. Do not proceed as if the site will be reachable.

## 3. Install on the server (one command, safe to re-run)

```bash
ssh "$SERVER" "sudo bash -lc 'set -e; command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git); \
  if [ -d /srv/authtotp/src/.git ]; then git -C /srv/authtotp/src pull --ff-only; \
  else mkdir -p /srv/authtotp && git clone --depth 1 https://github.com/xtianowner/authtotp-kit /srv/authtotp/src; fi; \
  bash /srv/authtotp/src/deploy/install.sh --public $PUBLIC --vault $VAULT'"
```

For §12 add `--external-https` after `install.sh` (the addresses may then carry a port). Step 1 runs every check before anything on the server changes, so a `FAIL` there leaves the server exactly as it was.

It prints steps `1/10` … `10/10`, each with `OK`, and ends with `10/10 done on this server` plus the next steps. It takes a few minutes (it installs Caddy, Node.js 22 and Python packages and builds the frontend).

Success: the last block starts with `==> 10/10 done on this server`, and step 8 printed `authtotp.service healthy: {"status":"ok",...}`.

If any line says `FAIL`, use §9.

## 4. 🧑 DNS records

Tell the user to add two **A records** at their DNS provider, pointing both domains to the server's public IPv4 (step 10 printed it):

| Type | Name | Value | Proxy / CDN |
|---|---|---|---|
| A | the public-tool subdomain | server IPv4 | **off** (DNS only) |
| A | the vault subdomain | server IPv4 | **off** (DNS only) |

The CDN proxy (for example Cloudflare's orange cloud) must be **off**, otherwise Caddy cannot get certificates and the vault sees the CDN's IPs instead of real visitors.

## 5. Wait for DNS and HTTPS

Check from the server, repeating every 30 seconds for up to 15 minutes:

```bash
ssh "$SERVER" "for d in $PUBLIC $VAULT; do printf '%s ' \$d; curl -s -H 'accept: application/dns-json' \"https://cloudflare-dns.com/dns-query?name=\${d%%:*}&type=A\" | grep -o '\"data\":\"[0-9.]*\"' | head -1; echo; done"
ssh "$SERVER" "curl -s -o /dev/null -w 'public %{http_code}\n' https://$PUBLIC/; curl -s -o /dev/null -w 'vault %{http_code}\n' https://$VAULT/vault"
```

Success: both domains resolve to the server IP, then `public 200` and `vault 200` (Caddy obtains certificates automatically within a minute or two after DNS resolves).

## 6. 🧑 First admin setup (only through an SSH tunnel)

A fresh vault only accepts its first admin setup **from the server itself**, so nobody else can claim it. Tell the user:

1. In a terminal on **their own computer**, run (keep it open):
   `ssh -L 18473:127.0.0.1:18473 <their SSH target>`
2. Open **http://localhost:18473/vault** in Chrome or Edge.
3. Set an admin password (at least 12 characters). Store it in their password manager.
4. In ⚙ settings → two-step verification, scan the QR code with their authenticator app, confirm with a 6-digit code, and **save the 10 recovery codes offline**.
5. Tell you when done, then close the tunnel.

Verify (no secrets involved):

```bash
ssh "$SERVER" "curl -s http://127.0.0.1:18473/api/auth/status"
```

Success: `"bootstrapped":true`, `"totp_enrolled":true`, `"totp_required":true`.

## 7. Character art (ask; the user decides, default keeps XTian)

The public tool, the vault login and the 404 page show a character figure, and every page has a footer credit `by XTian` linking to https://blog.xtianowner.com/. Tell the user the three options below in plain words and let them pick; the XTian figure is only one of them. Mention that they can design their own character.

All choices are written to `/srv/authtotp/src/src/brand/local/index.js`. Git ignores that folder, so step 3 (updates) never overwrites the choice. Do not edit `src/brand/index.js`, and never run `git checkout`, `git reset` or `git stash` in `/srv/authtotp/src`.

- **Keep XTian (default)** → nothing to do. The figures are CC BY 4.0 (see `THIRD_PARTY_NOTICES.md`): while they are shown, keep the footer credit `by XTian` and its link. Do not remove or reword it.
- **No figure** (they want neither XTian nor their own) → write the file below, then re-run step 3. The pages render cleanly without figures. With no XTian figure shown, the footer credit is theirs to keep, change or drop: to drop it, add `export const attribution = null`; to change it, see the last line of the next option.

  ```bash
  ssh "$SERVER" "sudo install -d /srv/authtotp/src/src/brand/local && sudo tee /srv/authtotp/src/src/brand/local/index.js >/dev/null" <<'EOF'
  export const homeFigure = null
  export const loginFigure = null
  export const notFoundFigure = null
  EOF
  ```

- **Their own character** → guide them:
  1. They need three images in the same roles: holding a shield and a key (public tool), pushing open a glowing vault door (vault login), dozing against a small safe (404). Any image they have the rights to works, including a logo or mascot they already use.
  2. Spec: transparent-background WebP, about 900 px tall, ideally under 150 KB each, dark studio lighting with a teal rim light (about `rgb(45, 212, 191)`) and a cool-white key light — dark clothes or hair vanish on the dark pages without a rim light.
  3. If they use an image model, offer this prompt skeleton (they attach a reference photo of their character):
     `full-body 3D collectible figure of <character>, <pose>, standing on a round glowing teal pedestal, dark studio background, teal rim light from behind and both sides, soft cool-white key light, transparent background, product photo, high detail`
  4. Copy the three files into `/srv/authtotp/src/src/brand/local/`, then write `index.js` there (use each image's real pixel size):

     ```js
     import home from './home.webp'
     import login from './login.webp'
     import notFound from './404.webp'
     export const homeFigure = { src: home, width: 600, height: 900 }
     export const loginFigure = { src: login, width: 800, height: 900 }
     export const notFoundFigure = { src: notFound, width: 600, height: 900, bubble: null }
     export const attribution = { href: 'https://their-site.example/', label: { zh: 'by 他们的名字', en: 'by Their Name' } }
     ```

     `bubble: null` is required: the bubble animation only fits the default 404 image. The `attribution` line is optional; leave it out to keep `by XTian`, or set it to `null` to show no credit.
  5. Re-run step 3, then check the three pages in a browser.

## 8. Final verification (run, then report the real output)

```bash
ssh "$SERVER" "systemctl is-active authtotp caddy authtotp-backup.timer; \
  curl -s http://127.0.0.1:18473/health; echo; \
  curl -s -o /dev/null -w 'anonymous /api/entries -> %{http_code}\n' https://$VAULT/api/entries; \
  curl -sI https://$PUBLIC/ | grep -iE '^(HTTP|content-security-policy)'; \
  curl -s -o /dev/null -w 'vault root -> %{http_code} %{redirect_url}\n' https://$VAULT/; \
  sudo ls -l /etc/authtotp/master-key; systemctl list-timers authtotp-backup.timer --no-pager | head -2; \
  if curl -s http://127.0.0.1:18473/api/auth/status | grep -q '\"bootstrapped\":true'; then \
    curl -s -o /dev/null -w 'anonymous setup attempt -> %{http_code}\n' -X POST -H 'content-type: application/json' \
      -d '{\"password\":\"probe-not-a-password-0000\"}' https://$VAULT/api/auth/bootstrap; \
  else echo 'anonymous setup attempt -> skipped: finish step 6 first'; fi"
```

All of these must hold, quoted from the output:

- three lines `active` (in §12 mode the second one is about Caddy and does not apply; check the user's web server instead);
- health `{"status":"ok","clock_healthy":true,...}`;
- `anonymous /api/entries -> 401`;
- `HTTP/2 200` (any `HTTP/… 200` in §12 mode) and a `content-security-policy` line containing `connect-src 'none'` for the public tool;
- `vault root -> 302 https://<PUBLIC>/`;
- `-r-------- 1 authtotp authtotp ... /etc/authtotp/master-key`;
- a backup timer with a next run time;
- `anonymous setup attempt -> 403`: a visitor from the internet is not mistaken for the SSH tunnel. The attempt leaves one `denied` line in the vault's audit log, which is expected. Anything else: §9.

Then tell the user, in plain words: the two addresses, that the admin login needs password + authenticator code, where backups live (`/srv/authtotp/data/backups`, daily 04:10 server time), and that they should keep an offline copy of `/etc/authtotp/master-key` (🧑 they can fetch it themselves with `scp`; a backup without this key cannot be decrypted).

## 9. When something fails

| Symptom | Cause | Fix |
|---|---|---|
| `FAIL port 80 (or 443) is already used by '<name>'` | another web server (nginx, Apache, Docker) owns HTTPS | ask the user whether to put AuthTOTP behind it; with their yes, follow §12. Never stop or rewrite their web server. |
| `FAIL Python >= 3.11 is required` | OS too old | needs Ubuntu 24.04+ / Debian 12+ |
| `FAIL /etc/authtotp/env is not set up for https://<VAULT>` | the line above it says which: the vault address is missing from `AUTHTOTP_ALLOWED_ORIGINS` or `AUTHTOTP_ALLOWED_HOSTS` (for example after changing the vault domain or port), or a line cannot be parsed | edit those settings in `/etc/authtotp/env`: comma-separated, keep the other origins the user still needs, one `KEY=value` per line without backslashes; then re-run step 3 |
| `--vault ...: a port other than 443 needs --external-https` | the address has a port, which only §12 supports | follow §12, or drop the port |
| `FAIL this server was installed with HTTPS mode ...` | step 3 was run in the other HTTPS mode | re-run with the original mode, or follow "Switching modes" in §12 |
| `FAIL ... already has data but /etc/authtotp/master-key is missing` | key file lost | restore the original key file; **never** generate a new one over existing data |
| service log says `拒绝启动` / refuses to start | settings incomplete for an internet-facing install | the message names what is missing; compare with `deploy/authtotp.env.example` |
| `public 000` / certificate errors after DNS resolves | port 80/443 blocked by a cloud firewall, or CDN proxy on | open TCP 80 and 443 in the provider's firewall; turn the CDN proxy off; `journalctl -u caddy -n 50` |
| setup page says only local access is allowed (`BOOTSTRAP_LOCAL_ONLY`) | the user opened `https://<VAULT>/vault` instead of the tunnel | use step 6 exactly: tunnel + `http://localhost:18473/vault` |
| login answers `LOGIN_LOCKED` | too many failed logins from the internet | wait an hour, or log in through the tunnel (step 6) |
| `anonymous setup attempt -> 409` | the HTTPS front does not pass `X-Forwarded-For`, so the vault takes internet visitors for the SSH tunnel | tell the user now; add the `X-Forwarded-For` line from `/etc/authtotp/proxy/nginx.conf` (or use the Caddy reference), reload the front, repeat the check until it says `403` |
| `anonymous setup attempt -> 000` | the server cannot reach its own public address | run that one `curl` from your own machine instead |

Do not retry a failing step more than once without changing something.

## 10. Updating later

Re-run step 3 with the same arguments (including `--external-https` if it was used). It pulls the latest code, rebuilds, reinstalls and restarts; data, the master key, `/etc/authtotp/env` and the character choice in `src/brand/local/` are kept. The HTTPS mode is remembered in `/etc/authtotp/install.conf` and a different one is refused. In §12 mode the reference configs in `/etc/authtotp/proxy/` are refreshed but the user's web server is not touched: compare them with the live config (`diff`) and apply changes with the user's OK. Then run step 8. If `git pull --ff-only` fails because files in `/srv/authtotp/src` were edited by hand, stop and show the user `git -C /srv/authtotp/src status --short`; do not discard their edits.

## 11. Removing it

Only if the user explicitly asks, and only after they confirm they have exported what they need:

```bash
ssh "$SERVER" "sudo systemctl disable --now authtotp authtotp-backup.timer; \
  sudo rm -f /etc/systemd/system/authtotp*.service /etc/systemd/system/authtotp-backup.timer /etc/caddy/authtotp.caddy; \
  sudo sed -i '\#import /etc/caddy/authtotp.caddy#d' /etc/caddy/Caddyfile; sudo systemctl reload caddy"
```

In §12 mode, also remove the AuthTOTP blocks from the user's web server (for example `/etc/nginx/conf.d/authtotp.conf`) and reload it, with their OK.

This leaves `/srv/authtotp/data` and `/etc/authtotp` in place. Deleting those destroys every stored 2FA secret; do it only on the user's explicit, separate instruction.

## 12. Your own HTTPS front (`--external-https`)

Use this only when §2 sent you here: another web server already owns 80/443, or 80/443 cannot be reached from the internet. The installer then installs everything except Caddy, leaves ports 80/443 and every web server alone, accepts addresses with a port, and writes reference configs for the front to `/etc/authtotp/proxy/nginx.conf` and `/etc/authtotp/proxy/Caddyfile`.

Requirements for the front, all of them:

- It runs **on this server**: the vault listens on `127.0.0.1:18473` only and the public tool is files in `/srv/static-sites/totp/current`.
- It sends `X-Forwarded-For` to the vault. Without it the vault cannot tell an internet visitor from the SSH tunnel; the reference configs have the line, keep it.
- It keeps every header from the reference (the public tool's `connect-src 'none'` CSP, HSTS, frame and referrer rules) and the 64 KB request limit.
- Its certificates **renew by themselves**. When 80/443 are blocked, use DNS validation through the front's own certificate tool (for example certbot or acme.sh with the user's DNS provider plugin). A certificate fetched once by hand expires in about 90 days; do not set one up.
- No CDN proxy in front of the vault, for the reason given in §4.
- Public tool and vault keep two different domain names; two ports on one name are not enough.

Order, so the vault is claimed before anything can reach it from the internet:

1. Step 3 with the flag, using the addresses as the user will type them in a browser:

   ```bash
   ssh "$SERVER" "sudo bash -lc '... bash /srv/authtotp/src/deploy/install.sh --external-https --public $PUBLIC --vault $VAULT'"
   ```

   (the `...` is the same git clone / pull part as in step 3).
2. 🧑 Step 6 right away, through the SSH tunnel, before the front goes live.
3. Wire the front from `/etc/authtotp/proxy/`. For nginx: copy `nginx.conf` to `/etc/nginx/conf.d/authtotp.conf`, set the certificate paths, `sudo nginx -t`, then `sudo systemctl reload nginx`. For a Caddy the user manages: import the `Caddyfile` copy, add a `tls <cert> <key>` line to both sites if this Caddy cannot obtain certificates itself, then `caddy validate` and reload. Show the user the change before reloading their web server.
4. 🧑 DNS records, and on home broadband the router's port forwarding to this server, for the addresses' ports. Do not change router or DNS entries that other services use.
5. Steps 5 and 8 with the same variables. `anonymous setup attempt -> 403` is required; until it holds, treat the vault as exposed and tell the user.

**Switching modes.** From the default to §12: remove the line `import /etc/caddy/authtotp.caddy` from `/etc/caddy/Caddyfile` and the file itself, reload or stop Caddy as the user prefers, delete `/etc/authtotp/install.conf`, then run step 3 with the flag. From §12 to the default: remove the AuthTOTP blocks from the user's web server so 80/443 are free, delete `/etc/authtotp/install.conf`, then run step 3 without the flag. Either way, if the vault address changes, edit `/etc/authtotp/env` as in §9. Data and the master key are not involved.

## Security boundary (what this does and does not protect)

- Each TOTP secret is encrypted with its own key (AES-256-GCM); those keys are wrapped by the master key, which is a separate file readable only by the service account.
- The vault listens on `127.0.0.1` only; the internet reaches it through Caddy's HTTPS (or, in §12 mode, the user's own HTTPS front on the same server). The service runs in a systemd sandbox that cannot make outbound connections.
- First setup and sign-in before the authenticator is bound are accepted only from the server itself; an internet-facing configuration without this protection refuses to start.
- The public tool is a separate origin with plain static files and `connect-src 'none'`: it cannot talk to the vault or anywhere else.
- **Not protected:** someone with root on the server can read both the database and the master key. Tokens and share links are bearer keys: anyone holding one can read that entry's codes until it expires or is revoked.

by [XTian](https://blog.xtianowner.com/)
