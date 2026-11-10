"""Saved board views: a name and a set of board filters, kept per project on the server.

The filters are exactly what the board header can hold. They are validated against a whitelist here, so
a stored view never carries a key or a value the board does not understand.
"""
from __future__ import annotations

import json

NAME_MAX = 60
DONE_SORTS = ("recent", "oldest", "failed")

DEFAULT_FILTERS: dict = {
    "search": "",
    "attention_only": False,
    "label_id": None,
    "show_done": True,
    "show_archived": False,
    "done_sort": "recent",
}


def normalize_name(raw: str) -> str:
    name = " ".join(raw.split())
    if not name:
        raise ValueError("view name must not be blank")
    if len(name) > NAME_MAX:
        raise ValueError(f"view name is longer than {NAME_MAX} characters")
    return name


def normalize_filters(raw: dict) -> dict:
    """The full filter set: missing keys take their defaults, unknown keys and wrong types are refused."""
    unknown = sorted(set(raw) - set(DEFAULT_FILTERS))
    if unknown:
        raise ValueError(f"unknown filters: {unknown}")
    out = {**DEFAULT_FILTERS, **raw}
    if not isinstance(out["search"], str) or len(out["search"]) > 200:
        raise ValueError("search: expected a string of up to 200 characters")
    out["search"] = out["search"].strip()
    for key in ("attention_only", "show_done", "show_archived"):
        if not isinstance(out[key], bool):
            raise ValueError(f"{key}: expected true or false")
    label = out["label_id"]
    if label is not None and (isinstance(label, bool) or not isinstance(label, int)):
        raise ValueError("label_id: expected a label id or null")
    if out["done_sort"] not in DONE_SORTS:
        raise ValueError(f"done_sort: expected one of {list(DONE_SORTS)}")
    return out


def dump(filters: dict) -> str:
    return json.dumps(filters, sort_keys=True)


def view_out(row: dict, known_labels: set[int]) -> dict:
    """A stored row for the API. A label deleted since the view was saved reads as no label filter."""
    try:
        filters = normalize_filters(json.loads(row["filters_json"]))
    except (ValueError, TypeError):
        filters = dict(DEFAULT_FILTERS)  # a damaged row still opens, as an empty filter
    if filters["label_id"] is not None and filters["label_id"] not in known_labels:
        filters["label_id"] = None
    return {"id": row["id"], "project_id": row["project_id"], "name": row["name"], "filters": filters,
            "created_at": row["created_at"]}
