from datetime import datetime, timezone

import pytest

from orc import schedule

NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)


class _T:
    """Minimal task: the window functions need only these fields."""
    def __init__(self, start_after=None, start_before=None):
        self.id = 1
        self.start_after = start_after
        self.start_before = start_before


@pytest.mark.parametrize("raw, expected", [
    (None, None),
    ("", None),
    ("  ", None),
    ("2026-10-05T23:00:00Z", "2026-10-05T23:00:00+00:00"),
    ("2026-10-05T23:00:00.000Z", "2026-10-05T23:00:00+00:00"),
    ("2026-10-06T02:00:30+03:00", "2026-10-05T23:00:30+00:00"),
])
def test_normalize(raw, expected):
    assert schedule.normalize(raw) == expected


@pytest.mark.parametrize("raw", ["2026-10-05T23:00", "tomorrow", "2026-13-01T00:00:00Z"])
def test_normalize_rejects_naive_and_garbage(raw):
    with pytest.raises(ValueError):
        schedule.normalize(raw)


def test_validate_accepts_open_window_and_past_start():
    schedule.validate(None, None, NOW)
    schedule.validate("2026-10-05T10:00:00+00:00", None, NOW)  # a past "not before" = "can start immediately"
    schedule.validate("2026-10-05T10:00:00+00:00", "2026-10-05T13:00:00+00:00", NOW)


@pytest.mark.parametrize("after, before, message", [
    (None, "2026-10-05T13:00:00+00:00", "without a beginning"),
    ("2026-10-05T14:00:00+00:00", "2026-10-05T13:00:00+00:00", "later than its beginning"),
    ("2026-10-05T13:00:00+00:00", "2026-10-05T13:00:00+00:00", "later than its beginning"),
    ("2026-10-05T10:00:00+00:00", "2026-10-05T11:00:00+00:00", "already ended"),
])
def test_validate_rejects(after, before, message):
    with pytest.raises(ValueError, match=message):
        schedule.validate(after, before, NOW)


def test_is_waiting_and_is_expired():
    assert schedule.is_waiting(_T("2026-10-05T12:00:01+00:00"), NOW)
    assert not schedule.is_waiting(_T("2026-10-05T12:00:00+00:00"), NOW)  # the moment has come
    assert not schedule.is_waiting(_T(), NOW)
    assert schedule.is_expired(_T("2026-10-05T10:00:00+00:00", "2026-10-05T12:00:00+00:00"), NOW)
    assert not schedule.is_expired(_T("2026-10-05T10:00:00+00:00", "2026-10-05T12:00:01+00:00"), NOW)
    assert not schedule.is_expired(_T("2026-10-05T10:00:00+00:00"), NOW)


def test_garbage_in_db_is_neither_waiting_nor_expired():
    # A corrupted string in the database must not freeze the card or kill the tick
    assert not schedule.is_waiting(_T("garbage"), NOW)
    assert not schedule.is_expired(_T("2026-10-05T10:00:00+00:00", "garbage"), NOW)
    assert not schedule.is_waiting(_T("2026-10-05T23:00:00"), NOW)  # no timezone


def test_window_closed():
    assert schedule.window_closed("2026-10-05T12:00:00+00:00", NOW)
    assert not schedule.window_closed("2026-10-05T12:00:01+00:00", NOW)
    assert not schedule.window_closed(None, NOW)


def test_human():
    assert schedule.human("2026-10-05T23:00:00+00:00") == "2026-10-05 23:00 UTC"
    assert schedule.human(None) == "…"


def test_task_has_schedule_columns(repo, project):
    t = repo.add_task(project.id, "A", start_after="2026-10-05T23:00:00+00:00")
    t = repo.get_task(t.id)
    assert t.start_after == "2026-10-05T23:00:00+00:00" and t.start_before is None
