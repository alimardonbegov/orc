<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../web/public/brand/orc-mark-dark.svg">
    <img src="../../web/public/brand/orc-mark-light.svg" alt="orc logo" width="96" height="96">
  </picture>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <a href="README.es.md">Español</a> ·
  <b>Français</b> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a>
</p>

# orc

**Une file de tâches pour Claude Code.** orc exécute chaque tâche dans son propre worktree git avec `claude --bg`, vérifie le résultat avec votre propre commande et fusionne les branches terminées dans votre branche, une à la fois.

> Ceci est une version abrégée. La documentation complète est en anglais.

## Pourquoi orc

- **Une tâche, un worktree.** Chaque tâche démarre dans son propre worktree via `claude --bg` : les sessions ne partagent jamais de contexte ni de copie de travail.
- **Fusion FIFO, strictement une à la fois.** Les branches terminées sont fusionnées avec `--no-ff` dans l'ordre où elles sont prêtes. Si la branche est occupée, la tâche attend dans la file au lieu d'échouer.
- **Petits conflits, résolus par leur auteur.** En cas de conflit, orc le renvoie à la session qui a écrit le code, car elle sait pourquoi le code est ainsi.
- **Votre propre abonnement.** Les sessions tournent avec votre CLI Claude Code, sur votre machine, et comptent sur l'abonnement que vous avez déjà.

## Fonctionnalités

- **Tableau kanban** avec Backlog, To do, In progress et Done. Tout ce qui vous attend (une question, un échec, un conflit) est regroupé dans la bande « Waiting for me ». Actions groupées et vues enregistrées.
- **Répartiteur automatique.** Toutes les 30 secondes, il prend des tâches dans « To do », dans le respect des limites de workers et des dépendances.
- **Porte de vérification.** Votre `verify_cmd` (tests, linter, build) s'exécute dans le worktree de la tâche. Rien n'est fusionné avec un contrôle au rouge.
- **Agents.** Un modèle, un niveau d'effort, un mode de permissions et un prompt sous un nom et un avatar. Un agent n'appartient pas à un projet, a sa propre page avec son activité en direct et peut avoir sa mémoire.
- **Chats avec les agents**, dans n'importe quel projet ou aucun, dans un worktree privé où rien n'est fusionné. Le responsable d'un projet voit le tableau et propose des tâches, qui n'arrivent au backlog qu'avec votre accord.
- **Des agents qui planifient le travail.** Une session, un chat ou un responsable peut découper une grosse fonctionnalité en cartes liées avec `orc task add`, `batch` et `link`, les ordonner par dépendances et étapes, se mettre en veille avec `orc task wakeup` et être réveillé quand les sous-tâches sont finies. Le répartiteur exécute la chaîne tout seul.
- **Routines.** Une consigne et un horaire (toutes les N minutes, heures ou jours, ou cron). Pas besoin de projet : sans projet, chaque exécution est un chat avec l'agent.
- **Questions et réponses en direct.** Permissions, questions et validations de plan apparaissent sur la carte, et votre réponse arrive dans la même session en cours.
- **Jetons, quota et synthèse.** Jetons par carte, limites de 5 heures et hebdomadaires de votre compte, et une vue de synthèse (réussite, durées, coût).
- **Six langues d'interface** (anglais, espagnol, français, allemand, portugais et russe), thèmes clair et sombre.

## Comment ça marche

1. Ajoutez un projet : le chemin d'un dépôt git, un `verify_cmd` et une limite de workers.
2. Créez un agent et une carte, assignez-la à l'agent et déplacez-la dans « To do ».
3. Le répartiteur crée un worktree sur une nouvelle branche `orc/task-N` et lance `claude --bg` avec la consigne.
4. L'agent termine avec `orc task done` ; orc exécute `verify_cmd`. Un échec retourne à la même session.
5. Les tâches vérifiées sont fusionnées en FIFO avec `git merge --no-ff`. Les conflits retournent à la session qui a écrit le code, puis à vous.

## Démarrage rapide

Il faut macOS ou Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 20.19+ ou 22.12+, git 2.38+ et la CLI [Claude Code](https://github.com/anthropics/claude-code) connectée.

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup          # uv sync, npm ci, web UI build
uv run orc doctor   # environment check
make start          # run the server in the background
make stop           # stop it
```

Ouvrez <http://127.0.0.1:8765>, ajoutez un projet, créez une carte et faites-la glisser vers « To do ».

**Sécurité.** orc exécute du code en votre nom, sans supervision : c'est son rôle. Il n'écoute que sur loopback ; n'exposez jamais le port. Lisez la section [Security](../../README.md#security) avant de l'utiliser.

## Documentation (en anglais)

- [Agents creating tasks](../agent-tasks.md)
- [How orc works](../how-it-works.md)
- [Agents, leads, chats and memory](../internals/agents.md)
- [Installing from a wheel](../install.md)

## Licence

[MIT](../../LICENSE)
