"""Cache-Control policy: hashed build assets are immutable, everything else is no-store."""

from __future__ import annotations

import shutil

import pytest

from backend.app.config import settings
from backend.app.main import IMMUTABLE_ASSET_CACHE, NO_STORE, _final_cache_control


HASHED_JS = "index-AbC_12-x.js"  # 8-char base64url hash that itself contains '-' and '_'
HASHED_CSS = "index-Dq9ZkP3w.css"
SECURITY_HEADERS = ("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy")


@pytest.fixture()
def built_frontend(client):
    """A fake Vite build in the test temp dir (settings.frontend_dist), never the project dist/."""
    dist = settings.frontend_dist
    assert "authtotp-tests-" in str(dist)
    (dist / "assets").mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text("<!doctype html><title>AuthTOTP</title>", encoding="utf-8")
    (dist / "assets" / HASHED_JS).write_text("console.log('app')\n" * 50, encoding="utf-8")
    (dist / "assets" / HASHED_CSS).write_text("body{}", encoding="utf-8")
    (dist / "assets" / "not-hashed.js").write_text("x", encoding="utf-8")
    (dist / "assets" / "logo-ab.svg").write_text("<svg/>", encoding="utf-8")
    (dist / "theme-init.js").write_text("document.documentElement.dataset.theme='light'", encoding="utf-8")
    (dist / "favicon-32.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (dist / "brand-AbCd1234.js").write_text("x", encoding="utf-8")  # hash-like, but outside assets/
    yield client
    shutil.rmtree(dist)


@pytest.mark.parametrize("name", [HASHED_JS, HASHED_CSS])
def test_hashed_assets_are_immutable_with_security_headers(built_frontend, name):
    response = built_frontend.get(f"/assets/{name}")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == IMMUTABLE_ASSET_CACHE
    html = built_frontend.get("/vault")
    for header in SECURITY_HEADERS:
        assert response.headers[header] == html.headers[header], header


def test_ranged_hashed_asset_keeps_immutable(built_frontend):
    response = built_frontend.get(f"/assets/{HASHED_JS}", headers={"Range": "bytes=0-9"})
    assert response.status_code == 206
    assert response.headers["Cache-Control"] == IMMUTABLE_ASSET_CACHE


@pytest.mark.parametrize(
    "path",
    [
        "/",
        "/vault",
        "/index.html",
        "/some/spa/route",
        "/assets/missing-AbCd1234.js",  # SPA fallback serves HTML, must not be cached
        "/assets/not-hashed.js",
        "/assets/logo-ab.svg",
        "/theme-init.js",
        "/favicon-32.png",
        "/brand-AbCd1234.js",
        "/assets/../theme-init.js",
    ],
)
def test_html_and_unhashed_files_stay_no_store(built_frontend, path):
    response = built_frontend.get(path)
    assert response.status_code == 200, path
    assert response.headers["Cache-Control"] == NO_STORE, path
    assert "Content-Security-Policy" in response.headers


def test_api_v1_and_health_stay_no_store(built_frontend):
    responses = [
        built_frontend.get("/health"),
        built_frontend.get("/api/auth/status"),
        built_frontend.get("/api/entries"),  # 401
        built_frontend.post("/v1/totp/totp_x/code"),  # 401
        built_frontend.post("/api/auth/bootstrap", json={"password": "short"}),  # 422
    ]
    assert [r.status_code for r in responses] == [200, 200, 401, 401, 422]
    for response in responses:
        assert response.headers["Cache-Control"] == NO_STORE


def test_long_cache_is_fail_closed_outside_assets():
    assert _final_cache_control("/assets/index-AbCd1234.js", IMMUTABLE_ASSET_CACHE) == IMMUTABLE_ASSET_CACHE
    # Even if some other route set the long-cache value, it is forced back to no-store.
    for path in ("/api/entries", "/v1/totp/x/code", "/health", "/vault", "/"):
        assert _final_cache_control(path, IMMUTABLE_ASSET_CACHE) == NO_STORE
    assert _final_cache_control("/assets/index-AbCd1234.js", None) == NO_STORE
    assert _final_cache_control("/assets/index-AbCd1234.js", "public, max-age=60") == NO_STORE
