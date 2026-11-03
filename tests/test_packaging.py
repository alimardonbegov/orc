"""Running from an installed wheel: own defaults for data and UI, `orc doctor`."""
import pytest

from orc import config, main


def test_source_checkout_keeps_repo_data_and_web_dist(monkeypatch):
    # The clone currently in use must not silently move to an empty ~/.orc
    monkeypatch.setattr(config, "PACKAGED_STATIC", config.REPO_ROOT / "no-such-dir")
    assert config.running_from_source()
    assert config.default_data_dir() == config.REPO_ROOT / "data"
    assert config.default_static_dir() == config.REPO_ROOT / "web" / "dist"


def test_installed_package_uses_home_and_packaged_ui(monkeypatch, tmp_path):
    site = tmp_path / "site-packages"
    web = site / "orc" / "_web"
    web.mkdir(parents=True)
    monkeypatch.setattr(config, "REPO_ROOT", site)
    monkeypatch.setattr(config, "PACKAGED_STATIC", web)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert not config.running_from_source()
    assert config.default_data_dir() == tmp_path / "home" / ".orc"
    assert config.default_static_dir() == web


def test_orc_data_dir_wins_over_default(monkeypatch, tmp_path):
    monkeypatch.setenv("ORC_DATA_DIR", str(tmp_path / "d"))
    assert config.load_settings().data_dir == tmp_path / "d"


def _fake_claude(tmp_path, help_text: str):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "claude"
    script.write_text(f'#!/bin/sh\nif [ "$1" = "--help" ]; then echo "{help_text}"; else echo "9.9.9 (Claude Code)"; fi\n')
    script.chmod(0o755)
    return bin_dir


@pytest.mark.parametrize("help_text, code", [("  --bg, --background", 0), ("  --print", 1)])
def test_doctor_checks_claude_bg(monkeypatch, tmp_path, capsys, help_text, code):
    bin_dir = _fake_claude(tmp_path, help_text)
    monkeypatch.setenv("PATH", f"{bin_dir}:/usr/bin:/bin")
    monkeypatch.setenv("ORC_DATA_DIR", str(tmp_path / "data"))
    web = tmp_path / "web"
    web.mkdir()
    (web / "index.html").write_text("<html></html>")
    monkeypatch.setattr(main, "default_static_dir", lambda: web)
    assert main.doctor() == code
    out = capsys.readouterr().out
    assert "9.9.9" in out
    # The check creates nothing: the data directory appears only for serve/tick
    assert not (tmp_path / "data").exists()


def test_doctor_reports_missing_claude(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setattr(main, "default_static_dir", lambda: tmp_path / "missing")
    assert main.doctor() == 1
    out = capsys.readouterr().out
    assert "not found in PATH" in out and "no build" in out
