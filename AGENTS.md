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

Set them as shell variables for the rest of this run:

```bash
SERVER='root@203.0.113.10'      # replace
PUBLIC='totp.example.com'       # replace
VAULT='vault.example.com'       # replace
```

## 2. Preflight (silent; fix what you can)

```bash
ssh -o BatchMode=yes -o ConnectTimeout=15 "$SERVER" 'echo connected; . /etc/os-release; echo "$PRETTY_NAME"; python3 -V; sudo -n true && echo sudo-ok'
```

Success: prints `connected`, an Ubuntu 24.04+ or Debian 12+ name, `Python 3.11` or newer, and `sudo-ok` (or the user is root).

- `Permission denied (publickey)` → 🧑 ask the user to set up SSH key login for you, or to run the commands themselves.
- Python older than 3.11 → stop: tell the user this server's OS is too old (needs Ubuntu 24.04+ / Debian 12+).
- `sudo` asks for a password → 🧑 ask the user to run step 3 themselves in their terminal, or to enable passwordless sudo for this session.

## 3. Install on the server (one command, safe to re-run)

```bash
ssh "$SERVER" "sudo bash -lc 'set -e; command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git); \
  if [ -d /srv/authtotp/src/.git ]; then git -C /srv/authtotp/src pull --ff-only; \
  else mkdir -p /srv/authtotp && git clone --depth 1 https://github.com/xtianowner/authtotp-kit /srv/authtotp/src; fi; \
  bash /srv/authtotp/src/deploy/install.sh --public $PUBLIC --vault $VAULT'"
```

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
ssh "$SERVER" "for d in $PUBLIC $VAULT; do printf '%s ' \$d; curl -s -H 'accept: application/dns-json' \"https://cloudflare-dns.com/dns-query?name=\$d&type=A\" | grep -o '\"data\":\"[0-9.]*\"' | head -1; echo; done"
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
  sudo ls -l /etc/authtotp/master-key; systemctl list-timers authtotp-backup.timer --no-pager | head -2"
```

All of these must hold, quoted from the output:

- three lines `active`;
- health `{"status":"ok","clock_healthy":true,...}`;
- `anonymous /api/entries -> 401`;
- `HTTP/2 200` and a `content-security-policy` line containing `connect-src 'none'` for the public tool;
- `vault root -> 302 https://<PUBLIC>/`;
- `-r-------- 1 authtotp authtotp ... /etc/authtotp/master-key`;
- a backup timer with a next run time.

Then tell the user, in plain words: the two addresses, that the admin login needs password + authenticator code, where backups live (`/srv/authtotp/data/backups`, daily 04:10 server time), and that they should keep an offline copy of `/etc/authtotp/master-key` (🧑 they can fetch it themselves with `scp`; a backup without this key cannot be decrypted).

## 9. When something fails

| Symptom | Cause | Fix |
|---|---|---|
| `FAIL port 80 (or 443) is already used by '<name>'` | another web server (nginx, Apache, Docker) owns HTTPS | stop; ask the user whether to put AuthTOTP behind that server instead. This runbook only covers Caddy. |
| `FAIL Python >= 3.11 is required` | OS too old | needs Ubuntu 24.04+ / Debian 12+ |
| `FAIL ... /etc/authtotp/env exists but is not set up for https://<VAULT>` | re-run with a different vault domain | edit `AUTHTOTP_ALLOWED_HOSTS` and `AUTHTOTP_ALLOWED_ORIGINS` in `/etc/authtotp/env` to the new domain, re-run step 3 |
| `FAIL ... already has data but /etc/authtotp/master-key is missing` | key file lost | restore the original key file; **never** generate a new one over existing data |
| service log says `拒绝启动` / refuses to start | settings incomplete for an internet-facing install | the message names what is missing; compare with `deploy/authtotp.env.example` |
| `public 000` / certificate errors after DNS resolves | port 80/443 blocked by a cloud firewall, or CDN proxy on | open TCP 80 and 443 in the provider's firewall; turn the CDN proxy off; `journalctl -u caddy -n 50` |
| setup page says only local access is allowed (`BOOTSTRAP_LOCAL_ONLY`) | the user opened `https://<VAULT>/vault` instead of the tunnel | use step 6 exactly: tunnel + `http://localhost:18473/vault` |
| login answers `LOGIN_LOCKED` | too many failed logins from the internet | wait an hour, or log in through the tunnel (step 6) |

Do not retry a failing step more than once without changing something.

## 10. Updating later

Re-run step 3. It pulls the latest code, rebuilds, reinstalls and restarts; data, the master key, `/etc/authtotp/env` and the character choice in `src/brand/local/` are kept. Then run step 8. If `git pull --ff-only` fails because files in `/srv/authtotp/src` were edited by hand, stop and show the user `git -C /srv/authtotp/src status --short`; do not discard their edits.

## 11. Removing it

Only if the user explicitly asks, and only after they confirm they have exported what they need:

```bash
ssh "$SERVER" "sudo systemctl disable --now authtotp authtotp-backup.timer; \
  sudo rm -f /etc/systemd/system/authtotp*.service /etc/systemd/system/authtotp-backup.timer /etc/caddy/authtotp.caddy; \
  sudo sed -i '\#import /etc/caddy/authtotp.caddy#d' /etc/caddy/Caddyfile; sudo systemctl reload caddy"
```

This leaves `/srv/authtotp/data` and `/etc/authtotp` in place. Deleting those destroys every stored 2FA secret; do it only on the user's explicit, separate instruction.

## Security boundary (what this does and does not protect)

- Each TOTP secret is encrypted with its own key (AES-256-GCM); those keys are wrapped by the master key, which is a separate file readable only by the service account.
- The vault listens on `127.0.0.1` only; the internet reaches it through Caddy's HTTPS. The service runs in a systemd sandbox that cannot make outbound connections.
- First setup and sign-in before the authenticator is bound are accepted only from the server itself; an internet-facing configuration without this protection refuses to start.
- The public tool is a separate origin with plain static files and `connect-src 'none'`: it cannot talk to the vault or anywhere else.
- **Not protected:** someone with root on the server can read both the database and the master key. Tokens and share links are bearer keys: anyone holding one can read that entry's codes until it expires or is revoked.

by [XTian](https://blog.xtianowner.com/)
