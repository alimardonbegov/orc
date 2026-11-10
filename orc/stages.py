"""Stages among subtasks: the one place that turns a stage number into "waits for".

A subtask may carry a stage number. A card of stage N starts only when every sibling (a card with the same
parent) of the nearest lower stage is done, which means merged. Stage is not stored as links: the blockers are
derived here from `(id, parent, stage)`, so the dispatcher, the API and the web tree read the same answer and
cannot drift apart. A card without a stage, or without a parent, is not part of any stage.

Derived blockers are kept apart from `task_deps`: those are the owner's own wiring, editable in the picker.
The pure functions below take plain tuples, so they run on a virtual card that does not exist yet.
"""
from __future__ import annotations

from collections.abc import Iterable, Mapping

# (card id, parent card id, stage); None where the card has no parent or no stage
Node = tuple[int, int | None, int | None]


def stage_blockers(nodes: Iterable[Node]) -> dict[int, list[int]]:
    """For every card that is in a stage and has an earlier one: the cards of the previous populated stage.

    "Previous populated" skips an empty number: stages 1 and 3 mean 3 follows 1. A card of the first stage
    waits for nothing and is absent from the result. The state of the blockers is not read here: a failed card
    is simply not done, so it holds the next stage like any other unfinished one.
    """
    groups: dict[int, dict[int, list[int]]] = {}
    for card_id, parent, stage in nodes:
        if parent is None or stage is None or parent == card_id:
            continue
        groups.setdefault(parent, {}).setdefault(stage, []).append(card_id)
    result: dict[int, list[int]] = {}
    for by_stage in groups.values():
        order = sorted(by_stage)
        for prev, stage in zip(order, order[1:]):
            blockers = sorted(by_stage[prev])
            for card_id in by_stage[stage]:
                result[card_id] = blockers
    return result


def effective_deps(explicit: Mapping[int, list[int]], derived: Mapping[int, list[int]]) -> dict[int, list[int]]:
    """The owner's links and the stage blockers as one graph: what the scheduler and the ring check read."""
    merged: dict[int, list[int]] = {k: list(v) for k, v in explicit.items()}
    for card_id, blockers in derived.items():
        seen = merged.setdefault(card_id, [])
        seen.extend(b for b in blockers if b not in seen)
    return merged


def closes_ring(card_id: int, nodes: Iterable[Node], explicit: Mapping[int, list[int]]) -> bool:
    """Whether the card waits, through any chain of links and stages, for itself.

    Every edge a change adds touches the changed card, so one walk from it is enough. A ring would freeze its
    cards forever without a message, which is why the API refuses to build one.
    """
    graph = effective_deps(explicit, stage_blockers(nodes))
    seen: set[int] = set()
    stack = list(graph.get(card_id, []))
    while stack:
        current = stack.pop()
        if current == card_id:
            return True
        if current in seen:
            continue
        seen.add(current)
        stack.extend(graph.get(current, []))
    return False
