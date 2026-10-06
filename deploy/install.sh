#!/usr/bin/env bash
# AuthTOTP one-shot server installer (Ubuntu 24.04+ / Debian 12+). Safe to re-run: it never overwrites the master key,
# never touches /srv/authtotp/data, and keeps an existing /etc/authtotp/env.
#
#   sudo bash deploy/install.sh --public totp.example.com --vault vault.example.com
#   sudo bash deploy/install.sh --external-https --public totp.example.com:8443 --vault vault.example.com:8443
#
# Default: the script installs Caddy, which takes ports 80/443 and obtains the certificates by itself.
# --external-https: you run the HTTPS front yourself on this server (an nginx that already owns 80/443, or ports
#   80/443 are not reachable from the internet). The script leaves HTTPS and every web server alone, accepts a
#   port in the addresses and writes reference configs to /etc/authtotp/proxy/. See AGENTS.md §12.
#
# What it does, in order (each step prints OK or stops with a FAIL line saying what to do):
#   1 checks (all of them; nothing on the server changes before they pass)   2 packages (+ Caddy, Node 22)
#   3 build frontend   4 install app + public tool   5 Python venv   6 master key   7 settings
#   8 systemd units (vault + daily backup)   9 HTTPS front (Caddy sites, or reference configs)   10 summary + next steps
# It does NOT do the human steps: DNS records, first admin setup over an SSH tunnel, binding the authenticator app.
set -euo pipefail

PUBLIC=""; VAULT=""; MODE=caddy; EXTERNAL_FLAG=()
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP=/srv/authtotp/app; DATA=/srv/authtotp/data; VENV=/srv/authtotp/venv; ETC=/etc/authtotp
STATIC=/srv/static-sites/totp; CADDY_SITE=/etc/caddy/authtotp.caddy; CADDYFILE=/etc/caddy/Caddyfile
NODE_MAJOR=22

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    OK  %s\n' "$*"; }
fail() { printf '    FAIL  %s\n' "$*" >&2; exit 1; }
# URL and env checks use the backend's own origin rules (backend/app/deploy_check.py, standard library only).
deploy_check() { (cd "$REPO" && PYTHONDONTWRITEBYTECODE=1 python3 -m backend.app.deploy_check "$@"); }

while [ $# -gt 0 ]; do
  case "$1" in
    --public) PUBLIC="${2:-}"; shift 2 ;;
    --vault)  VAULT="${2:-}"; shift 2 ;;
    --external-https) MODE=external; EXTERNAL_FLAG=(--external-https); shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (use --public <domain> --vault <domain> [--external-https])" ;;
  esac
done

# ---------------------------------------------------------------------------------------------------- 1 checks
say "1/10 checks (nothing on this server changes until all of them pass)"
[ "$(id -u)" -eq 0 ] || fail "run as root: sudo bash deploy/install.sh ..."
command -v systemctl >/dev/null || fail "systemd is required"
. /etc/os-release
case "${ID}" in ubuntu|debian) ok "OS ${PRETTY_NAME}" ;; *) fail "only Ubuntu / Debian are supported (found ${PRETTY_NAME})" ;; esac
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' \
  || fail "Python >= 3.11 is required (found $(python3 -V 2>&1)). Use Ubuntu 24.04+ or Debian 12+."
ok "$(python3 -V)"
[ -f "$REPO/backend/requirements.txt" ] && [ -f "$REPO/backend/app/deploy_check.py" ] && [ -f "$REPO/package.json" ] \
  || fail "run this from a full AuthTOTP checkout ($REPO looks incomplete)"
ok "source $REPO"

sites="$(deploy_check urls --public "$PUBLIC" --vault "$VAULT" "${EXTERNAL_FLAG[@]}")" \
  || fail "fix --public / --vault (reason above)"
while IFS='=' read -r key value; do
  case "$key" in
    PUBLIC_URL) PUBLIC_URL="$value" ;; PUBLIC_HOST) PUBLIC_HOST="$value" ;; PUBLIC_PORT) PUBLIC_PORT="$value" ;;
    PUBLIC_SITE) PUBLIC_SITE="$value" ;; VAULT_URL) VAULT_URL="$value" ;; VAULT_HOST) VAULT_HOST="$value" ;;
    VAULT_PORT) VAULT_PORT="$value" ;; VAULT_SITE) VAULT_SITE="$value" ;;
  esac
