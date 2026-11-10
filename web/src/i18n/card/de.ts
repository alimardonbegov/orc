import type { cardEn } from "./en";

export const cardDe: typeof cardEn = {
  "search": "Suchen",
  "searchIn": "Suchen: {label}",
  "nothingFound": "Nichts gefunden",
  "agent": {
    "label": "Zuständig",
    "none": "Nicht zugewiesen",
    "noneHint": "Ein Mensch kümmert sich: Die Karte geht nicht in Arbeit",
    "noAgents": "Noch keine Agenten. Nur eine Karte mit Agent geht in Arbeit.",
    "create": "Agent anlegen"
  },
  "priority": {
    "label": "Priorität"
  },
  "branch": {
    "label": "Branch"
  },
  "dependsOn": {
    "label": "Wartet auf",
    "none": "Nichts"
  },
  "labels": {
    "label": "Labels",
    "none": "Keine Labels",
    "searchLabel": "Label suchen oder anlegen",
    "searchPlaceholder": "Suchen oder neues Label eintippen",
    "empty": "Noch keine Labels. Namen eintippen, um eines anzulegen.",
    "create": "„{name}“ anlegen"
  },
  "startDate": {
    "label": "Startdatum"
  },
  "dueDate": {
    "label": "Fällig am",
    "overdue": "Überfällig"
  },
  "date": {
    "clear": "Datum entfernen"
  },
  "status": {
    "label": "Status",
    "lockedHint": "Eine laufende Karte bewegt ihre Sitzung, nicht die Hand"
  },
  "addProperty": "Eigenschaft hinzufügen",
  "details": {
    "createdBy": "Erstellt von",
    "byCard": "Agent von Karte #{id}",
    "byRoutine": "Routine, Lauf {run}",
    "byOwner": "Besitzer",
    "updated": "Aktualisiert",
    "finished": "Abgeschlossen"
  },
  "relations": {
    "heading": "Beziehungen",
    "viewLabel": "Beziehungen anzeigen als",
    "list": "Liste",
    "tree": "Baum",
    "chain": "Die ganze Kette",
    "comesNext": "Danach",
    "subtasks": "Unteraufgaben",
    "noSubtasks": "Keine Unteraufgaben",
    "wake": "Karte wecken, wenn alle Teilaufgaben fertig sind",
    "wakeHint": "Die Karte geht einmal zurück in die Warteschlange, um das Ergebnis zu prüfen. Eine fehlgeschlagene Teilaufgabe hält sie zurück. Standardmäßig aus.",
    "addSubtask": "Neue Unteraufgabe",
    "attach": "Vorhandene Karte als Unteraufgabe anhängen",
    "attachEmpty": "Keine Karten zum Anhängen",
    "detach": "#{id} aus den Unteraufgaben nehmen",
    "editWaits": "Ändern, worauf sie wartet",
    "gone": "archiviert oder gelöscht",
    "failedHint": "#{id} ist fehlgeschlagen: sie hält diese Karte auf, bis sie behoben ist",
    "thisCard": "diese Karte",
    "repeat": "oben gezeigt",
    "repeatHint": "Schon weiter oben im Baum: sie wartet auf mehr als eine Karte",
    "cycle": "Ring",
    "cycleHint": "Die Kette kehrt zu dieser Karte zurück: nichts in einem Ring kann starten",
    "expand": "Aufklappen",
    "collapse": "Zuklappen",
    "progressTitle": "{done} von {total} Unteraufgaben erledigt",
    "subtaskOf": "Unteraufgabe von",
    "formParent": "Unteraufgabe von #{id}",
    "formParentRemove": "Keine Unteraufgabe",
    "stage": "Phase {n}",
    "noStage": "Keine Phase",
    "setStage": "Phase von #{id}",
    "viaStage": "Phase",
    "viaStageHint": "Wartet auf die vorherige Phase des übergeordneten Tickets: startet, wenn alle Karten dieser Phase erledigt sind"
  },
  "form": {
    "createAndStart": "Erstellen und starten",
    "startNeeds": "Zum sofortigen Start braucht die Karte eine Zuständigkeit und eine Beschreibung"
  },
  "modal": {
    "saving": "Speichert…",
    "saved": "Gespeichert",
    "saveFailed": "Karte konnte nicht gespeichert werden: {error}",
    "editDescription": "Beschreibung bearbeiten",
    "emptyDescription": "Beschreibung hinzufügen: Genau sie erhält der Agent",
    "details": "Details",
    "toThreadEnd": "Zum Ende des Gesprächs",
    "runsWith": "Läuft mit: {params}",
    "runsWithHint": "Wird im Agenten und im Projekt festgelegt, nicht in der Karte",
  },
  "presence": {
    "person": "Ein Mensch kümmert sich",
    "assigned": "zugewiesen",
    "queued": "in der Warteschlange",
    "noAgentName": "Claude"
  },
  "log": {
    "heading": "Ausführungsprotokoll",
    "active": "{count} laufend",
    "showAll": "Alle anzeigen",
    "showAllMore": "Alle anzeigen ({count} weitere)",
    "dialogTitle": "Ausführungsprotokoll von #{id}",
    "spent": "Ausgegeben",
    "tokens": "Tokens",
    "agentTime": "Agentenzeit",
    "tokensCount": "{tokens} Tokens",
    "running": "läuft",
    "openThread": "Im Verlauf öffnen",
    "stop": "Stoppen",
    "retry": "In derselben Sitzung erneut starten",
    "stopTitle": "Agent stoppen?",
    "stopBody": "Der Agent stoppt sofort, und die Karte wartet als fehlgeschlagen auf dich. Die Arbeit bleibt erhalten: Du kannst sie fortsetzen oder neu starten.",
    "checkPassed": "Prüfung bestanden",
    "checkFailed": "Prüfung fehlgeschlagen",
    "noOutput": "Die Prüfung hat nichts ausgegeben.",
    "exitCode": "Prüfung beendet mit Code {code}",
    "noOutputCode": "Die Prüfung gab nichts aus und endete mit Code {code}.",
    "timedOut": "Zeitüberschreitung der Prüfung",
    "noOutputTimedOut": "Die Prüfung wurde durch das Zeitlimit beendet.",
    "trigger": {
      "none": "Lauf",
      "start": "Start",
      "rework": "Nacharbeit",
      "resume": "Von dir fortgesetzt",
      "crash": "Nach Absturz fortgesetzt",
      "quota": "Nach dem Limit fortgesetzt",
      "verify_failed": "Nach der Prüfung zurückgeschickt",
      "conflict": "Löst einen Merge-Konflikt",
      "message": "Deine Nachricht",
      "subtasks_done": "Geweckt: Teilaufgaben fertig",
      "wakeup": "Aufgeweckt"
    },
    "outcome": {
      "handed_in": "Abgegeben",
      "failed": "Fehlgeschlagen",
      "stopped": "Gestoppt",
      "quota": "Nutzungslimit erreicht",
      "superseded": "Vom nächsten Lauf abgelöst",
      "sleeping": "Schläft bis zum Wecken"
    },
    "merge": {
      "merged": "In {target} gemergt",
      "failed": "Merge fehlgeschlagen",
      "conflict": "Konflikt mit {target}"
    }
  },
  "wakeups": {
    "heading": "Weckrufe",
    "at": "Um {time}",
    "task": "Wenn #{id} fertig ist",
    "deadline": "spätestens {time}",
    "cancel": "Weckruf abbrechen",
    "history": "Verlauf ({count})",
    "fired": "Ausgelöst",
    "cancelled": "Abgebrochen",
    "nothingLeft": "Nichts weckt diese Karte: schreib dem Agenten, nimm die Arbeit an oder schließe die Karte.",
    "note": "Notiz"
  },
  "failure": {
    "details": "Technische Details",
    "hideDetails": "Details ausblenden",
    "session_lost": {
      "reason": "Die Sitzung ist verloren.",
      "hint": "orc erreicht die Sitzung des Agenten nicht mehr. Mit «{continue}» geht es an der Stelle weiter, an der sie stehen blieb, mit «{retry}» von vorn."
    },
    "quota_limit": {
      "reason": "Das Nutzungslimit ist erreicht.",
      "hint": "Das Limit muss sich erst zurücksetzen. Warten und dann «{continue}» drücken."
    },
    "project_unavailable": {
      "reason": "Der Projektordner ist nicht erreichbar.",
      "hint": "Den Pfad in den Projekteinstellungen korrigieren (oder den Ordner wiederherstellen) und «{retry}» drücken."
    },
    "branch_gone": {
      "reason": "Der Branch oder die Arbeitskopie der Aufgabe ist weg.",
      "hint": "Es gibt nichts, woran man anknüpfen könnte. Mit «{retry}» beginnt die Aufgabe von vorn."
    },
    "check_failed_again": {
      "reason": "Die Prüfung ist zweimal fehlgeschlagen.",
      "hint": "Die Ausgabe der Prüfung steht im Ausführungsprotokoll. Ins Feld schreiben, was zu beheben ist, und «{continue}» drücken, oder «{accept}», wenn die Arbeit passt."
    },
    "conflict_unresolved": {
      "reason": "Der Branch kollidiert mit dem Ziel und ließ sich nicht abgleichen.",
      "hint": "Die Branches im Repository von Hand abgleichen und dann «{resolved}» drücken."
    },
    "stopped_by_owner": {
      "reason": "Du hast den Agenten gestoppt.",
      "hint": "Seine Arbeit bleibt erhalten. Mit «{continue}» macht er weiter, mit «{retry}» beginnt er neu."
    },
    "agent_reported": {
      "reason": "Der Agent meldet, dass er nicht fertig wurde.",
      "hint": "Seine Erklärung steht in den technischen Details. Im Feld antworten und «{continue}» drücken, oder «{retry}» für einen Neustart."
    }
  },
  "deliverables": {
    "heading": "Dateien",
    "open": "{name} öffnen",
    "download": "Herunterladen",
    "versions": "Versionen von {name}",
    "version": "Version {n}",
    "loading": "Wird geladen…",
    "tooBig": "Zu groß für die Vorschau: bitte herunterladen.",
    "failed": "Die Datei konnte nicht geladen werden.",
    "noPreview": "Dieser Typ wird hier nicht angezeigt: bitte herunterladen.",
    "note": "Vom Agenten abgegeben. Sie wird nur als Inhalt angezeigt und nie ausgeführt."
  },
  "notReady": {
    "title": "Die Karte ist nicht bereit",
    "body": "Karte #{id} „{title}“ kann noch nicht in Arbeit gehen.",
    "assignee": "Niemand ist zugewiesen, also kümmert sich ein Mensch. Weise einen Agenten zu.",
    "fix": "Beheben"
  },
  "quickActions": {
    "heading": "Schnellaktionen",
    "hint": "Fertige Nachrichten für den Agenten. Sie erscheinen auf der Karte und mit / im Antwortfeld.",
    "defaults": {
      "review": "Prüfen",
      "tests": "Tests schreiben",
      "summary": "Zusammenfassen",
      "simplify": "Vereinfachen"
    },
    "title": "Titel",
    "prompt": "Text für den Agenten",
    "add": "Aktion hinzufügen",
    "remove": "{title} entfernen",
    "up": "{title} nach oben",
    "down": "{title} nach unten",
    "reset": "Standardsatz wiederherstellen",
    "unavailable": "In diesem Zustand nimmt der Agent keine Nachricht an.",
    "menu": "Schnellaktionen",
    "none": "Keine passende Aktion",
    "empty": "Keine Schnellaktionen.",
    "sent": "Gesendet: {title}"
  },
  "settings": {
    "heading": "Aufgabenkarten",
    "headingHint": "Was eine Karte zeigt und womit eine neue beginnt.",
    "defaultAgent": "Standard-Zuständigkeit",
    "defaultAgentHint": "Neue Karten werden diesem Agenten zugewiesen.",
    "defaultPriority": "Standardpriorität",
    "properties": "Eigenschaften der Karte",
    "propertiesHint": "Eine ausgeblendete Eigenschaft bleibt sichtbar, wenn die Karte einen Wert darin hat.",
    "staleAgent": "Agent #{id} ist nicht mehr verfügbar",
    "ownLabel": "Eigene Einstellungen für dieses Projekt",
    "ownHint": "Aus: Das Projekt folgt den orc-Einstellungen."
  }
};
