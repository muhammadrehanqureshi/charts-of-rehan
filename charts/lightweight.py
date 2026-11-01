"""Hard machine budget for Charts of Rehan.

The service is a guest on the owner's PC. These are floors and defaults, not
tuning suggestions; the tests assert them so a future change cannot quietly
turn the chart terminal into a machine hog.

The one deliberate exception is the open chart's SSE stream, which may tick at
most once per second only while the browser tab is visible. Everything else
here is slower.
"""
from __future__ import annotations

#: Source polls default to this cadence per watched symbol.
DEFAULT_INGEST_SECONDS = 15.0

#: A caller cannot tune source polling below this floor.
MIN_INGEST_SECONDS = 5.0

#: The decade maintenance pass is cheap and runs this often.
EOD_MAINTENANCE_SECONDS = 15 * 60.0
