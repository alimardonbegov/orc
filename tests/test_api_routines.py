"""HTTP endpoints of recurring tasks."""
import json
from datetime import datetime, timezone


def _create(client, project, **extra):
    body = {"project_id": project.id, "title": "Report", "description": "do A, B, C",
            "schedule_kind": "interval", "interval_minutes": 60, **extra}
    return client.post("/api/routines", json=body)


def test_create_computes_next_run_and_lists_with_stats(client, project):
    r = _create(client, project)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["enabled"] is True and body["archive_runs"] is True
    assert body["next_run_at"] is not None
    assert body["schedule_text"] == "every hour"
    assert body["stats"] == {"total": 0, "done": 0, "failed": 0, "active": 0, "skipped": 0}
    assert body["last_run"] is None
    listed = client.get("/api/routines", params={"project_id": project.id}).json()
    assert [x["id"] for x in listed] == [body["id"]]


def test_create_cron_drops_interval(client, project):
    r = _create(client, project, schedule_kind="cron", cron="0 9 * * 1-5", timezone="Europe/Moscow")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["interval_minutes"] is None and body["cron"] == "0 9 * * 1-5"
    # A slot in the future, exactly 9:00 Moscow time
    at = datetime.fromisoformat(body["next_run_at"])
    assert at > datetime.now(timezone.utc) and (at.hour, at.minute) == (6, 0)


def test_create_validates(client, project):
    assert _create(client, project, description="  ").status_code == 400
    assert _create(client, project, interval_minutes=1).status_code == 400
    assert _create(client, project, schedule_kind="cron", cron="* *").status_code == 400
    assert _create(client, project, schedule_kind="cron", cron="0 9 * * *", timezone="Nope/Zone").status_code == 400
    assert _create(client, project, permission_mode="yolo").status_code == 400
    assert _create(client, project, priority="urgent").status_code == 400
    assert _create(client, project, target_branch="no-such-branch").status_code == 400
    assert _create(client, project, max_runs=0).status_code == 422


def test_preview_returns_upcoming_slots(client):
    r = client.post("/api/routines/preview", json={"schedule_kind": "cron", "cron": "*/30 * * * *", "timezone": "UTC"})
    assert r.status_code == 200
    slots = [datetime.fromisoformat(s) for s in r.json()["next"]]
    assert len(slots) == 3 and all(s.minute in (0, 30) for s in slots)
    assert client.post("/api/routines/preview", json={"schedule_kind": "cron", "cron": "bad"}).status_code == 400


def test_pause_and_resume(client, repo, project):
    rid = _create(client, project).json()["id"]
    r = client.patch(f"/api/routines/{rid}", json={"enabled": False})
    assert r.status_code == 200 and r.json()["enabled"] is False and r.json()["next_run_at"] is None
    r = client.patch(f"/api/routines/{rid}", json={"enabled": True})
    assert r.json()["enabled"] is True and r.json()["next_run_at"] is not None
    messages = [e["message"] for e in repo.list_events()]
    assert any("paused" in m for m in messages) and any("resumed" in m for m in messages)


def test_patch_schedule_recomputes_next_run(client, project):
    created = _create(client, project).json()
    r = client.patch(f"/api/routines/{created['id']}", json={"schedule_kind": "cron", "cron": "0 3 * * *",
                                                             "timezone": "UTC"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["interval_minutes"] is None
    assert datetime.fromisoformat(body["next_run_at"]).hour == 3
    assert client.patch(f"/api/routines/{created['id']}", json={"cron": "oops"}).status_code == 400


def test_max_runs_reached_blocks_resume(client, repo, project):
    rid = _create(client, project, max_runs=1).json()["id"]
    assert client.post(f"/api/routines/{rid}/run").status_code == 201
    routine = repo.get_routine(rid)
    assert routine.run_count == 1 and not routine.enabled
    r = client.patch(f"/api/routines/{rid}", json={"enabled": True})
    assert r.status_code == 400 and "ceiling" in r.json()["detail"]
    r = client.patch(f"/api/routines/{rid}", json={"enabled": True, "max_runs": None})
    assert r.status_code == 200 and r.json()["enabled"] is True


def test_run_now_and_history(client, repo, project):
    rid = _create(client, project).json()["id"]
    r = client.post(f"/api/routines/{rid}/run")
    assert r.status_code == 201, r.text
    task_id = r.json()["task_id"]
    assert r.json()["routine"]["stats"]["active"] == 1
    # A second one in parallel: 409
    assert client.post(f"/api/routines/{rid}/run").status_code == 409
    # The run finished with a report: it is visible in the history
    report = {"status": "success", "summary": "all done", "notes": ""}
    repo.update_task(task_id, status="done", done_at="2026-10-07T12:30:00+00:00", report_json=json.dumps(report))
    runs = client.get(f"/api/routines/{rid}/runs").json()
    assert len(runs) == 1
    assert runs[0]["task_id"] == task_id and runs[0]["run"] == 1 and runs[0]["status"] == "done"
    assert runs[0]["report"]["summary"] == "all done"
    listed = client.get("/api/routines").json()[0]
    assert listed["stats"]["done"] == 1 and listed["last_run"]["task_id"] == task_id
    # The run card knows its routine
    card = client.get(f"/api/tasks/{task_id}").json()
    assert card["routine_id"] == rid and card["routine_run"] == 1


def test_delete_keeps_runs(client, repo, project):
    rid = _create(client, project).json()["id"]
    task_id = client.post(f"/api/routines/{rid}/run").json()["task_id"]
    assert client.delete(f"/api/routines/{rid}").status_code == 200
    assert client.get(f"/api/routines/{rid}").status_code == 404
    assert client.get(f"/api/tasks/{task_id}").json()["routine_id"] is None


def test_unknown_routine_404(client):
    assert client.get("/api/routines/999").status_code == 404
    assert client.patch("/api/routines/999", json={"enabled": False}).status_code == 404
    assert client.post("/api/routines/999/run").status_code == 404
    assert client.get("/api/routines/999/runs").status_code == 404
