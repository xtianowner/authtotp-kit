"""deploy/install.sh preflight: URL arguments and an existing /etc/authtotp/env, judged by the backend's own rules."""

from __future__ import annotations

import pytest

from backend.app.deploy_check import CheckError, check_env, main, parse_site, read_env_file, site_pair


VAULT = parse_site("vault.example.com", "--vault", external=False)
VAULT_8443 = parse_site("vault.example.com:8443", "--vault", external=True)
HOSTS = "AUTHTOTP_ALLOWED_HOSTS=vault.example.com,127.0.0.1,localhost\n"


def env(origins: str, hosts: str = HOSTS) -> str:
    return f"AUTHTOTP_DATA_DIR=/srv/authtotp/data\n{hosts}{origins}\nAUTHTOTP_COOKIE_SECURE=1\n"


# --------------------------------------------------------------------------------------------- URL arguments

@pytest.mark.parametrize(
    ("value", "external", "url", "site"),
    [
        ("vault.example.com", False, "https://vault.example.com", "vault.example.com"),
        ("Vault.Example.COM", False, "https://vault.example.com", "vault.example.com"),
        ("https://vault.example.com/", False, "https://vault.example.com", "vault.example.com"),
        ("https://vault.example.com:443", False, "https://vault.example.com", "vault.example.com"),
        ("vault.example.com:8443", True, "https://vault.example.com:8443", "vault.example.com:8443"),
        ("https://vault.example.com:8443", True, "https://vault.example.com:8443", "vault.example.com:8443"),
        ("vault.example.com", True, "https://vault.example.com", "vault.example.com"),
    ],
)
def test_site_accepts_domains_and_https_urls(value: str, external: bool, url: str, site: str) -> None:
    parsed = parse_site(value, "--vault", external)
    assert (parsed.url, parsed.host, parsed.site) == (url, "vault.example.com", site)


@pytest.mark.parametrize(
    ("value", "external", "reason"),
    [
        ("", False, "required"),
        ("vault.example.com:8443", False, "--external-https"),
        ("http://vault.example.com", True, "https"),
        ("ftp://vault.example.com", True, "must be a domain"),
        ("https://vault.example.com/vault", True, "no path"),
        ("https://vault.example.com/?q=1", True, "no path"),
        ("https://user@vault.example.com", True, "no path"),
        ("https://vault.example.com:99999", True, "no path"),
        ("203.0.113.10", True, "IP address"),
        ("localhost", True, "IP address"),
        ("vault_example.com", True, "IP address"),
    ],
)
def test_site_rejects_what_the_installer_cannot_serve(value: str, external: bool, reason: str) -> None:
    with pytest.raises(CheckError, match=reason):
        parse_site(value, "--vault", external)


def test_public_and_vault_need_different_hosts_not_just_ports() -> None:
    with pytest.raises(CheckError, match="different domains"):
        site_pair("vault.example.com:8443", "vault.example.com", external=True)
    public, vault = site_pair("totp.example.com:8443", "vault.example.com:8443", external=True)
    assert (public.site, vault.site) == ("totp.example.com:8443", "vault.example.com:8443")


# ----------------------------------------------------------------------------------- existing env: accepted

@pytest.mark.parametrize(
    "origins",
    [
        "AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com",
        "AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com,https://vault.example.com:24443",
        "AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com:24443,https://vault.example.com",
        "AUTHTOTP_ALLOWED_ORIGINS= https://vault.example.com , https://vault.example.com ,",
        "AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com:443",
        "AUTHTOTP_ALLOWED_ORIGINS=HTTPS://VAULT.EXAMPLE.COM/",
        'AUTHTOTP_ALLOWED_ORIGINS="https://vault.example.com,https://other.example.com"',
        "AUTHTOTP_ALLOWED_ORIGINS='https://vault.example.com'",
        "  AUTHTOTP_ALLOWED_ORIGINS = https://vault.example.com  ",
        "AUTHTOTP_ALLOWED_ORIGINS=https://wrong.example.com\nAUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com",
    ],
)
def test_env_with_the_vault_origin_passes(origins: str) -> None:
    check_env(env(origins), VAULT)


def test_env_with_crlf_line_endings_passes() -> None:
    check_env(env("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com").replace("\n", "\r\n"), VAULT)


