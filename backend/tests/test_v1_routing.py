"""/v1 never falls back to the SPA; /code (colleague code page) does."""

from __future__ import annotations

import shutil

import pytest

from backend.app.config import settings


MESSAGE = "这是取码接口，请用 POST 调用；在浏览器里取码请打开发给你的取码页链接。"
URI = "otpauth://totp/GitHub%3Ademo-test?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
SECURITY_HEADERS = ("Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy")


@pytest.fixture()
def built_frontend(client):
    """Fake build in the test temp dir so an SPA fallback would be possible."""
    dist = settings.frontend_dist
    assert "authtotp-tests-" in str(dist)
    dist.mkdir(parents=True, exist_ok=True)
    (dist / "index.html").write_text("<!doctype html><title>AuthTOTP SPA</title>", encoding="utf-8")
    yield client
    shutil.rmtree(dist)


def assert_json_error(response, status: int, code: str) -> None:
    assert response.status_code == status
    assert response.headers["content-type"].startswith("application/json")
    assert response.headers["Cache-Control"] == "no-store"
    assert response.json()["error"]["code"] == code


@pytest.mark.parametrize(
    "path", ["/v1/totp/totp_abc/code", "/v1/totp/totp_abc/code?x=1", "/v1", "/v1/", "/v1/anything/else"]
)
def test_get_under_v1_is_405_json_not_spa(built_frontend, path):
    response = built_frontend.get(path)
    assert_json_error(response, 405, "METHOD_NOT_ALLOWED")
    assert response.json()["error"]["message"] == MESSAGE
    assert response.headers["Allow"] == "POST"
    assert "AuthTOTP SPA" not in response.text
    reference = built_frontend.get("/api/auth/status")
    for header in SECURITY_HEADERS:
        assert response.headers[header] == reference.headers[header], header


@pytest.mark.parametrize("method", ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_other_non_post_methods_are_405(built_frontend, method):
    response = built_frontend.request(method, "/v1/totp/totp_abc/code")
    assert response.status_code == 405
    assert response.headers["Allow"] == "POST"
    assert response.headers["Cache-Control"] == "no-store"
    if method != "HEAD":
        assert response.json()["error"]["code"] == "METHOD_NOT_ALLOWED"


@pytest.mark.parametrize(
    "path", ["/v1", "/v1/", "/v1/unknown", "/v1/totp/totp_abc", "/v1/totp/totp_abc/code/extra", "/v1/totp//code"]
)
def test_unknown_post_under_v1_is_404_json(built_frontend, path):
    response = built_frontend.post(path)
    assert_json_error(response, 404, "NOT_FOUND")
    assert "Allow" not in response.headers


def test_existing_post_code_endpoint_unchanged(admin_client):
    assert_json_error(admin_client.post("/v1/totp/totp_abc/code"), 401, "UNAUTHENTICATED")
    entry = admin_client.post("/api/entries", json={"otpauth_uri": URI}).json()
    caller = admin_client.post(
        "/api/callers", json={"name": "bot", "purpose": "t", "allowed_entry_ids": [entry["id"]]}
    ).json()
    response = admin_client.post(
        f"/v1/totp/{entry['id']}/code", headers={"Authorization": f"Bearer {caller['token']}"}
    )
    assert response.status_code == 200
    assert response.json()["code"].isdigit()
    missing = admin_client.post(
        "/v1/totp/totp_missing/code", headers={"Authorization": f"Bearer {caller['token']}"}
    )
    assert_json_error(missing, 404, "ENTRY_NOT_FOUND")


@pytest.mark.parametrize("path", ["/code", "/code?t=abc123", "/code/"])
def test_code_page_falls_back_to_spa(built_frontend, path):
    response = built_frontend.get(path)
    assert response.status_code == 200
    assert "AuthTOTP SPA" in response.text
    assert response.headers["Cache-Control"] == "no-store"
