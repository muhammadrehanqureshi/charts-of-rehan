"""The three data sources: real tape, delayed portal, and explicit replay."""

from charts.adapters.base import Capabilities, ChartSource, DataHealth
from charts.adapters.portal import PortalSource
from charts.adapters.replay import ReplaySource
from charts.adapters.tape import TapeSource

SOURCES = {"tape": TapeSource, "portal": PortalSource, "replay": ReplaySource}

__all__ = ["Capabilities", "ChartSource", "DataHealth", "PortalSource",
           "ReplaySource", "SOURCES", "TapeSource"]
