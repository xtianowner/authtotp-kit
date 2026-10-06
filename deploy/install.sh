#!/usr/bin/env bash
# AuthTOTP one-shot server installer (Ubuntu 24.04+ / Debian 12+). Safe to re-run: it never overwrites the master key,
# never touches /srv/authtotp/data, and keeps an existing /etc/authtotp/env.
#
#   sudo bash deploy/install.sh --public totp.example.com --vault vault.example.com
#
# What it does, in order (each step prints OK or stops with a FAIL line saying what to do):
#   1 checks   2 packages (+ Caddy, Node 22)   3 build frontend   4 install app + public tool   5 Python venv
#   6 master key   7 env file   8 systemd units (vault + daily backup)   9 Caddy sites   10 summary + next steps
# It does NOT do the human steps: DNS records, first admin setup over an SSH tunnel, binding the authenticator app.
set -euo pipefail

PUBLIC=""; VAULT=""
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/srv/authtotp/app; DATA=/srv/authtotp/data; VENV=/srv/authtotp/venv; ETC=/etc/authtotp
STATIC=/srv/static-sites/totp; CADDY_SITE=/etc/caddy/authtotp.caddy; CADDYFILE=/etc/caddy/Caddyfile
NODE_MAJOR=22

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    OK  %s\n' "$*"; }
fail() { printf '    FAIL  %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --public) PUBLIC="${2:-}"; shift 2 ;;
    --vault)  VAULT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (use --public <domain> --vault <domain>)" ;;
  esac
done
domain_re='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
[[ "$PUBLIC" =~ $domain_re ]] || fail "--public must be a domain like totp.example.com"
[[ "$VAULT" =~ $domain_re ]]  || fail "--vault must be a domain like vault.example.com"
[ "$PUBLIC" != "$VAULT" ] || fail "--public and --vault must be two different domains (they are isolated on purpose)"

# ---------------------------------------------------------------------------------------------------- 1 checks
say "1/10 checks"
[ "$(id -u)" -eq 0 ] || fail "run as root: sudo bash deploy/install.sh ..."
command -v systemctl >/dev/null || fail "systemd is required"
. /etc/os-release
case "${ID}" in ubuntu|debian) ok "OS ${PRETTY_NAME}" ;; *) fail "only Ubuntu / Debian are supported (found ${PRETTY_NAME})" ;; esac
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python >= 3.11 is required (found $(python3 -V 2>&1)). Use Ubuntu 24.04+ or Debian 12+."
ok "$(python3 -V)"
for port in 80 443; do
  holder="$(ss -Htlnp "sport = :${port}" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)"
  if [ -n "$holder" ] && [ "$holder" != "caddy" ]; then
    fail "port ${port} is already used by '${holder}'. Another web server owns this machine's HTTPS; stop and ask the human how to integrate (this installer only manages Caddy)."
  fi
done
ok "ports 80/443 free or owned by Caddy"
[ -f "$REPO/backend/requirements.txt" ] && [ -f "$REPO/package.json" ] || fail "run this from a full AuthTOTP checkout ($REPO looks incomplete)"
ok "source $REPO"

# ------------------------------------------------------------------------------------------------- 2 packages
say "2/10 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip git curl rsync ca-certificates gnupg xz-utils \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ok "base packages"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
ok "$(caddy version | head -1 | cut -d' ' -f1) (Caddy)"
node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$node_major" -lt 20 ]; then
  case "$(uname -m)" in x86_64) narch=x64 ;; aarch64|arm64) narch=arm64 ;; *) fail "unsupported CPU $(uname -m) for Node.js" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  tarball="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-${narch}.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  [ -n "$tarball" ] || fail "could not find a Node ${NODE_MAJOR} build for linux-${narch} at $base"
  tmp="$(mktemp -d)"
  curl -fSL --progress-bar -o "$tmp/$tarball" "$base/$tarball"
  (cd "$tmp" && curl -fsSL "$base/SHASUMS256.txt" | grep " $tarball\$" | sha256sum -c - >/dev/null) || fail "Node.js download checksum mismatch"
  rm -rf "/opt/node-v${NODE_MAJOR}" && mkdir -p "/opt/node-v${NODE_MAJOR}"
  tar -xJf "$tmp/$tarball" -C "/opt/node-v${NODE_MAJOR}" --strip-components=1 && rm -rf "$tmp"
  for b in node npm npx; do ln -sfn "/opt/node-v${NODE_MAJOR}/bin/$b" "/usr/local/bin/$b"; done
fi
ok "Node $(node -v)"

# ------------------------------------------------------------------------------------------- 3 build frontend
say "3/10 build frontend"
cd "$REPO"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
npm run --silent build >/dev/null
VITE_VAULT_URL="https://${VAULT}/vault" npm run --silent build:public >/dev/null
if grep -rqE '/api|/v1' dist-public/; then fail "public build references the vault API; refusing to install it"; fi
ok "dist/ (vault) and dist-public/ (public tool)"

