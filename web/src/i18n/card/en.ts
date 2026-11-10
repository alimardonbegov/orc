export const cardEn = {
  "search": "Search",
  "searchIn": "Search: {label}",
  "nothingFound": "Nothing found",
  "agent": {
    "label": "Assignee",
    "none": "Unassigned",
    "noneHint": "A person works on it: the card does not go to work",
    "noAgents": "No agents yet. A card goes to work only with an agent assigned.",
    "create": "Create an agent"
  },
  "priority": {
    "label": "Priority"
  },
  "branch": {
    "label": "Branch"
  },
  "dependsOn": {
    "label": "Waits for",
    "none": "Nothing"
  },
  "labels": {
    "label": "Labels",
    "none": "No labels",
    "searchLabel": "Find or create a label",
    "searchPlaceholder": "Search or type a new label",
    "empty": "No labels yet. Type a name to create one.",
    "create": "Create \"{name}\""
  },
  "startDate": {
    "label": "Start date"
  },
  "dueDate": {
    "label": "Due date",
    "overdue": "Overdue"
  },
  "date": {
    "clear": "Clear date"
  },
  "status": {
    "label": "Status",
    "lockedHint": "A working card is moved by its session, not by hand"
  },
  "addProperty": "Add property",
  "details": {
    "createdBy": "Created by",
    "byCard": "Agent of card #{id}",
    "byRoutine": "Routine, run {run}",
    "byOwner": "Owner",
    "updated": "Updated",
    "finished": "Finished"
  },
  "relations": {
    "heading": "Relations",
    "viewLabel": "Show relations as",
    "list": "List",
    "tree": "Tree",
    "chain": "The whole chain",
    "comesNext": "Comes next",
    "subtasks": "Subtasks",
    "noSubtasks": "No subtasks",
    "wake": "Wake this card when all subtasks are done",
    "wakeHint": "The card goes back to the queue once, to check the result. A failed subtask holds it. Off unless you turn it on.",
    "addSubtask": "New subtask",
    "attach": "Attach an existing card as a subtask",
    "attachEmpty": "No cards to attach",
    "detach": "Take #{id} out of the subtasks",
    "editWaits": "Change what it waits for",
    "gone": "archived or deleted",
    "failedHint": "#{id} failed: it holds this card until it is fixed",
    "thisCard": "this card",
    "repeat": "shown above",
    "repeatHint": "Already in the tree above: it waits for more than one card",
    "cycle": "ring",
    "cycleHint": "The chain returns to this card: nothing in a ring can start",
    "expand": "Expand",
    "collapse": "Collapse",
    "progressTitle": "{done} of {total} subtasks done",
    "subtaskOf": "Subtask of",
    "formParent": "Subtask of #{id}",
    "formParentRemove": "Not a subtask",
    "stage": "Stage {n}",
    "noStage": "No stage",
    "setStage": "Stage of #{id}",
    "viaStage": "stage",
    "viaStageHint": "Held by the previous stage of the parent: it starts when every card of that stage is done"
  },
  "form": {
    "createAndStart": "Create and start",
    "startNeeds": "To start right away, the card needs an assignee and a description"
  },
  "modal": {
    "saving": "Saving…",
    "saved": "Saved",
    "saveFailed": "Could not save the card: {error}",
    "editDescription": "Edit the description",
    "emptyDescription": "Add a description: this is what the agent receives",
    "details": "Details",
    "toThreadEnd": "Go to the end of the conversation",
    "runsWith": "Runs with: {params}",
    "runsWithHint": "Set in the agent and the project, not in the card",
  },
  "presence": {
    "person": "A person works on it",
    "assigned": "assigned",
    "queued": "in the queue",
    "noAgentName": "Claude"
  },
  "log": {
    "heading": "Execution log",
    "active": "{count} running",
    "showAll": "Show all",
    "showAllMore": "Show all ({count} more)",
    "dialogTitle": "Execution log of #{id}",
    "spent": "Spent",
    "tokens": "Tokens",
    "agentTime": "Agent time",
    "tokensCount": "{tokens} tokens",
    "running": "running",
    "openThread": "Open in the thread",
    "stop": "Stop",
    "retry": "Run again in the same session",
    "stopTitle": "Stop the agent?",
    "stopBody": "The agent stops now and the card waits for you as failed. Its work stays: you can resume it or retry.",
    "checkPassed": "Check passed",
    "checkFailed": "Check failed",
    "noOutput": "The check printed nothing.",
    "exitCode": "Check exited with code {code}",
    "noOutputCode": "The check printed nothing and exited with code {code}.",
    "timedOut": "Check timed out",
    "noOutputTimedOut": "The check was killed by the timeout.",
    "trigger": {
      "none": "Run",
      "start": "Start",
      "rework": "Rework",
      "resume": "Resumed by you",
      "crash": "Resumed after a crash",
      "quota": "Resumed after the limit",
      "verify_failed": "Sent back after verification",
      "conflict": "Resolving a merge conflict",
      "message": "Your message",
      "subtasks_done": "Woken: subtasks done",
      "wakeup": "Woke up"
    },
    "outcome": {
      "handed_in": "Handed in",
      "failed": "Failed",
      "stopped": "Stopped",
      "quota": "Hit the usage limit",
      "superseded": "Replaced by the next run",
      "sleeping": "Asleep until a wakeup"
    },
    "merge": {
      "merged": "Merged into {target}",
      "failed": "Merge failed",
      "conflict": "Conflict with {target}"
    }
  },
  "wakeups": {
    "heading": "Wakeups",
    "at": "At {time}",
    "task": "When #{id} is done",
    "deadline": "at the latest {time}",
    "cancel": "Cancel the wakeup",
    "history": "History ({count})",
    "fired": "Fired",
    "cancelled": "Cancelled",
    "nothingLeft": "Nothing will wake this card: write to the agent, accept the work or close the card.",
    "note": "Note"
  },
  "failure": {
    "details": "Technical details",
    "hideDetails": "Hide details",
    "session_lost": {
      "reason": "The session was lost.",
      "hint": "orc can no longer reach the agent's session. Press «{continue}» to pick it up where it stopped, or «{retry}» to start from scratch."
    },
    "quota_limit": {
      "reason": "The usage limit was reached.",
      "hint": "The limit has to reset first. Wait for it, then press «{continue}»."
    },
    "project_unavailable": {
      "reason": "The project folder is not available.",
      "hint": "Fix the path in the project settings (or restore the folder), then press «{retry}»."
    },
    "branch_gone": {
      "reason": "The task's branch or working copy is gone.",
      "hint": "There is nothing left to continue from. Press «{retry}» to start the task again from scratch."
    },
    "check_failed_again": {
      "reason": "The check failed twice.",
      "hint": "Read the check output in the execution log. Write what to fix in the field and press «{continue}», or press «{accept}» if the work is fine as it is."
    },
    "conflict_unresolved": {
      "reason": "The branch conflicts with the target and could not be reconciled.",
      "hint": "Reconcile the branches by hand in the repository, then press «{resolved}»."
    },
    "stopped_by_owner": {
      "reason": "You stopped the agent.",
      "hint": "Its work is kept. Press «{continue}» to let it go on, or «{retry}» to start over."
    },
    "agent_reported": {
      "reason": "The agent says it could not finish.",
      "hint": "Read its explanation under the technical details. Answer in the field and press «{continue}», or press «{retry}» to start over."
    }
  },
  "deliverables": {
    "heading": "Files",
    "open": "Open {name}",
    "download": "Download",
    "versions": "Versions of {name}",
    "version": "Version {n}",
    "loading": "Loading…",
    "tooBig": "Too large to preview: download it instead.",
    "failed": "Could not load the file.",
    "noPreview": "This type is not shown here: download it.",
    "note": "Handed in by the agent. It is shown as plain content and never run."
  },
  "notReady": {
    "title": "The card is not ready for work",
    "body": "Card #{id} \"{title}\" cannot go to work yet.",
    "assignee": "Nobody is assigned, which means a person works on it. Assign an agent.",
    "fix": "Fix it"
  },
  "quickActions": {
    "heading": "Quick actions",
    "hint": "Ready messages for the agent. They show on the card and under / in the reply field.",
    "defaults": {
      "review": "Review",
      "tests": "Write tests",
      "summary": "Summarize",
      "simplify": "Simplify"
    },
    "title": "Title",
    "prompt": "Text for the agent",
    "add": "Add an action",
    "remove": "Remove {title}",
    "up": "Move {title} up",
    "down": "Move {title} down",
    "reset": "Restore the built-in set",
    "unavailable": "The agent cannot take a message in this state.",
    "menu": "Quick actions",
    "none": "No matching action",
    "empty": "No quick actions.",
    "sent": "Sent: {title}"
  },
  "settings": {
    "heading": "Task cards",
    "headingHint": "What a card shows and what a new card starts with.",
    "defaultAgent": "Default assignee",
    "defaultAgentHint": "New cards start assigned to this agent.",
    "defaultPriority": "Default priority",
    "properties": "Properties on a card",
    "propertiesHint": "A hidden property still shows when a card holds a value in it.",
    "staleAgent": "Agent #{id} is no longer available",
    "ownLabel": "Own settings for this project",
    "ownHint": "Off: the project follows the orc settings."
  }
};
