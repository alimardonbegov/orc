from datetime import datetime, timezone

from orc.util import now_iso, utc_now


def test_now_iso_is_utc_iso_string():
    value = now_iso()
    parsed = datetime.fromisoformat(value)
    assert parsed.tzinfo is not None
    assert parsed.utcoffset().total_seconds() == 0


def test_utc_now_has_timezone():
    assert utc_now().tzinfo == timezone.utc