# ------------------------------------------------------------------------------------- 4 install app + public
say "4/10 install app and public tool"
id authtotp >/dev/null 2>&1 || useradd --system --home-dir /srv/authtotp --no-create-home --shell /usr/sbin/nologin authtotp
install -d -m 755 /srv/authtotp "$APP" /srv/static-sites "$STATIC" "$STATIC/releases"
install -d -m 700 -o authtotp -g authtotp "$DATA"
rsync -a --delete --exclude __pycache__ "$REPO/backend" "$REPO/dist" "$APP/"
chown -R root:root "$APP" && chmod -R u=rwX,go=rX "$APP"
rel="$(date +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
rsync -a "$REPO/dist-public/" "$STATIC/releases/$rel/"
chown -R root:root "$STATIC/releases/$rel" && chmod -R u=rwX,go=rX "$STATIC/releases/$rel"
ln -sfn "releases/$rel" "$STATIC/current.tmp" && mv -Tf "$STATIC/current.tmp" "$STATIC/current"
ls -1dt "$STATIC"/releases/* | tail -n +6 | xargs -r rm -rf
ok "vault app in $APP; public tool release $rel"

# ---------------------------------------------------------------------------------------------- 5 Python venv
say "5/10 Python environment"
[ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q --disable-pip-version-check -r "$APP/backend/requirements.txt"
chmod -R go=rX "$VENV"
ok "$("$VENV/bin/python" -c 'import fastapi, cryptography; print("fastapi", fastapi.__version__, "cryptography", cryptography.__version__)')"

# --------------------------------------------------------------------------------------------- 6 master key
say "6/10 master key"
install -d -m 750 -o root -g authtotp "$ETC"
if [ -f "$ETC/master-key" ]; then
  ok "kept the existing $ETC/master-key (never overwritten)"
else
  if [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
    fail "$DATA already has data but $ETC/master-key is missing. Restore the original key file; a new key cannot decrypt old data."
  fi
  (umask 077; "$VENV/bin/python" -c 'import base64, secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())' > "$ETC/master-key")
  chown authtotp:authtotp "$ETC/master-key" && chmod 0400 "$ETC/master-key"
  ok "created $ETC/master-key (owner authtotp, 0400; not printed). Back it up offline together with the backups."
fi

# ---------------------------------------------------------------------------------------------- 7 env file
say "7/10 settings"
if [ -f "$ETC/env" ]; then
  grep -q "AUTHTOTP_ALLOWED_ORIGINS=https://${VAULT}\$" "$ETC/env" \
    || fail "$ETC/env exists but is not set up for https://${VAULT}. Edit it by hand (see deploy/authtotp.env.example) and re-run."
  ok "kept the existing $ETC/env"
else
  sed "s/vault\.example\.com/${VAULT}/g" "$REPO/deploy/authtotp.env.example" > "$ETC/env"
  chown root:authtotp "$ETC/env" && chmod 0640 "$ETC/env"
  ok "wrote $ETC/env for ${VAULT}"
fi

# ------------------------------------------------------------------------------------------- 8 systemd units
say "8/10 services"
install -m 644 "$REPO/deploy/authtotp.service.example" /etc/systemd/system/authtotp.service
install -m 644 "$REPO/deploy/authtotp-backup.service.example" /etc/systemd/system/authtotp-backup.service
install -m 644 "$REPO/deploy/authtotp-backup.timer.example" /etc/systemd/system/authtotp-backup.timer
systemctl daemon-reload
systemctl enable --now authtotp-backup.timer >/dev/null 2>&1
systemctl enable authtotp >/dev/null 2>&1
systemctl restart authtotp
health=""
for _ in $(seq 1 40); do
  health="$(curl -s -m 2 http://127.0.0.1:18473/health || true)"
  case "$health" in *'"status":"ok"'*) break ;; esac
  sleep 0.5
done
case "$health" in
  *'"status":"ok"'*) ok "authtotp.service healthy: $health" ;;
  *) journalctl -u authtotp -n 20 --no-pager >&2; fail "authtotp.service did not become healthy (log above)" ;;
esac

# ---------------------------------------------------------------------------------------------- 9 Caddy sites
say "9/10 Caddy"
sed -e "s/totp\.example\.com/${PUBLIC}/g" -e "s/vault\.example\.com/${VAULT}/g" "$REPO/deploy/Caddyfile.example" > "$CADDY_SITE"
chmod 644 "$CADDY_SITE"
if [ ! -f "$CADDYFILE" ] || { grep -q '/usr/share/caddy' "$CADDYFILE" && ! grep -q '^[^#]*[a-z0-9-]\.[a-z]' "$CADDYFILE"; }; then
  printf '# Managed by AuthTOTP deploy/install.sh\nimport %s\n' "$CADDY_SITE" > "$CADDYFILE"
  ok "replaced the stock $CADDYFILE with an import of $CADDY_SITE"
elif grep -qF "import $CADDY_SITE" "$CADDYFILE"; then
  ok "$CADDYFILE already imports $CADDY_SITE"
else
  printf '\n# AuthTOTP (deploy/install.sh)\nimport %s\n' "$CADDY_SITE" >> "$CADDYFILE"
  ok "appended an import of $CADDY_SITE to your existing $CADDYFILE"
fi
caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1 || { caddy validate --config "$CADDYFILE" --adapter caddyfile; fail "Caddy rejected the configuration (see above)"; }
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy
ok "Caddy serves ${PUBLIC} (public tool) and ${VAULT} (vault)"

# ------------------------------------------------------------------------------------------------ 10 summary
say "10/10 done on this server"
ip4="$(curl -4 -s -m 5 https://api.ipify.org || true)"
cat <<EOF
    Next (human steps, see AGENTS.md):
      1. DNS: A records  ${PUBLIC} -> ${ip4:-<server public IPv4>}  and  ${VAULT} -> ${ip4:-<same IP>}
         (DNS only; no CDN proxy, so Caddy can obtain certificates)
      2. First admin setup ONLY through an SSH tunnel:
           ssh -L 18473:127.0.0.1:18473 <you>@<this server>
           then open http://localhost:18473/vault , set the admin password, bind your authenticator app,
           and store the 10 recovery codes offline.
      3. Keep an offline copy of ${ETC}/master-key together with your backups (${DATA}/backups).
EOF
