"""The report language follows the task description: the default prompts do not force a language."""
from orc.prompt import CONFLICT_TEMPLATE, DEFAULT_TEMPLATE

LANGUAGE_HINT = "Write summary and notes in the same language as the task description."


def test_default_prompts_ask_for_report_in_task_language():
    assert LANGUAGE_HINT in DEFAULT_TEMPLATE
    assert LANGUAGE_HINT in CONFLICT_TEMPLATE
