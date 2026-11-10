"""The failure codes: the server and the web UI keep the same list, and a code lives and dies with its text."""
import re
from pathlib import Path

from orc import failures
from orc.models import TaskStatus

ROOT = Path(__file__).resolve().parents[1]


def test_web_knows_every_code_the_server_can_write():
    source = (ROOT / "web" / "src" / "failures.ts").read_text()
    block = re.search(r"FAILURE_CODES = \[(.*?)\] as const", source, re.S).group(1)
    assert re.findall(r'"(\w+)"', block) == list(failures.CODES)


def test_every_code_has_a_constant():
    values = {v for k, v in vars(failures).items() if k.isupper() and isinstance(v, str)}
    assert values == set(failures.CODES)


def test_code_is_stored_and_travels_in_the_task(repo, project):
    t = repo.add_task(project.id, "A", status="todo")
    t = repo.update_task(t.id, status=TaskStatus.FAILED, blocker_detail="raw git output", detail_code=failures.BRANCH_GONE)
    assert t.detail_code == "branch_gone" and t.blocker_detail == "raw git output"


def test_a_new_text_drops_the_old_code(repo, project):
    t = repo.add_task(project.id, "A", status="todo")
    repo.update_task(t.id, blocker_detail="old", detail_code=failures.SESSION_LOST)
    assert repo.update_task(t.id, blocker_detail="written by a path that knows no code").detail_code is None
    repo.update_task(t.id, blocker_detail="old", detail_code=failures.SESSION_LOST)
    assert repo.update_task(t.id, blocker_detail=None).detail_code is None


def test_other_updates_keep_the_code(repo, project):
    t = repo.add_task(project.id, "A", status="todo")
    repo.update_task(t.id, blocker_detail="old", detail_code=failures.QUOTA_LIMIT)
    assert repo.update_task(t.id, state_miss_count=0).detail_code == "quota_limit"