done <<<"$sites"
if [ "$MODE" = caddy ]; then front="Caddy, managed by this script"; else front="your own front (--external-https)"; fi
ok "public tool ${PUBLIC_URL}/ · vault ${VAULT_URL}/vault · HTTPS: ${front}"

installed_mode=""
if [ -f "$ETC/install.conf" ]; then
  installed_mode="$(sed -n 's/^AUTHTOTP_HTTPS_MODE=//p' "$ETC/install.conf" | tail -n 1)"
elif [ -f "$CADDY_SITE" ]; then
  installed_mode=caddy
fi
if [ -n "$installed_mode" ] && [ "$installed_mode" != "$MODE" ]; then
  fail "this server was installed with HTTPS mode '${installed_mode}', and this run asks for '${MODE}'. Switching is a manual step: see AGENTS.md §12 \"Switching modes\"."
fi

if [ "$MODE" = caddy ]; then
  for port in 80 443; do
    holder="$(ss -Htlnp "sport = :${port}" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -1 | cut -d'"' -f2 || true)"
    if [ -n "$holder" ] && [ "$holder" != "caddy" ]; then
      fail "port ${port} is already used by '${holder}'. Another web server owns this machine's HTTPS: re-run with --external-https and put AuthTOTP behind it (AGENTS.md §12), after asking the human."
    fi
  done
  ok "ports 80/443 free or owned by Caddy"
else
  ok "--external-https: ports 80/443 and web servers are left alone"
fi

if [ -f "$ETC/env" ]; then
  deploy_check env "$ETC/env" --vault-url "$VAULT_URL" \
    || fail "$ETC/env is not set up for ${VAULT_URL} (reason above). Edit it by hand (see deploy/authtotp.env.example) and re-run."
  ok "existing $ETC/env serves ${VAULT_URL}"
fi
if [ ! -f "$ETC/master-key" ] && [ -n "$(ls -A "$DATA" 2>/dev/null)" ]; then
  fail "$DATA already has data but $ETC/master-key is missing. Restore the original key file; a new key cannot decrypt old data."
fi

# ------------------------------------------------------------------------------------------------- 2 packages
say "2/10 packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3-venv python3-pip git curl rsync ca-certificates gnupg xz-utils \
  debian-keyring debian-archive-keyring apt-transport-https >/dev/null
ok "base packages"
if [ "$MODE" = caddy ]; then
  if ! command -v caddy >/dev/null; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  fi
  ok "$(caddy version | head -1 | cut -d' ' -f1) (Caddy)"
fi
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
VITE_VAULT_URL="${VAULT_URL}/vault" npm run --silent build:public >/dev/null
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
  # Step 1 already refused to continue when $DATA has data but the key is missing.
  (umask 077; "$VENV/bin/python" -c 'import base64, secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())' > "$ETC/master-key")
  chown authtotp:authtotp "$ETC/master-key" && chmod 0400 "$ETC/master-key"
  ok "created $ETC/master-key (owner authtotp, 0400; not printed). Back it up offline together with the backups."
fi

# ---------------------------------------------------------------------------------------------- 7 env file
say "7/10 settings"
if [ -f "$ETC/env" ]; then
  ok "kept the existing $ETC/env (checked in step 1)"
else
  sed -e "s#https://vault\.example\.com#${VAULT_URL}#g" -e "s/vault\.example\.com/${VAULT_HOST}/g" \
    "$REPO/deploy/authtotp.env.example" > "$ETC/env.new"
  deploy_check env "$ETC/env.new" --vault-url "$VAULT_URL" \
    || { rm -f "$ETC/env.new"; fail "the generated settings failed their own check (installer bug; reason above)"; }
  chown root:authtotp "$ETC/env.new" && chmod 0640 "$ETC/env.new" && mv -f "$ETC/env.new" "$ETC/env"
  ok "wrote $ETC/env for ${VAULT_URL}"
