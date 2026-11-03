from datetime import datetime, timedelta, timezone


def iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).replace(microsecond=0).isoformat()


def _create(client, project, **extra):
    return client.post("/api/tasks", json={"project_id": project.id, "title": "A", "description": "x", **extra})


def test_create_with_schedule_normalizes_to_utc(client, project):
    r = _create(client, project, start_after="2099-01-01T03:00:00+03:00", start_before="2099-01-01T05:00:00Z")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["start_after"] == "2099-01-01T00:00:00+00:00"
    assert body["start_before"] == "2099-01-01T05:00:00+00:00"


def test_create_rejects_bad_pairs(client, project):
    assert _create(client, project, start_after="2099-01-01T03:00").status_code == 400  # no timezone
    assert _create(client, project, start_before=iso(timedelta(hours=1))).status_code == 400
    r = _create(client, project, start_after=iso(timedelta(hours=2)), start_before=iso(timedelta(hours=1)))
    assert r.status_code == 400 and "later than its beginning" in r.json()["detail"]


def test_patch_validates_resulting_pair(client, project):
    t = _create(client, project, start_after=iso(timedelta(hours=1)), start_before=iso(timedelta(hours=3))).json()
    # One new start with the old end: the pair is validated as a whole
    r = client.patch(f"/api/tasks/{t['id']}", json={"start_after": iso(timedelta(hours=4))})
    assert r.status_code == 400
    r = client.patch(f"/api/tasks/{t['id']}", json={"start_after": iso(timedelta(hours=2))})
    assert r.status_code == 200


def test_clear_schedule_start_now(client, project):
    t = _create(client, project, start_after=iso(timedelta(hours=1))).json()
    r = client.patch(f"/api/tasks/{t['id']}", json={"start_after": None, "start_before": None})
    assert r.status_code == 200 and r.json()["start_after"] is None


def test_schedule_locked_while_working(client, repo, project):
    # A schedule on a running task is an anomaly (the start clears it), but it still cannot be changed
    t = repo.add_task(project.id, "A", "x", status="in_progress", start_after=iso(timedelta(hours=1)))
    r = client.patch(f"/api/tasks/{t.id}", json={"start_after": iso(timedelta(hours=2))})
    assert r.status_code == 400
    t = repo.add_task(project.id, "A", "x", status="in_progress")
    # The form sends all fields: an unchanged (empty) schedule does not block the edit
    r = client.patch(f"/api/tasks/{t.id}", json={"title": "B", "start_after": None, "start_before": None})
    assert r.status_code == 200


def test_patch_other_field_with_expired_window_is_ok(client, repo, project):
    past_a, past_b = iso(timedelta(hours=-3)), iso(timedelta(hours=-1))
    t = repo.add_task(project.id, "A", "x", start_after=past_a, start_before=past_b)  # backlog
    r = client.patch(f"/api/tasks/{t.id}", json={"title": "B", "start_after": past_a, "start_before": past_b})
    assert r.status_code == 200, r.text


def test_move_to_todo_with_expired_window_is_rejected(client, repo, project):
    t = repo.add_task(project.id, "A", "x", start_after=iso(timedelta(hours=-3)), start_before=iso(timedelta(hours=-1)))
    r = client.patch(f"/api/tasks/{t.id}", json={"status": "todo"})
    assert r.status_code == 400 and "start window" in r.json()["detail"]
    # The same PATCH can both adjust the window and send the task to work
    r = client.patch(f"/api/tasks/{t.id}", json={"status": "todo", "start_after": None, "start_before": None})
    assert r.status_code == 200 and r.json()["status"] == "todo"


def test_retry_with_expired_window_is_rejected(client, repo, project):
    t = repo.add_task(project.id, "A", "x", status="failed",
                      start_after=iso(timedelta(hours=-3)), start_before=iso(timedelta(hours=-1)))
    r = client.post(f"/api/tasks/{t.id}/retry")
    assert r.status_code == 400 and "start window" in r.json()["detail"]


def test_stale_form_after_task_started_drops_schedule_silently(client, repo, project):
    # The edit form is open on a waiting task; the dispatcher started it and cleared the schedule.
    t = repo.add_task(project.id, "A", "x", status="in_progress")
    r = client.patch(f"/api/tasks/{t.id}", json={"title": "B", "start_after": iso(timedelta(hours=1))})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "B" and body["start_after"] is None


def test_garbage_schedule_in_db_does_not_block_save(client, repo, project):
    t = repo.add_task(project.id, "A", "x", start_after="garbage")
    r = client.patch(f"/api/tasks/{t.id}", json={"title": "B", "start_after": "garbage"})
    assert r.status_code == 200, r.text
    assert r.json()["title"] == "B"
