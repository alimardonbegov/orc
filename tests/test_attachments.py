"""Images in the task text: storage, marker expansion, API endpoints."""
import base64

import pytest

from orc.attachments import MAX_BYTES, AttachmentError, AttachmentStore, expand_description, marker, marker_ids

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture
def store(repo, tmp_path):
    return AttachmentStore(repo, tmp_path / "attachments")


# ---------- markers ----------

def test_marker_strips_characters_that_break_markdown_parsing():
    assert marker(7, "shot [button] (left)") == "![shot  button   left](orc-image:7)"


def test_marker_ids_in_order_of_appearance():
    text = f"before {marker(3)} between {marker(1)} after"
    assert marker_ids(text) == [3, 1]


def test_description_without_markers_is_unchanged():
    assert expand_description("plain text", lambda _: ("/tmp/x.png", "x.png")) == "plain text"
    assert expand_description("", lambda _: None) == ""


def test_marker_expands_to_path_in_place():
    text = f"top\n{marker(5, 'button')}\nbottom"
    out = expand_description(text, lambda i: (f"/data/{i}.png", "shot.png"))
    lines = out.splitlines()
    assert lines[0] == "top"
    assert lines[1] == "[Image 1: /data/5.png — «button»]"
    assert lines[2] == "bottom"


def test_numbering_is_sequential_and_caption_defaults_to_filename():
    text = f"{marker(5)} and {marker(9)}"
    out = expand_description(text, lambda i: (f"/data/{i}.png", f"f{i}.png"))
    assert "[Image 1: /data/5.png — «f5.png»]" in out
    assert "[Image 2: /data/9.png — «f9.png»]" in out


def test_hint_is_appended_only_when_images_present():
    with_image = expand_description(marker(1), lambda i: ("/a.png", "a.png"))
    assert "# Images" in with_image
    assert "Read" in with_image
    assert "# Images" not in expand_description("text", lambda i: ("/a.png", "a.png"))


def test_missing_attachment_does_not_break_prompt():
    out = expand_description(f"look {marker(42)}", lambda _: None)
    assert "[Image 1: file not found]" in out


# ---------- storage ----------

def test_save_stores_file_and_row(store):
    row = store.save("shot.png", "image/png", PNG)
    assert row["filename"] == "shot.png" and row["mime"] == "image/png" and row["size"] == len(PNG)
    assert store.path(row).read_bytes() == PNG


def test_identical_content_is_not_duplicated_on_disk(store, tmp_path):
    a = store.save("a.png", "image/png", PNG)
    b = store.save("b.png", "image/png", PNG)
    assert a["id"] != b["id"]
    assert a["rel_path"] == b["rel_path"]
    assert len(list((tmp_path / "attachments").iterdir())) == 1


def test_foreign_format_and_empty_file_are_rejected(store):
    with pytest.raises(AttachmentError):
        store.save("doc.pdf", "application/pdf", PNG)
    with pytest.raises(AttachmentError):
        store.save("empty.png", "image/png", b"")


def test_oversized_file_is_rejected(store):
    with pytest.raises(AttachmentError):
        store.save("big.png", "image/png", b"x" * (MAX_BYTES + 1))


def test_invalid_base64_is_rejected(store):
    with pytest.raises(AttachmentError):
        store.save_base64("x.png", "image/png", "not-base64!!")


def test_resolve_returns_absolute_path_and_none_when_missing(store):
    row = store.save("shot.png", "image/png", PNG)
    path, name = store.resolve(row["id"])
    assert path.endswith(row["rel_path"]) and name == "shot.png"
    assert store.resolve(row["id"] + 100) is None
    store.path(row).unlink()
    assert store.resolve(row["id"]) is None


# ---------- API ----------

def _upload(client, name="shot.png", mime="image/png", data=None):
    return client.post("/api/attachments", json={
        "filename": name, "mime": mime, "data": base64.b64encode(data if data is not None else PNG).decode(),
    })


def test_api_upload_and_download_file(client):
    res = _upload(client)
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["url"] == f"/api/attachments/{body['id']}"
    got = client.get(body["url"])
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-type"].startswith("image/png")


def test_api_rejects_non_image(client):
    assert _upload(client, name="d.pdf", mime="application/pdf").status_code == 400


def test_api_nonexistent_attachment(client):
    assert client.get("/api/attachments/999").status_code == 404


def test_api_limits_match_input_validation(client):
    body = client.get("/api/attachments-limits").json()
    assert body["max_bytes"] == MAX_BYTES and "image/png" in body["mime"]


def test_task_description_keeps_marker_as_is(client, project):
    res = client.post("/api/tasks", json={"project_id": project.id, "title": "t",
                                          "description": f"here {marker(1, 'shot')}"})
    assert res.status_code == 201
    assert "orc-image:1" in res.json()["description"]


# ---------- delivery to the session ----------

def test_launch_prompt_gets_image_path(repo, dispatcher, fake_cli, project):
    row = dispatcher.attachments.save("shot.png", "image/png", PNG)
    task = repo.add_task(project.id, "Fix the button",
                         f"here is what is wrong:\n{marker(row['id'], 'button')}\nfix it", status="todo")
    dispatcher.tick()
    prompt = fake_cli.calls[0][2]
    assert str(dispatcher.attachments.path(row).resolve()) in prompt
    assert "orc-image:" not in prompt          # the raw marker does not reach the session
    assert "# Images" in prompt
    # The description on the board keeps the marker: the card draws the image from it
    assert "orc-image:" in repo.get_task(task.id).description


def test_session_message_expands_image_but_comment_does_not(repo, dispatcher, fake_cli, project):
    row = dispatcher.attachments.save("shot.png", "image/png", PNG)
    task = repo.add_task(project.id, "t", "d", status="todo")
    dispatcher.tick()
    text = f"look {marker(row['id'])}"
    dispatcher.answer(task.id, text)
    assert repo.list_comments(task.id)[-1]["body"] == text
    queued = repo.list_messages(task.id)[-1]["body"]
    assert str(dispatcher.attachments.path(row).resolve()) in queued
