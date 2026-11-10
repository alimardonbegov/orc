<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../web/public/brand/orc-mark-dark.svg">
    <img src="../../web/public/brand/orc-mark-light.svg" alt="orc logo" width="96" height="96">
  </picture>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.fr.md">Français</a> ·
  <b>Deutsch</b> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a>
</p>

# orc

**Eine Aufgabenwarteschlange für Claude Code.** orc führt jede Aufgabe in einem eigenen Git-Worktree mit `claude --bg` aus, prüft das Ergebnis mit deinem eigenen Befehl und führt fertige Branches nacheinander in deinen Branch zusammen.

> Dies ist eine Kurzfassung. Die vollständige Dokumentation ist auf Englisch.

## Warum orc

- **Eine Aufgabe, ein Worktree.** Jede Aufgabe startet über `claude --bg` in einem eigenen Worktree: Sitzungen teilen weder Kontext noch Arbeitskopie.
- **FIFO-Merge, strikt einer nach dem anderen.** Fertige Branches werden mit `--no-ff` in der Reihenfolge zusammengeführt, in der sie fertig wurden. Ist der Branch belegt, wartet die Aufgabe in der Warteschlange, statt zu scheitern.
- **Kleine Konflikte, vom Autor gelöst.** Bei einem Konflikt gibt orc ihn an dieselbe Sitzung zurück, die den Code geschrieben hat, denn sie weiß, warum der Code so aussieht.
- **Dein eigenes Abo.** Die Sitzungen laufen über deine Claude-Code-CLI auf deinem Rechner und zählen gegen das Abo, das du schon hast.

## Funktionen

- **Kanban-Board** mit Backlog, To do, In progress und Done. Alles, was dich braucht (eine Frage, ein Fehler, ein Konflikt), sammelt sich im Streifen „Waiting for me“. Sammelaktionen und gespeicherte Ansichten.
- **Automatischer Dispatcher.** Alle 30 Sekunden holt er Aufgaben aus „To do“, unter Beachtung von Worker-Limits und Abhängigkeiten.
- **Verify-Gate.** Dein `verify_cmd` (Tests, Linter, Build) läuft im Worktree der Aufgabe. Bei rotem Check wird nichts gemergt.
- **Agenten.** Modell, Aufwand, Berechtigungsmodus und Prompt unter einem Namen mit Avatar. Ein Agent gehört keinem Projekt, hat eine eigene Seite mit Live-Aktivität und kann ein eigenes Gedächtnis haben.
- **Chats mit Agenten**, in jedem Projekt oder in keinem, in einem privaten Worktree, aus dem nichts gemergt wird. Der Projektleiter sieht das Board und schlägt Aufgaben vor, die nur mit deiner Zustimmung ins Backlog kommen.
- **Agenten, die Arbeit planen.** Eine Sitzung, ein Chat oder ein Projektleiter kann ein großes Feature mit `orc task add`, `batch` und `link` in verknüpfte Karten aufteilen, sie über Abhängigkeiten und Stufen ordnen, mit `orc task wakeup` schlafen gehen und geweckt werden, wenn die Unteraufgaben fertig sind. Der Dispatcher führt die Kette selbst aus.
- **Routinen.** Eine Anweisung plus ein Zeitplan (alle N Minuten, Stunden oder Tage, oder Cron). Sie brauchen kein Projekt: ohne Projekt wird jeder Lauf zu einem Chat mit dem Agenten.
- **Fragen und Live-Antworten.** Berechtigungen, Fragen und Plan-Freigaben erscheinen auf der Karte, und deine Antwort geht in dieselbe laufende Sitzung.
- **Tokens, Kontingent und Übersicht.** Tokens pro Karte, 5-Stunden- und Wochenlimits deines Kontos und eine Übersicht mit Erfolgsquote, Dauer und Kosten.
- **Sechs Oberflächensprachen** (Englisch, Spanisch, Französisch, Deutsch, Portugiesisch und Russisch), helles und dunkles Design.

## So funktioniert es

1. Füge ein Projekt hinzu: den Pfad eines Git-Repositorys, ein `verify_cmd` und ein Worker-Limit.
2. Erstelle einen Agenten und eine Karte, weise sie dem Agenten zu und schiebe sie nach „To do“.
3. Der Dispatcher legt einen Worktree auf einem neuen Branch `orc/task-N` an und startet `claude --bg` mit dem Auftrag.
4. Der Agent beendet die Arbeit mit `orc task done`; orc führt `verify_cmd` aus. Ein Fehler geht an dieselbe Sitzung zurück.
5. Geprüfte Aufgaben werden per FIFO mit `git merge --no-ff` zusammengeführt. Konflikte gehen an die Sitzung zurück, die den Code geschrieben hat, danach an dich.

## Schnellstart

Du brauchst macOS oder Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 20.19+ oder 22.12+, git 2.38+ und die angemeldete [Claude-Code](https://github.com/anthropics/claude-code)-CLI.

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup          # uv sync, npm ci, web UI build
uv run orc doctor   # environment check
make start          # run the server in the background
make stop           # stop it
```

Öffne <http://127.0.0.1:8765>, füge ein Projekt hinzu, erstelle eine Karte und ziehe sie nach „To do“.

**Sicherheit.** orc führt Code als du aus, ohne Aufsicht: das ist seine Aufgabe. Es lauscht nur auf Loopback; gib den Port niemals frei. Lies den Abschnitt [Security](../../README.md#security), bevor du es nutzt.

## Dokumentation (auf Englisch)

- [Agents creating tasks](../agent-tasks.md)
- [How orc works](../how-it-works.md)
- [Agents, leads, chats and memory](../internals/agents.md)
- [Installing from a wheel](../install.md)

## Lizenz

[MIT](../../LICENSE)
