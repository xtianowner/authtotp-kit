from __future__ import annotations

import hashlib
import math
import secrets
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from contextlib import contextmanager
from threading import BoundedSemaphore, Lock
from time import monotonic, time
from typing import Callable, Iterator

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError


password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4)
NEVER_EXPIRES = "9999-12-31T23:59:59+00:00"

# Each Argon2 hash/verify allocates memory_cost (64 MiB). Process-wide cap on how many run at
# once, so a burst of password attempts cannot push the service past its memory limit.
ARGON2_SLOTS = 2
ARGON2_WAIT_SECONDS = 10.0
_argon2_slots = BoundedSemaphore(ARGON2_SLOTS)


class PasswordCheckBusy(Exception):
    """Every Argon2 slot stayed taken for the whole wait; the caller should answer 429."""


@contextmanager
def argon2_slot() -> Iterator[None]:
    if not _argon2_slots.acquire(timeout=ARGON2_WAIT_SECONDS):
        raise PasswordCheckBusy
    try:
        yield
    finally:
        _argon2_slots.release()


def utc_now() -> datetime:
    return datetime.now(UTC)


def iso_now() -> str:
    return utc_now().isoformat()


def hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def make_opaque_token(prefix: str = "") -> str:
    return f"{prefix}{secrets.token_urlsafe(32)}"


def hash_password(password: str) -> str:
    with argon2_slot():
        return password_hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    with argon2_slot():
        try:
            return password_hasher.verify(password_hash, password)
        except VerifyMismatchError:
            return False


def session_expiry(hours: int) -> str:
    return (utc_now() + timedelta(hours=hours)).isoformat()


def caller_expiry(hours: int) -> str:
    if hours <= 0:
        return NEVER_EXPIRES
    return session_expiry(hours)


def caller_is_expired(expires_at: str) -> bool:
    return expires_at != NEVER_EXPIRES and datetime.fromisoformat(expires_at).astimezone(UTC) <= utc_now()


class SlidingWindowRateLimiter:
    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str, limit: int, window_seconds: int = 60) -> bool:
        now = monotonic()
        with self._lock:
            events = self._events[key]
            while events and events[0] <= now - window_seconds:
                events.popleft()
            if len(events) >= limit:
                return False
            events.append(now)
            return True

    def clear(self) -> None:
        with self._lock:
            self._events.clear()


class GlobalFailureWindow:
    """Counts failures from every source together; locks once `limit` land inside the window."""

    def __init__(self, limit: int, window_seconds: int, clock: Callable[[], float] = monotonic) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self.clock = clock
        self._events: deque[float] = deque()
        self._lock = Lock()

    def _prune(self, now: float) -> None:
        while self._events and self._events[0] <= now - self.window_seconds:
            self._events.popleft()

    def retry_after(self) -> int:
        """Seconds until the lock lifts; 0 when not locked."""
        with self._lock:
            now = self.clock()
            self._prune(now)
            if len(self._events) < self.limit:
                return 0
            return max(1, math.ceil(self._events[0] + self.window_seconds - now))

    def record(self) -> None:
        with self._lock:
            now = self.clock()
            self._prune(now)
            self._events.append(now)

    def count(self) -> int:
        with self._lock:
            self._prune(self.clock())
            return len(self._events)

    def clear(self) -> None:
        with self._lock:
            self._events.clear()


class ClockMonitor:
    """Detects discontinuities between wall clock and monotonic time while running."""

    def __init__(self, tolerance_seconds: float = 3.0) -> None:
        self._tolerance = tolerance_seconds
        self._lock = Lock()
        self._wall = time()
        self._mono = monotonic()

    def healthy(self) -> bool:
        with self._lock:
            wall_elapsed = time() - self._wall
            mono_elapsed = monotonic() - self._mono
            return abs(wall_elapsed - mono_elapsed) <= self._tolerance

    def resync(self) -> None:
        """Rebase the comparison point after a sleep/wake or wall-clock jump."""
        with self._lock:
            self._wall = time()
            self._mono = monotonic()

    def ensure_healthy(self) -> bool:
        """Recover a stale baseline once, then require a healthy second check."""
        if self.healthy():
            return True
        self.resync()
        return self.healthy()


rate_limiter = SlidingWindowRateLimiter()
clock_monitor = ClockMonitor()
# Admin credential failures (login + second-factor checks), all sources combined.
admin_failure_window = GlobalFailureWindow(limit=30, window_seconds=3600)
