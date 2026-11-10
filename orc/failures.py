"""Why a card stopped, as a code that survives translation.

`blocker_detail` holds the technical text (git output, a lost state.json, the agent's own words). The code is stored
beside it in `tasks.detail_code`, so the web UI can say the reason in plain language in the owner's language and
suggest a next step, while the text stays behind a click. A card without a code (older rows, a failure no code
describes) shows its text as before.
"""
from __future__ import annotations

SESSION_LOST = "session_lost"
QUOTA_LIMIT = "quota_limit"
PROJECT_UNAVAILABLE = "project_unavailable"
BRANCH_GONE = "branch_gone"
CHECK_FAILED_AGAIN = "check_failed_again"
CONFLICT_UNRESOLVED = "conflict_unresolved"
STOPPED_BY_OWNER = "stopped_by_owner"
AGENT_REPORTED = "agent_reported"

# Keep in step with FAILURE_CODES in web/src/failures.ts: the web has a message and a hint for each.
CODES = (
    SESSION_LOST, QUOTA_LIMIT, PROJECT_UNAVAILABLE, BRANCH_GONE,
    CHECK_FAILED_AGAIN, CONFLICT_UNRESOLVED, STOPPED_BY_OWNER, AGENT_REPORTED,
)
