from orc.config import Settings
from orc.main import build_runtime, parse_args


def test_parse_args_defaults():
    ns = parse_args(["serve"])
    assert ns.command == "serve" and ns.port == 8765 and ns.host == "127.0.0.1" and ns.open is False


def test_build_runtime_creates_db(tmp_path):
    settings = Settings(data_dir=tmp_path, jobs_dir=tmp_path / "jobs")
    repo, dispatcher = build_runtime(settings)
    assert (tmp_path / "orc.db").exists()
    assert dispatcher.status()["paused"] is False
    assert repo.list_projects() == []


def test_setup_logging_rotates_into_private_file(tmp_path):
    """.run/orc.log grew by a megabyte a day because nohup simply appends to the file."""
    import logging
    import logging.handlers
    import stat

    from orc.main import LOG_BACKUPS, LOG_MAX_BYTES, setup_logging

    path = tmp_path / "logs" / "orc.log"
    handler = setup_logging(str(path))
    try:
        assert isinstance(handler, logging.handlers.RotatingFileHandler)
        assert handler in logging.getLogger().handlers
        assert handler.maxBytes == LOG_MAX_BYTES
        assert handler.backupCount == LOG_BACKUPS
        logging.getLogger("orc.test").warning("line")
        handler.flush()
        assert "line" in path.read_text()
        # The log holds task submissions and repository paths: the file is not for everyone
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    finally:
        # Remove ONLY our own handler: the root logger has its own in pytest
        logging.getLogger().removeHandler(handler)
        handler.close()


def test_setup_logging_without_path_adds_no_file_handler():
    import logging
    import logging.handlers

    from orc.main import setup_logging

    assert setup_logging(None) is None
    assert not [h for h in logging.getLogger().handlers
                if isinstance(h, logging.handlers.RotatingFileHandler)]


def test_parse_args_reads_log_file_from_env(monkeypatch):
    from orc.main import parse_args

    monkeypatch.setenv("ORC_LOG_FILE", "/tmp/orc.log")
    assert parse_args(["serve"]).log_file == "/tmp/orc.log"
    assert parse_args(["serve", "--log-file", "/var/log/orc.log"]).log_file == "/var/log/orc.log"
