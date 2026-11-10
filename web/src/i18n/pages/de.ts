import type { PagesDictionary } from "./en";

/** German texts for the About / How it works pages (see pages/en.ts). */
export const pagesDe: PagesDictionary = {
  nav: {
    about: "Über orc",
    guide: "So funktioniert's",
    helpNav: "Über und Hilfe",
    backToBoard: "Zurück zum Board",
  },
  demo: {
    play: "Abspielen",
    pause: "Pause",
    replay: "Erneut abspielen",
    goToStep: "Schritt {step}",
    stepOf: "{step} / {total}",
    regionLabel: "Animierte Demo: {title}",
  },
  about: {
    eyebrow: "Aufgaben-Orchestrator für Claude Code",
    title: "Ein Kanban-Board, das seine Aufgaben selbst erledigt",
    lead: "Leg eine Karte in „Zu erledigen“ und hör auf zu klicken. Alle 30 Sekunden nimmt der Dispatcher Aufgaben aus der Warteschlange, gibt jeder einen eigenen git-Worktree, startet dort `claude --bg`, prüft das Ergebnis mit deinem Verify-Befehl und mergt den Branch bei Grün selbst — `--no-ff`, einer nach dem anderen, ohne Pull Request. Abends die Warteschlange füllen, morgens den Diff lesen.",
    ctaGuide: "So funktioniert's",
    ctaAddProject: "Projekt hinzufügen",
    flowHeading: "Drei Schritte, dann läuft es von selbst",
    flow: {
      queue: {
        title: "Du stellst ein",
        body: "Eine Karte mit einem klaren Auftrag für den Agenten kommt nach „Zu erledigen“. Priorität, Modell, Basis-Branch und Abhängigkeiten legst du direkt auf der Karte fest.",
      },
      work: {
        title: "Der Agent arbeitet",
        body: "Jede Aufgabe bekommt ihren eigenen Worktree und den Branch `orc/task-<id>`. Mehrere Agenten arbeiten parallel, ohne sich in die Quere zu kommen.",
      },
      ship: {
        title: "orc prüft und mergt",
        body: "Es entscheidet dein `verify_cmd`, nicht das Wort des Agenten. Grün — Merge in den Basis-Branch; rot — die Aufgabe geht mit einer Erklärung zurück.",
      },
    },
    featuresHeading: "Was orc kann und andere nicht",
    featuresLead: "Einzeln gibt es fast jede Funktion irgendwo. Das ganze Paket — Board, Auto-Dispatcher, harte Prüfung vor dem Merge, Auto-Merge ohne PR, Konflikte zurück an ihren Urheber und Kontingent-Buchhaltung — bringt sonst niemand zusammen.",
    features: {
      dispatcher: {
        title: "Pull-basierter Dispatcher",
        body: "Kein „Start“-Button: Der Dispatcher holt sich die Aufgaben selbst und hält die Agenten-Limits pro Projekt und insgesamt ein.",
      },
      verify: {
        title: "Prüfung vor dem Merge",
        body: "Dein Befehl — Tests, Linter, Build — läuft im Worktree der Aufgabe. An einer roten Prüfung vorbei wird nichts gemergt.",
      },
      merge: {
        title: "Auto-Merge ohne PR",
        body: "`--no-ff` in den Basis-Branch der Aufgabe, strikt einer nach dem anderen. Bearbeitest du diesen Branch gerade von Hand, sichert orc deine Änderungen vorher als separaten wip-Commit.",
      },
      conflict: {
        title: "Konflikte gehen an ihren Urheber zurück",
        body: "Ein inhaltlicher Merge-Konflikt geht an die Sitzung, die den Code geschrieben hat — sie weiß, warum es so gemacht wurde. Drei Versuche, dann ein Mensch.",
      },
      quota: {
        title: "Kontingent ist eine Ressource",
        body: "Die Limits deines Claude-Abos sind immer im Blick, und wenn sie aufgebraucht sind, warten Aufgaben auf den Reset, statt fehlzuschlagen.",
      },
      live: {
        title: "Antworten erreichen eine laufende Sitzung",
        body: "Der Agent hat etwas gefragt — die Karte rückt mit einem Badge nach oben, und deine Antwort landet binnen Sekunden in derselben Sitzung, ohne Neustart.",
      },
      cost: {
        title: "Die Kosten jeder Aufgabe",
        body: "Tokens über alle Sitzungen und Subagenten einer Aufgabe, direkt aus den Claude-Code-Transkripten, aufgeschlüsselt nach Modell.",
      },
      summary: {
        title: "Eine Übersicht für den langen Atem",
        body: "Durchsatz, Erfolgsquote, Zeit pro Aufgabe, Reibung und die teuersten Aufgaben — direkt neben dem Board, nur eine Taste entfernt.",
      },
    },
    forHeading: "Für wen",
    forItems: {
      solo: "Ein Entwickler ohne Reviewer: Wo Teams sich gegenseitig Pull Requests öffnen, entscheidet hier `verify_cmd`.",
      subscription: "Läuft über die Claude Code CLI auf deinem Rechner — mit dem Abo, das du ohnehin bezahlst, ohne separates Guthaben.",
      local: "Alles bleibt lokal: Der Server lauscht nur auf 127.0.0.1, und die Daten liegen gleich daneben in SQLite.",
    },
    notHeading: "Was orc bewusst nicht ist",
    notLead: "Das gehört Teams, die es seit Jahren bauen. orc konkurriert dort nicht — es nimmt sich, was sonst niemand genommen hat.",
    notItems: {
      multiAgent: {
        title: "Kein Multi-Agent",
        body: "Nur Claude Code. Kein Codex, Cursor oder OpenCode.",
      },
      diff: {
        title: "Kein Diff-Review in der Oberfläche",
        body: "Das Ergebnis ist ein gemergter Commit — den Diff liest du in deinem Editor oder in git.",
      },
      cloud: {
        title: "Kein Cloud- oder Team-Modus",
        body: "Ein Rechner, eine Person, localhost.",
      },
    },
    limitsHeading: "Aktuelle Einschränkungen",
    limitsLead: "Gut zu wissen, bevor du orc ein echtes Repository anvertraust.",
    limits: {
      local: {
        title: "Nur Claude Code, nur dieser Rechner",
        body: "Die API antwortet nur auf Loopback; andere Geräte erreichen sie nicht. Autostart bei der Anmeldung gibt es nur für macOS (LaunchAgent) — unter Linux startest du den Server selbst oder nutzt Docker.",
      },
      planMode: {
        title: "Kein Berechtigungsmodus „plan“",
        body: "Eine Sitzung, die auf die Plan-Freigabe wartet, sieht für den Dispatcher wie „in Arbeit“ aus und würde still hängen bleiben — deshalb wird der Modus noch nicht angeboten.",
      },
      quotaRegex: {
        title: "Kontingent-Erkennung ist eine Hypothese",
        body: "Die Muster, die ein erschöpftes Limit erkennen, sind eine Vermutung und lassen sich in den Einstellungen anpassen. Nach 5 Kontingent-Wiederholungen in Folge schlägt die Aufgabe mit einer Erklärung fehl.",
      },
      delivery: {
        title: "Nachrichten kommen beim nächsten Werkzeugaufruf an",
        body: "Eine Notiz an eine laufende Sitzung geht über einen Hook — meist binnen Sekunden, doch eine Sitzung, die lange nachdenkt, holt sie später ab. Dann kannst du sie unterbrechen.",
      },
      rework: {
        title: "Weiterbearbeiten braucht einen lebenden Worktree",
        body: "„Weiterbearbeiten“ setzt dieselbe Sitzung in derselben Arbeitskopie fort. Ist der Worktree entfernt, bleibt nur eine neue Aufgabe.",
      },
      images: {
        title: "Bilder reisen als Dateipfade",
        body: "`claude --bg` nimmt ein einziges Textargument, daher bekommt der Agent den Pfad des Bildes und öffnet es mit Read. png, jpeg, gif und webp bis 10 MB.",
      },
      autocommit: {
        title: "Deine nicht committeten Änderungen werden committet",
        body: "Vor dem Merge in einen Branch, in dem du arbeitest, committet orc versionierte Änderungen als `wip(orc): auto-commit before merge #id`. Push bleibt aus, bis du ihn einschaltest.",
      },
      stop: {
        title: "Noch kein sanftes „Stopp“",
        body: "Eine laufende Aufgabe lässt sich nur manuell schließen oder löschen. Sie anzuhalten und mit erhaltener Arbeit in den Rückstand zurückzulegen, ist noch geplant.",
      },
    },
    risksHeading: "Bewusste Risiken",
    risksLead: "Keine offenen Baustellen, sondern bewusste Entscheidungen — sie zu schließen hieße, aufzugeben, wofür orc existiert.",
    risks: {
      noHuman: {
        title: "Kein Mensch zwischen Agent und origin",
        body: "Merge und, falls eingeschaltet, Push folgen dem Wort des Agenten selbst, dass die Arbeit fertig ist. `verify_cmd` ist die einzige unabhängige Stimme.",
      },
      verifyEdited: {
        title: "verify_cmd führt Code aus, den der Agent gerade bearbeitet hat",
        body: "Ruft die Prüfung `make test` oder `npm test` auf, könnte der Agent genau dieses Skript in derselben Aufgabe geändert haben. orc auf einem fremden Repository laufen zu lassen ist wie dessen Makefile auszuführen.",
      },
      localRead: {
        title: "Jeder lokale Prozess kann die API lesen",
        body: "Änderungen erfordern das Konsolen-Token, Lesen nicht: Aufgabenliste, Beschreibungen und Repository-Pfade sind für jedes Programm sichtbar, das unter deinem Benutzer läuft.",
      },
    },
    roadmapHeading: "Wie es weitergeht",
    roadmapLead: "Ideen mit Recherche oder Plan dahinter. Ohne Termine — die Reihenfolge hängt davon ab, was im Alltag am meisten schmerzt.",
    roadmapStatus: {
      plan: "Plan steht",
      research: "recherchiert",
      idea: "Idee",
    },
    roadmap: {
      stop: {
        title: "Button „Stopp“",
        body: "Eine laufende Aufgabe anhalten und mit erhaltener Arbeit in den Rückstand zurücklegen — dann an derselben Stelle weitermachen oder neu beginnen.",
      },
      planMode: {
        title: "Plan-Modus",
        body: "Das Signal „Plan freigeben“ der Sitzung lesen und als gewöhnliche Karte „wartet auf Antwort“ zeigen.",
      },
      ide: {
        title: "Im Editor öffnen",
        body: "Links von einer Karte zu ihrem Worktree in VS Code und zur laufenden Claude-Sitzung; später ein Modus „Mensch am Steuer“.",
      },
      windows: {
        title: "Zeitfenster",
        body: "Den Dispatcher nur zu festgelegten Zeiten arbeiten lassen — zum Beispiel nachts, wenn das Kontingent ungenutzt ist.",
      },
      review: {
        title: "Review vor dem Merge",
        body: "Ein optionaler Schalter: Nach einer grünen Prüfung wartet die Aufgabe auf dein OK, statt sofort gemergt zu werden.",
      },
      sessionLog: {
        title: "Sitzungsprotokoll in der Karte",
        body: "Sehen, was der Agent gerade tut, ohne ein Terminal zu öffnen.",
      },
    },
    footer: "orc spricht man „ork“. Die ganze Geschichte steht in README.md und docs/ im Repository.",
    brandBook: "Markenhandbuch",
  },
  guide: {
    title: "So funktioniert's",
    lead: "Schritt für Schritt, vom leeren Board bis zur gemergten Aufgabe. Jeder Abschnitt sagt, wo sich die Dinge in der Oberfläche befinden und was du dort einstellst.",
    tocLabel: "Inhalt",
    where: "Wo",
    tip: "Tipp",
    sections: {
      start: {
        title: "Bevor du anfängst",
        where: "Terminal, im orc-Ordner",
        intro: "orc läuft auf deinem Rechner und steuert die Claude Code CLI. Das braucht es:",
        steps: {
          s1: "macOS oder Linux, Python 3.12+, Node.js mit npm und `uv`.",
          s2: "Claude Code CLI im PATH, angemeldet mit deinem Abo: `claude --bg` muss im Terminal funktionieren.",
          s3: "Ein git-Repository für jedes Projekt — jede Aufgabe arbeitet in ihrem eigenen `git worktree`.",
          s4: "Einmalige Einrichtung: `make setup`, dann `make start` — die Konsole öffnet sich unter http://127.0.0.1:8765.",
          s5: "Optional: `make install-agent` startet den Server bei jeder macOS-Anmeldung, und `make docker-up` lässt ihn stattdessen in Docker laufen.",
        },
        tip: "`make status` zeigt, ob der Server läuft, und `make logs` zeigt sein Log.",
      },
      project: {
        title: "Projekt hinzufügen",
        where: "Seitenleiste → „+“ neben „Projekte“",
        intro: "Ein Projekt ist ein git-Repository plus die Regeln für die Arbeit darin. Alles hier lässt sich später in den Projekteinstellungen ändern — das Zahnrad im Board-Kopf.",
        steps: {
          s1: "Name und Repository-Pfad. Ein Ordner ohne git? orc bietet an, `git init` mit einem leeren ersten Commit auf main auszuführen.",
          s2: "„Agenten gleichzeitig“ — wie viele Aufgaben dieses Projekts parallel laufen. Die orc-Einstellungen haben zusätzlich eine globale Obergrenze.",
          s3: "«Agenten» — wer das Projekt leitet und wie viele gleichzeitig laufen. Modell, Aufwand und Berechtigungsmodus stellt jeder Agent selbst ein; die Werte des Projekts («Ausweich-Startwerte» in den Projekteinstellungen) gelten nur für einen Agenten ohne eigene.",
          s4: "„Basis-Branch“ — wovon Aufgaben-Branches abzweigen und wohin die Ergebnisse zurückfließen. Leer bedeutet den Branch, der gerade im Repository ausgecheckt ist.",
          s5: "„Prüfung vor dem Merge“ — der Verify-Befehl (zum Beispiel `make test`) und sein Zeitlimit. Das ist die wichtigste Sicherung: Ohne sie verlässt sich der Merge nur auf das Wort des Agenten.",
          s6: "„Nach dem Merge“ — Push zu origin. Standardmäßig aus: orc pusht nie von selbst, bis du es einschaltest.",
          s7: "„Projektgedächtnis“ — CLAUDE.md direkt hier bearbeiten: dauerhafte Anweisungen, die jeder Agent dieses Projekts liest.",
          s8: "Drück „Speichern“. Einstellungen werden nur über den Button gespeichert, und der Dialog schließt sich bei ungespeicherten Änderungen nicht durch einen Klick daneben.",
        },
        tip: "Repository-Ordner verschoben? Ändere den Pfad in den Projekteinstellungen — orc verknüpft die Arbeitskopien der Aufgaben mit `git worktree repair` neu.",
      },
      task: {
        title: "Aufgabe erstellen",
        where: "Button „Aufgabe“ im Board-Kopf oder die Taste N",
        intro: "Der Titel der Karte ist für dich; der Agent erhält das Feld „Aufgabe für den Agenten“. Schreib es so, wie du eine Kollegin einweisen würdest, die den Kontext nicht kennt.",
        steps: {
          s1: "Titel — ein kurzer Name für das Board.",
          s2: "„Aufgabe für den Agenten“ — was zu tun ist, wo es liegt und wie es zu prüfen ist. Füge Screenshots genau dort ein, wo sie hingehören: Strg+V, per Drag-and-Drop oder mit dem Button „Bild“. „Text / Vorschau“ zeigt, was der Agent sehen wird.",
          s3: "«Zuständig» — der Agent, der die Arbeit macht. Modell, Aufwand und Berechtigungsmodus kommen vom Agenten; eine Karte ohne Zuständigen gehört dir und geht nicht an die Arbeit.",
          s4: "Berechtigungsmodi: `auto` — Claude entscheidet selbst; `acceptEdits` — bearbeitet Dateien ohne Nachfrage; `dontAsk` — fragt nie, und was nicht vorab freigegeben ist, wird einfach nicht ausgeführt; `bypassPermissions` — gar keine Prüfungen, nur für eigene Repositories.",
          s5: "Priorität, Basis-Branch und «Wartet auf»: eine Karte wartet, bis die Karten, von denen sie abhängt, gemergt sind, auch in anderen Projekten. «Eigenschaft hinzufügen» ergänzt Labels und Plandaten, die die Warteschlange nie liest.",
          s6: "Lass die Karte als Notiz im „Rückstand“ oder leg sie nach „Zu erledigen“ — der Dispatcher übernimmt sie beim nächsten Zyklus. Eine Karte mit leerem Auftrag kann nicht nach „Zu erledigen“.",
        },
        tip: "Den Basis-Branch kannst du ändern, solange die Karte im „Rückstand“ oder in „Zu erledigen“ liegt. Sobald die Aufgabe startet, existiert die Arbeitskopie bereits, und es ist zu spät.",
      },
      card: {
        title: "Die Karte",
        where: "Klick auf eine Karte im Board",
        intro: "Eine Karte beschreibt die Arbeit einmal, und alles zwischen dir und dem Agenten passiert in ihrer Konversation. Die linke Spalte ist zum Lesen, die rechte für Fakten.",
        steps: {
          s1: "Die Beschreibung bleibt, wo sie ist: eine Frage des Agenten schiebt sie nie beiseite. Klick zum Bearbeiten; das Feld wächst mit dem Text.",
          s2: "«Beziehungen»: worauf die Karte wartet, was danach kommt, und ihre Unteraufgaben mit einem Ring erledigt/gesamt. «+» legt eine Unteraufgabe mit Projekt, Branch und Agent der Elternkarte an; «Liste / Baum» zeigt die ganze Kette um die Karte.",
          s3: "«Konversation»: Nachrichten und Befehle der Sitzung und die Etappen, die orc ergänzt — abgegeben, Prüfung, Merge, Konflikt. Das Eingabefeld darunter folgt dem Zustand: «An Agenten senden», solange der Agent arbeitet oder wartet, «Fortsetzen» und «Erneut versuchen» nach einem Fehler, «Weiterbearbeiten», wenn die Karte fertig ist.",
          s4: "«Notiz, der Agent sieht sie nicht» bleibt an der Karte und erreicht die Sitzung nie.",
          s5: "Die rechte Spalte: Status, Zuständig, Priorität, Branch und die hinzugefügten Eigenschaften. Das «Ausführungsprotokoll» listet jeden Lauf mit Anlass, Ausgang und Kosten, und jede Prüfung mit ihrer Ausgabe.",
          s6: "«Details» unten: wer die Karte angelegt hat, wann sie begann und endete, ihr Branch, ihr Worktree und der Befehl, um sich an die Sitzung anzuhängen.",
        },
        tip: "Eine Karte öffnet sich oben, um die Aufgabe zu lesen. Am Ende der Konversation öffnet sie sich, wenn sie auf dich wartet, und der Agenten-Chip im Kopf führt ebenfalls dorthin.",
      },
      dispatcher: {
        title: "Was der Dispatcher tut",
        where: "Unten in der Seitenleiste — das Dispatcher-Panel",
        intro: "Es gibt einen Dispatcher für alle Projekte. Alle `poll_interval_sec` Sekunden (standardmäßig 30) macht er einen Durchlauf — einen Zyklus:",
        steps: {
          s1: "Nimmt Aufgaben aus „Zu erledigen“, solange Plätze frei sind, und erstellt einen Worktree mit dem Branch `orc/task-<id>` aus dem Basis-Branch der Aufgabe.",
          s2: "Startet dort `claude --bg` mit deinem Auftrag, Modell und Berechtigungsmodus. Die Karte wandert nach „In Arbeit“.",
          s3: "Wartet, bis der Agent `orc task done` aufruft und seinen Zug beendet. Ruft er `orc task fail` auf, stoppt die Aufgabe mit seiner Begründung. Tut er keines von beiden, wartet die Karte auf dich. Ruft er `orc task wakeup` auf, schläft die Karte ohne Worker-Slot bis zu ihrem Weckruf.",
          s4: "Führt `verify_cmd` im Worktree aus — das Badge „Prüfung“. Rot: Die Aufgabe geht mit der Ausgabe der Prüfung an den Agenten zurück.",
          s5: "Grün: Die Aufgabe reiht sich in die Merge-Warteschlange ein — das Badge „Merge“: `--no-ff` in den Basis-Branch, eine Aufgabe nach der anderen. Dann „Fertig“.",
          s6: "Das Dispatcher-Panel zeigt den Herzschlag und beschäftigte Agenten. „Pause“ stoppt die Verteilung neuer Aufgaben; „Jetzt ausführen“ macht einen Durchlauf, ohne auf den Timer zu warten.",
        },
        tip: "Die Augen des Orks im Logo leuchten, solange der Dispatcher lebt, und pulsieren, während Agenten arbeiten.",
      },
      input: {
        title: "Wenn der Agent dich braucht",
        where: "Leiste „Warten auf mich“ über dem Board",
        intro: "Magenta ist die einzige Farbe in der Oberfläche, die einen Menschen ruft. Eine Karte, die dich braucht, rückt an den Anfang ihrer Spalte und bekommt ein Badge.",
        steps: {
          s1: "Der Agent hat um Erlaubnis gebeten, eine Frage gestellt oder einen Plan vorgeschlagen — die Karte bekommt „wartet auf Antwort“, und der Zähler im Kopf steigt.",
          s2: "Öffne die Karte. Eine Berechtigung, eine Auswahl oder ein Plan kommt als Formular am Ende der Konversation, anstelle des Eingabefelds. Eine einfache Frage ist die letzte Nachricht des Agenten, markiert mit «Wartet auf deine Antwort»: antworte im Eingabefeld — Screenshots gehen auch hier.",
          s3: "Die Antwort geht binnen Sekunden an dieselbe Sitzung, und sie macht dort weiter, wo sie aufgehört hat.",
          s4: "Du kannst einer laufenden Sitzung auch ungefragt schreiben: «An Agenten senden» im Eingabefeld. Der Text kommt beim nächsten Werkzeugaufruf an, ohne sie zu unterbrechen; «Unterbrechen» stoppt zuerst den laufenden Schritt, wie Esc.",
          s5: "Eine Nachricht unterwegs zeigt darunter ihren Status: «wartet auf den nächsten Schritt des Agenten», dann «gelesen». Steckt der Agent in einem langen Schritt, stoppt «Unterbrechen» ihn wie Esc, damit er deine Nachricht früher liest.",
          s6: "Der Agent gibt seine Arbeit mit `orc task done` ab. Hat er ohne aufgehört und sieht die Arbeit fertig aus, gibt «Arbeit annehmen» neben «An Agenten senden» sie für ihn ab: die Prüfung läuft trotzdem.",
        },
        tip: "Fragen aus anderen Projekten erscheinen als separater Chip in derselben Leiste — der Dispatcher ist gemeinsam, also geht nichts verloren.",
      },
      problems: {
        title: "Konflikte, Fehlschläge und Kontingent",
        where: "Badges auf der Karte und in ihrem Fenster",
        intro: "Die meisten Probleme lösen sich ohne dich. Das erledigt orc von selbst — und dann ruft es dich.",
        steps: {
          s1: "Merge-Konflikt: Die Aufgabe, die als zweite ankommt, findet fremde Änderungen in ihren Dateien. orc schickt den Konflikt an die Sitzung zurück, die den Code geschrieben hat; sie löst ihn inhaltlich, besteht die Prüfung erneut und kehrt in die Merge-Warteschlange zurück. Nach drei Versuchen — das Badge „Konflikt“.",
          s2: "Eine fehlgeschlagene Aufgabe ist rot, der Grund steht in ihrer Konversation. «Fortsetzen» setzt dieselbe Sitzung fort, mit deiner Nachricht, wenn du eine schreibst; «Erneut versuchen» beginnt von vorn; «Arbeit annehmen» schickt das Ergebnis der Sitzung in die Prüfung.",
          s3: "Kontingent: Ist das Claude-Limit aufgebraucht, wartet die Aufgabe mit dem Badge „Kontingent“, und der Dispatcher setzt sie nach dem Reset fort.",
          s4: "„nicht vertraut“: Claude Code startet keine Sitzungen in einem Ordner, dem du nicht vertraut hast. „Ordner vertrauen und starten“ behebt das einmal pro Projekt.",
          s5: "„unsaubere Kopie“: Im Ziel-Branch hängt ein unvollendeter Merge, Rebase oder Cherry-Pick. orc fasst ihn nicht an — schließ die Operation ab, und die Aufgabe läuft weiter.",
        },
        tip: "Die orc-Einstellung „Merge-Konflikte werden von der Sitzung selbst gelöst“ — schalte sie aus, wenn jeder Konflikt bei dir landen soll.",
      },
      finish: {
        title: "Abschließen und aufräumen",
        where: "Aufgabenfenster",
        intro: "Eine fertige Aufgabe lässt sich fortsetzen, und eine festhängende kann man von Hand schließen.",
        steps: {
          s1: "„Weiterbearbeiten“ auf einer fertigen Karte: Schreib, was zu korrigieren ist — die Karte kehrt nach „Zu erledigen“ zurück, setzt dieselbe Sitzung im selben Worktree fort und wird ein zweites Mal gemergt.",
          s2: "„Manuell schließen“ ist ein Notausgang für eine festhängende Karte: Die Sitzung stoppt, die Karte wandert unter Umgehung von Prüfung und Merge nach „Fertig“, und der Branch bleibt ungemergt. Die Karte nach „Fertig“ zu ziehen, bewirkt dasselbe.",
          s3: "„Archivieren“ ist umkehrbar: Die Karte verschwindet vom Board und aus dem Blickfeld des Dispatchers. Der Filter „Archiv“ im Kopf zeigt archivierte Aufgaben, und „Aus dem Archiv wiederherstellen“ holt eine zurück.",
          s4: "„Löschen“ ist endgültig: die Aufgabe, ihre Konversation und — sofern du das Häkchen nicht entfernst — ihr Branch und Worktree.",
          s5: "„Fertig“ hat ein eigenes Sortiermenü: neueste zuerst, älteste zuerst oder Fehlgeschlagene zuerst.",
          s6: "Eine fertige Aufgabe bleibt oben in „Fertig“ als nicht angesehen, bis du ihre Karte öffnest oder den Haken in ihrer Ecke setzt. Entferne den Haken, und die Aufgabe steht wieder oben. Zähler für nicht Angesehenes stehen auf der Schaltfläche „Fertig“ und in der Projektliste; abschalten lässt sich das in den Projekteinstellungen.",
        },
        tip: "orc kann Worktrees gemergter Aufgaben selbst entfernen — siehe „Worktrees gemergter Aufgaben aufräumen“ in den orc-Einstellungen. Solange der Worktree existiert, funktioniert „Weiterbearbeiten“.",
      },
      branches: {
        title: "Branches und Worktrees",
        where: "Board-Kopf — die Branch- und Ordner-Buttons neben dem Projekt-Zahnrad",
        intro: "Branches und Arbeitskopien leben in git, nicht in der Datenbank von orc — deshalb lesen diese Fenster sie direkt.",
        steps: {
          s1: "„Projekt-Branches“ zeigt jeden Branch und wer ihn hält: im Repository geöffnet, Basis für neue Aufgaben, nicht gemergt, Aufgaben, die darin arbeiten.",
          s2: "Hier legst du Branches an, benennst sie um und löschst sie. Umbenennen zieht jede Karte mit, die auf den Branch verwies; Löschen verschiebt wartende Aufgaben auf den Basis-Branch des Projekts.",
          s3: "Gefährliche Operationen werden erklärt, nicht versteckt: ein Schloss mit Begründung, wenn laufende Arbeit kaputtginge, und eine Bestätigung mit der Liste der Verluste, wenn es deine Entscheidung ist.",
          s4: "„Worktrees“ listet jede Arbeitskopie des Projekts mit ihrer Aufgabe, ihrem Zustand und ihrer Größe auf und lässt dich die entfernen, die du nicht mehr brauchst.",
        },
        tip: "Ein außerhalb von orc gelöschter Branch verschwindet nicht stillschweigend: Die Liste markiert ihn mit „diesen Branch gibt es nicht mehr“.",
      },
      overview: {
        title: "Übersicht, Limits und Ereignisse",
        where: "Umschalter „Board / Übersicht“ und unten in der Seitenleiste",
        intro: "Das Board beantwortet die Frage „muss ich gerade eingreifen“. Alles andere beantwortet längerfristige Fragen.",
        steps: {
          s1: "„Übersicht“ (Taste D): Kacheln, Durchsatz über die Zeit, Aufgabendauer, Aufschlüsselungen nach Modell, Aufwand, Berechtigungsmodus und Projekt, Reibung und die teuersten Aufgaben. Umfang — das aktuelle Projekt oder alle; Zeitraum — 7, 30 oder 90 Tage oder die gesamte Zeit.",
          s2: "Claude-Limits unten in der Seitenleiste: das 5-Stunden- und das Wochenfenster deines KONTOS, mit Reset-Zeit. Der Aktualisieren-Button fragt Claude sofort — das dauert ein paar Sekunden.",
          s3: "Das Münz-Badge auf einer Karte ist die Token-Summe der Aufgabe über alle Sitzungen und Subagenten. Das Aufgabenfenster schlüsselt sie nach Modell und nach Agent auf.",
          s4: "Ereignisse (Taste E): Starts, Fragen von Agenten, Prüfergebnisse; neue sind markiert. „Alle Ereignisse und Filter“ öffnet den vollständigen Feed mit Filtern nach Projekt und Stufe.",
        },
        tip: "Geld in der Übersicht misst die Nutzung zu API-Preisen — mit einem Abo werden diese Dollar nicht berechnet.",
      },
      settings: {
        title: "orc-Einstellungen",
        where: "Seitenleiste → „Einstellungen“",
        intro: "Gemeinsam für alle Projekte. Was nur ein Projekt betrifft, steht in dessen eigenen Einstellungen.",
        steps: {
          s1: "Erscheinungsbild und Sprache: Design — System, hell oder dunkel — und eine von sechs Oberflächensprachen.",
          s2: "„Agenten gleichzeitig“ — die globale Obergrenze über alle Projekte; „Dispatcher-Zyklus, Sekunden“ — wie oft orc nach Arbeit sucht; „Prüfungen gleichzeitig“ — parallele Verify-Befehle.",
          s3: "„Modelle in Auswahllisten“ — blende Modelle aus, die du nie nutzt; ein Projekt kann eine eigene Liste führen.",
          s4: "„Aufgaben-Vorlage“ und „Anweisung zur Konfliktlösung“ — der Text, den Agenten erhalten; orc füllt die Platzhalter.",
          s5: "„Muster für erschöpftes Kontingent“ — eine JSON-Liste regulärer Ausdrücke; ein Treffer schickt die Aufgabe in Wartestellung statt in einen Fehlschlag.",
          s6: "Haushalt: wie viele Tage Ereignisse aufbewahrt werden, die Gesamtgröße der Anhänge und das automatische Aufräumen der Worktrees gemergter Aufgaben.",
        },
        tip: "Einstellungen werden beim Speichern geprüft: Ein kaputter regulärer Ausdruck oder eine fehlerhafte Vorlage wird nicht angenommen.",
      },
      hotkeys: {
        title: "Tastenkürzel",
        where: "Überall auf dem Board",
        intro: "Sie funktionieren, wenn der Fokus nicht in einem Textfeld liegt und kein Fenster offen ist.",
        keys: {
          n: "Neue Aufgabe",
          slash: "Aufgaben durchsuchen",
          e: "Ereignis-Feed",
          d: "Board / Übersicht",
          bracket: "Seitenleiste einklappen",
          question: "Diese Anleitung",
          esc: "Fenster schließen",
        },
      },
    },
  },
  demos: {
    board: {
      title: "Der Weg einer Aufgabe über das Board",
      card: "Dunkles Design hinzufügen",
      captions: {
        c1: "Die Karte wartet im Rückstand — eine Notiz für später.",
        c2: "Du ziehst sie nach „Zu erledigen“. Das ist der ganze Start.",
        c3: "Der Dispatcher übernimmt sie: Worktree, Branch, `claude --bg`.",
        c4: "Der Agent ist fertig — `verify_cmd` prüft das Ergebnis.",
        c5: "Prüfung grün — Merge `--no-ff` in den Basis-Branch.",
        c6: "Fertig. Die Karte zeigt, was die Aufgabe an Tokens gekostet hat.",
      },
    },
    pipeline: {
      title: "Ein Dispatcher-Zyklus",
      queue: "Zu erledigen",
      captions: {
        c1: "Ein Platz ist frei — die Aufgabe wird aus der Warteschlange genommen.",
        c2: "Für sie werden ein eigener Worktree und Branch erstellt.",
        c3: "`claude --bg` startet mit deinem Auftrag.",
        c4: "Die Sitzung ruft `orc task done` auf und beendet ihren Zug.",
        c5: "`verify_cmd` läuft im Worktree der Aufgabe.",
        c6: "Merge in den Basis-Branch, eine Aufgabe nach der anderen.",
      },
    },
    input: {
      title: "Der Agent fragt — du antwortest",
      card: "Datenbank migrieren",
      otherCard: "Abhängigkeiten aktualisieren",
      question: "Die alte Tabelle users_v1 löschen oder behalten?",
      reply: "Vorerst behalten und ein TODO ergänzen",
      captions: {
        c1: "Der Agent arbeitet.",
        c2: "Er hat eine Frage: Die Karte wird magenta und rückt nach oben.",
        c3: "Du öffnest die Karte: die Frage ist ihre letzte Nachricht.",
        c4: "Du antwortest im Eingabefeld direkt darunter.",
        c5: "Die Antwort erreicht dieselbe Sitzung, und die Arbeit geht weiter.",
      },
    },
    conflict: {
      title: "Ein Konflikt geht an seinen Urheber zurück",
      taskA: "Neues Kopfzeilen-Design",
      taskB: "Kompaktes Board",
      captions: {
        c1: "Zwei Aufgaben wurden parallel fertig; beide zielen auf `dev`.",
        c2: "#41 wird zuerst gemergt.",
        c3: "#42 findet die Änderungen von #41 in denselben Dateien — ein Konflikt.",
        c4: "orc gibt den Konflikt an die Sitzung von #42 zurück: `dev` wird in ihren Branch gemergt.",
        c5: "Die Sitzung löst ihn inhaltlich und besteht die Prüfung erneut.",
        c6: "#42 wird gemergt. Du musstest nichts tun.",
      },
    },
    project: {
      title: "Ein Projekt hinzufügen",
      projectName: "my-app",
      captions: {
        c1: "Klick auf „+“ neben „Projekte“.",
        c2: "Gib einen Namen und den Repository-Pfad ein.",
        c3: "Der Verify-Befehl ist die Schranke vor dem Merge.",
        c4: "Wie viele Agenten gleichzeitig arbeiten dürfen.",
        c5: "Speichern — das Projekt erscheint in der Seitenleiste.",
      },
    },
  },
};
