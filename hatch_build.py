"""Wheel build hook: puts the built SPA (web/dist) into the package as orc/_web.

web/dist is in .gitignore, and hatchling drops everything ignored by default, so without
this hook the wheel ships without the UI and the recipient's control room answers a bare 404.
force-include directly in pyproject.toml does not work: when web/dist is missing it also
breaks the editable install (`uv sync` on a fresh clone, a Docker image build before the
frontend step). So the directory is added only for a regular wheel, where its absence is an error.
"""
from __future__ import annotations

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        if self.target_name != "wheel" or version == "editable":
            return
        dist = Path(self.root) / "web" / "dist"
        if not (dist / "index.html").is_file():
            raise RuntimeError(
                f"the built UI is missing in {dist}: run `make build` first "
                f"(or build the package via `make package`)")
        build_data["force_include"][str(dist)] = "orc/_web"
