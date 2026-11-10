"""The language of a handoff follows the task description: the default prompts do not force a language."""
from orc.prompt import CONFLICT_TEMPLATE
from orc.task_guide import HANDOFF_RULE

LANGUAGE_HINT = "in the same language as the task description"


def test_handoff_texts_ask_for_the_task_language():
    assert LANGUAGE_HINT in HANDOFF_RULE
    assert LANGUAGE_HINT in CONFLICT_TEMPLATE
