"""The provider seam: chart code depends on facts, never on a scanner."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from charts.contract import Bar


@dataclass(frozen=True)
class Capabilities:
    """What this provider has measured itself to serve."""
    source_id: str
    label: str
    delay_seconds: int | None
    resolutions: tuple[str, ...]
    note: str


@dataclass(frozen=True)
class DataHealth:
    """Last successful observation and any uncertainty that belongs with it."""
    latest_exchange_at: datetime | None
    last_receipt_at: datetime | None
    stale: bool
    history_reason: str | None = None


class ChartSource(Protocol):
    """Minimal history, latest data, symbol-list interface."""
    def capabilities(self) -> Capabilities: ...
    def catalog(self) -> tuple[str, ...]: ...
    def history(self, symbol: str, resolution: str,
                start: datetime | None, end: datetime | None,
                limit: int) -> tuple[Bar, ...]: ...
    def latest(self, symbols: tuple[str, ...], resolution: str) -> dict[str, Bar]: ...
    def health(self, symbol: str | None = None) -> DataHealth: ...
