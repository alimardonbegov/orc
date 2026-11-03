"""Event feed retention: old events are deleted, fresh ones and comments are not."""
from datetime import timedelta

from orc.util import utc_now


def _event_at(repo, message, at):
    row = repo.add_event(message)
    repo.conn.execute("UPDATE events SET created_at = ? WHERE id = ?",
                      (at.replace(microsecond=0).isoformat(), row["id"]))
    repo.conn.commit()
    return row


def test_cleanup_removes_old_events_only(repo, dispatcher):
    now = utc_now()
    _event_at(repo, "ancient", now - timedelta(days=40))
    _event_at(repo, "yesterday", now - timedelta(days=1))

    dispatcher._cleanup()

    messages = [e["message"] for e in repo.list_events()]
    assert "yesterday" in messages
    assert "ancient" not in messages


def test_cleanup_runs_once_a_day(repo, dispatcher):
    now = utc_now()
    _event_at(repo, "ancient", now - timedelta(days=40))
    dispatcher._cleanup()
    _event_at(repo, "even more ancient", now - timedelta(days=41))
    # A second pass on the same day does not repeat the cleanup: it is not urgent work,
    # and on a big feed DELETE takes noticeable time
    dispatcher._cleanup()
    assert "even more ancient" in [e["message"] for e in repo.list_events()]


def test_zero_retention_disables_cleanup(repo, dispatcher):
    repo.set_setting("events_retention_days", "0")
    _event_at(repo, "ancient", utc_now() - timedelta(days=400))
    dispatcher._cleanup()
    assert "ancient" in [e["message"] for e in repo.list_events()]


def test_cleanup_keeps_comments(repo, dispatcher, project):
    task = repo.add_task(project.id, "A")
    repo.add_comment(task.id, "user", "comment", "conversation")
    repo.conn.execute("UPDATE comments SET created_at = ?", ((utc_now() - timedelta(days=400)).isoformat(),))
    repo.conn.commit()
    dispatcher._cleanup()
    assert [c["body"] for c in repo.list_comments(task.id)] == ["conversation"]


def test_cleanup_is_a_tick_step(client, dispatcher):
    dispatcher.tick()
    assert "_cleanup" in client.get("/api/dispatcher").json()["last_tick_steps"]