def test_env_hosts_follow_trusted_host_wildcards() -> None:
    origins = "AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com"
    check_env(env(origins, "AUTHTOTP_ALLOWED_HOSTS=*.example.com,localhost\n"), VAULT)
    check_env(env(origins, "AUTHTOTP_ALLOWED_HOSTS=VAULT.example.com\n"), VAULT)


def test_env_for_a_custom_port_needs_that_exact_origin() -> None:
    with pytest.raises(CheckError, match="does not include https://vault.example.com:8443"):
        check_env(env("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com"), VAULT_8443)
    check_env(env("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com,https://vault.example.com:8443"), VAULT_8443)


# ----------------------------------------------------------------------------------- existing env: refused

@pytest.mark.parametrize(
    ("origins", "reason"),
    [
        ("", "missing or empty"),
        ("AUTHTOTP_ALLOWED_ORIGINS=", "missing or empty"),
        ("# AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com", "missing or empty"),
        ("; AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com", "missing or empty"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vaultXexample.com", "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://evilvault.example.com", "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com.evil.test", "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com:24443", "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=http://vault.example.com", "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com\nAUTHTOTP_ALLOWED_ORIGINS=https://x.example.com",
         "does not include"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com,vault.example.com", "not a full origin"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com,ftp://vault.example.com", "not a full origin"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com/vault", "not a full origin"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com:0x1bb", "not a full origin"),
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com # mine", "not a full origin"),
    ],
)
def test_env_without_a_valid_vault_origin_fails(origins: str, reason: str) -> None:
    with pytest.raises(CheckError, match=reason):
        check_env(env(origins), VAULT)


@pytest.mark.parametrize(
    "hosts",
    [
        "",
        "AUTHTOTP_ALLOWED_HOSTS=127.0.0.1,localhost\n",
        "AUTHTOTP_ALLOWED_HOSTS=vaultXexample.com\n",
        "AUTHTOTP_ALLOWED_HOSTS=*.vault.example.com\n",
    ],
)
def test_env_hosts_must_admit_the_vault_host(hosts: str) -> None:
    with pytest.raises(CheckError, match="AUTHTOTP_ALLOWED_HOSTS does not include vault.example.com"):
        check_env(env("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com", hosts), VAULT)


@pytest.mark.parametrize(
    ("line", "reason"),
    [
        ("AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com\\", "backslash"),
        ('AUTHTOTP_ALLOWED_ORIGINS="https://vault.example.com', "unbalanced quotes"),
        ("AUTHTOTP_ALLOWED_ORIGINS='https://vault.example.com\"", "unbalanced quotes"),
        ("export AUTHTOTP_ALLOWED_ORIGINS=https://vault.example.com", "not a KEY=value"),
        ("just some words", "not a KEY=value"),
    ],
)
def test_env_syntax_outside_the_supported_subset_is_refused(line: str, reason: str) -> None:
    with pytest.raises(CheckError, match=f"line 3.*{reason}"):
        read_env_file(env(line))


# ------------------------------------------------------------------------------------------------------- CLI

def test_cli_urls_prints_installer_variables(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["urls", "--public", "totp.example.com:8443", "--vault", "https://vault.example.com:8443",
                 "--external-https"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        "PUBLIC_URL=https://totp.example.com:8443",
        "PUBLIC_HOST=totp.example.com",
        "PUBLIC_PORT=8443",
        "PUBLIC_SITE=totp.example.com:8443",
        "VAULT_URL=https://vault.example.com:8443",
        "VAULT_HOST=vault.example.com",
        "VAULT_PORT=8443",
        "VAULT_SITE=vault.example.com:8443",
    ]


def test_cli_env_reports_the_problem_without_other_values(tmp_path, capsys: pytest.CaptureFixture[str]) -> None:
    path = tmp_path / "env"
    path.write_text(env("AUTHTOTP_ALLOWED_ORIGINS=https://other.example.com") + "AUTHTOTP_NOTE=do-not-echo-me\n")
    assert main(["env", str(path), "--vault-url", "https://vault.example.com"]) == 1
    captured = capsys.readouterr()
    assert "does not include https://vault.example.com" in captured.err
    assert "do-not-echo-me" not in captured.err + captured.out
    assert main(["env", str(tmp_path / "missing"), "--vault-url", "https://vault.example.com"]) == 1
