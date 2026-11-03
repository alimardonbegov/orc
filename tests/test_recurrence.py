from datetime import datetime, timezone

import pytest

from orc import recurrence

UTC = timezone.utc


def at(*args, tz=UTC):
    return datetime(*args, tzinfo=tz)


@pytest.mark.parametrize("expr, after, expected", [
    # every 15 minutes
    ("*/15 * * * *", at(2026, 10, 7, 12, 7), at(2026, 10, 7, 12, 15)),
    # strictly later: exactly on a slot gives the next one
    ("*/15 * * * *", at(2026, 10, 7, 12, 15), at(2026, 10, 7, 12, 30)),
    # every hour at :00
    ("0 * * * *", at(2026, 10, 7, 12, 0, 30), at(2026, 10, 7, 13, 0)),
    # daily at 9:00, today's has already passed
    ("0 9 * * *", at(2026, 10, 7, 10, 0), at(2026, 10, 8, 9, 0)),
    # on weekdays (2026-10-10 is a Saturday) at 9:00
    ("0 9 * * 1-5", at(2026, 10, 9, 10, 0), at(2026, 10, 12, 9, 0)),
    # Sunday as 7 and as 0
    ("30 8 * * 7", at(2026, 10, 7, 0, 0), at(2026, 10, 11, 8, 30)),
    ("30 8 * * 0", at(2026, 10, 7, 0, 0), at(2026, 10, 11, 8, 30)),
    # first day of the month
    ("0 0 1 * *", at(2026, 10, 7, 0, 0), at(2026, 11, 1, 0, 0)),
    # crossing the year boundary
    ("0 0 1 1 *", at(2026, 10, 7, 0, 0), at(2027, 1, 1, 0, 0)),
    # lists and a range with a step
    ("5,35 10-14/2 * * *", at(2026, 10, 7, 10, 36), at(2026, 10, 7, 12, 5)),
    # February 29: the nearest leap year
    ("0 12 29 2 *", at(2026, 10, 7, 0, 0), at(2028, 2, 29, 12, 0)),
    # day of month AND day of week restricted: either is enough (cron rule): the 13th or a Friday
    ("0 0 13 * 5", at(2026, 10, 7, 0, 0), at(2026, 10, 9, 0, 0)),
])
def test_next_cron_utc(expr, after, expected):
    assert recurrence.next_cron(expr, "UTC", after) == expected


def test_next_cron_reads_local_time_of_zone():
    # 9:00 Moscow time (UTC+3) is 6:00 UTC
    got = recurrence.next_cron("0 9 * * *", "Europe/Moscow", at(2026, 10, 7, 7, 0))
    assert got == at(2026, 10, 8, 6, 0)


def test_next_cron_across_dst_switch():
    # Berlin: on October 25, 2026 the clocks go back from 3:00 summer time to 2:00 winter time.
    # 9:00 before the change is 7:00 UTC, after it 8:00 UTC.
    first = recurrence.next_cron("0 9 * * *", "Europe/Berlin", at(2026, 10, 24, 0, 0))
    second = recurrence.next_cron("0 9 * * *", "Europe/Berlin", first)
    assert first == at(2026, 10, 24, 7, 0)
    assert second == at(2026, 10, 25, 8, 0)


@pytest.mark.parametrize("expr", [
    "", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *",
    "* * * * 8", "*/0 * * * *", "a * * * *", "5-1 * * * *", "1,,2 * * * *",
])
def test_parse_cron_rejects(expr):
    with pytest.raises(ValueError):
        recurrence.parse_cron(expr)


def test_impossible_cron_does_not_loop_forever():
    with pytest.raises(ValueError, match="never fires"):
        recurrence.next_cron("0 0 30 2 *", "UTC", at(2026, 10, 7))


def test_check_rules():
    recurrence.check("interval", 60, None, None)
    recurrence.check("cron", None, "0 9 * * 1-5", "Europe/Moscow")
    for args in [("weekly", 60, None, None), ("interval", None, None, None), ("interval", 1, None, None),
                 ("cron", None, "", None), ("cron", None, "0 9 * * *", "Mars/Olympus"),
                 ("cron", None, "0 0 31 2 *", None)]:
        with pytest.raises(ValueError):
            recurrence.check(*args)


def test_interval_and_upcoming():
    start = at(2026, 10, 7, 12, 0, 0)
    assert recurrence.next_run("interval", 90, None, None, start) == at(2026, 10, 7, 13, 30)
    slots = recurrence.upcoming("interval", 60, None, None, start, count=3)
    assert slots == [at(2026, 10, 7, 13), at(2026, 10, 7, 14), at(2026, 10, 7, 15)]


@pytest.mark.parametrize("minutes, text", [(15, "every 15 min"), (60, "every hour"), (120, "every 2 h"), (1440, "every day"), (2880, "every 2 days")])
def test_describe_interval(minutes, text):
    assert recurrence.describe("interval", minutes, None, None) == text
