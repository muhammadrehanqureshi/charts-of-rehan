"""The public company page: a measured, delayed daily data source.

It serves only the session bar advertised by the exchange portal. The scraper
uses standard-library HTTP and HTML parsing, with a bounded rate limiter. A
panel that is empty or explicitly not found is an EMPTY_ACK rather than a
synthetic zero bar.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

from charts.adapters.base import Capabilities, DataHealth
from charts.contract import Bar, iso, normalize_symbol
from charts.ratelimit import (CircuitBreaker, CircuitOpen, RateLimited,
                              RetryPolicy, TokenBucket, UpstreamError,
                              upstream_call)

BASE_URL = "https://dps.psx.com.pk/company/"
DELAY_SECONDS = 300
MAX_RESPONSE_BYTES = 1_000_000


class PortalSource:
    """Fetch one exchange daily snapshot; does not claim intraday history."""
    def __init__(self, symbols: tuple[str, ...], *, timeout: float = 5.0,
                 min_interval: float = 2.0, now: Callable = datetime.now,
                 opener: Callable = urlopen):
        self.symbols = tuple(normalize_symbol(item) for item in symbols)
        self.timeout, self.now, self.opener = timeout, now, opener
        self._bucket = TokenBucket(min_interval)
        self._breaker = CircuitBreaker()
        self._retry = RetryPolicy(attempts=2)

    def capabilities(self) -> Capabilities:
        return Capabilities("portal", "PSX public company page", DELAY_SECONDS,
                            ("session",), "one delayed session observation; "
                            "not an intraday series")

    def catalog(self) -> tuple[str, ...]:
        return self.symbols

    def _fetch(self, symbol: str) -> Bar:
        self._bucket.acquire()
        url = BASE_URL + quote(symbol, safe="")
        request = Request(url, headers={"User-Agent": "ChartsOfRehan/0.1"})
        with self.opener(request, timeout=self.timeout) as response:
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise UpstreamError("exchange response too large", code="BAD_PAYLOAD")
        return parse_portal_body(body, symbol, self.now())

    def history(self, symbol: str, resolution: str, start: datetime | None,
                end: datetime | None, limit: int = 500) -> tuple[Bar, ...]:
        ...

[Search result truncated at 12500 chars]