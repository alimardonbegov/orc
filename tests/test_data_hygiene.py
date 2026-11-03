"""Data directory permissions and the ceiling on the total size of attachments."""
import stat

import pytest


def test_data_dir_and_db_are_private(tmp_path, monkeypatch):
    from orc.config import load_settings
    from orc.db import connect

    monkeypatch.setenv("ORC_DATA_DIR", str(tmp_path / "d"))
    settings = load_settings()
    assert stat.S_IMODE(settings.data_dir.stat().st_mode) == 0o700
    conn = connect(settings.db_path)
    conn.close()
    assert stat.S_IMODE(settings.db_path.stat().st_mode) == 0o600
    # The WAL is created with the database file permissions: they are set BEFORE the journal is enabled
    wal = settings.db_path.with_name(settings.db_path.name + "-wal")
    if wal.exists():
        assert stat.S_IMODE(wal.stat().st_mode) == 0o600


def test_existing_data_dir_mode_is_fixed_on_start(tmp_path, monkeypatch):
    from orc.config import load_settings

    data = tmp_path / "d"
    data.mkdir(mode=0o755)
    monkeypatch.setenv("ORC_DATA_DIR", str(data))
    load_settings()
    assert stat.S_IMODE(data.stat().st_mode) == 0o700


def test_attachment_over_total_quota_is_rejected(repo, tmp_path):
    from orc.attachments import AttachmentError, AttachmentStore

    repo.set_setting("attachments_max_total_mb", "1")
    store = AttachmentStore(repo, tmp_path / "attachments")
    store.save("a.png", "image/png", b"\x89PNG" + b"a" * 700_000)
    with pytest.raises(AttachmentError) as e:
        store.save("b.png", "image/png", b"\x89PNG" + b"b" * 700_000)
    # The text shows both the ceiling and how much is used: otherwise it is unclear what to clean up
    assert "1 MB" in str(e.value) and "attachments use" in str(e.value)
    assert repo.attachments_total_size() == 700_004


def test_attachment_quota_setting_and_limits_endpoint(client):
    assert client.patch("/api/settings", json={"attachments_max_total_mb": "0"}).status_code == 400
    assert client.patch("/api/settings", json={"attachments_max_total_mb": "2"}).status_code == 200
    limits = client.get("/api/attachments-limits").json()
    assert limits["max_total_bytes"] == 2 * 1024 * 1024
    assert limits["used_bytes"] == 0