fi
printf '# Written by deploy/install.sh on every run (not secret). A re-run with another HTTPS mode is refused.\nAUTHTOTP_HTTPS_MODE=%s\nAUTHTOTP_PUBLIC_URL=%s\nAUTHTOTP_VAULT_URL=%s\n' \
  "$MODE" "$PUBLIC_URL" "$VAULT_URL" > "$ETC/install.conf"
chmod 0644 "$ETC/install.conf"

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

# ---------------------------------------------------------------------------------------------- 9 HTTPS front
if [ "$MODE" = caddy ]; then
  say "9/10 Caddy"
  sed -e "s/totp\.example\.com/${PUBLIC_SITE}/g" -e "s/vault\.example\.com/${VAULT_SITE}/g" "$REPO/deploy/Caddyfile.example" > "$CADDY_SITE"
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
  ok "Caddy serves ${PUBLIC_HOST} (public tool) and ${VAULT_HOST} (vault)"
else
  say "9/10 reference configs for your HTTPS front"
  install -d -m 755 "$ETC/proxy"
  {
    printf '# Rendered by deploy/install.sh --external-https for %s and %s.\n' "$PUBLIC_URL" "$VAULT_URL"
    printf '# If this Caddy cannot obtain certificates itself (ports 80/443 unreachable), add a line\n'
    printf '#   tls <certificate file> <key file>\n# to both sites, with certificates that renew by themselves.\n\n'
    sed -e "s/totp\.example\.com/${PUBLIC_SITE}/g" -e "s/vault\.example\.com/${VAULT_SITE}/g" "$REPO/deploy/Caddyfile.example"
  } > "$ETC/proxy/Caddyfile"
  sed -e "s#https://totp\.example\.com#${PUBLIC_URL}#g" -e "s#https://vault\.example\.com#${VAULT_URL}#g" \
      -e "s/totp\.example\.com/${PUBLIC_HOST}/g" -e "s/vault\.example\.com/${VAULT_HOST}/g" \
      -e "s/443 ssl http2; # AuthTOTP public tool/${PUBLIC_PORT} ssl http2; # AuthTOTP public tool/" \
      -e "s/443 ssl http2; # AuthTOTP vault/${VAULT_PORT} ssl http2; # AuthTOTP vault/" \
      "$REPO/deploy/nginx.conf.example" > "$ETC/proxy/nginx.conf"
  chmod 644 "$ETC/proxy/Caddyfile" "$ETC/proxy/nginx.conf"
  ok "wrote $ETC/proxy/nginx.conf and $ETC/proxy/Caddyfile; no web server was changed"
fi

# ------------------------------------------------------------------------------------------------ 10 summary
say "10/10 done on this server"
ip4="$(curl -4 -s -m 5 https://api.ipify.org || true)"
if [ "$MODE" = caddy ]; then
  cat <<EOF
    Next (human steps, see AGENTS.md):
      1. DNS: A records  ${PUBLIC_HOST} -> ${ip4:-<server public IPv4>}  and  ${VAULT_HOST} -> ${ip4:-<same IP>}
         (DNS only; no CDN proxy, so Caddy can obtain certificates)
      2. First admin setup ONLY through an SSH tunnel:
           ssh -L 18473:127.0.0.1:18473 <you>@<this server>
           then open http://localhost:18473/vault , set the admin password, bind your authenticator app,
           and store the 10 recovery codes offline.
      3. Keep an offline copy of ${ETC}/master-key together with your backups (${DATA}/backups).
EOF
else
  cat <<EOF
    Next (see AGENTS.md §12; in this order):
      1. First admin setup NOW, through an SSH tunnel, before your HTTPS front goes live:
           ssh -L 18473:127.0.0.1:18473 <you>@<this server>
           then open http://localhost:18473/vault , set the admin password, bind your authenticator app,
           and store the 10 recovery codes offline.
      2. Your HTTPS front on this server: start from ${ETC}/proxy/nginx.conf or ${ETC}/proxy/Caddyfile.
         Keep every header and the X-Forwarded-For line; certificates must renew by themselves.
      3. DNS / port forwarding so ${PUBLIC_URL} and ${VAULT_URL} reach this server (public IPv4 ${ip4:-unknown}).
      4. Keep an offline copy of ${ETC}/master-key together with your backups (${DATA}/backups).
EOF
fi
