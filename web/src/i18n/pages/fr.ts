import type { PagesDictionary } from "./en";

/** French texts for the About / How it works pages (see pages/en.ts). */
export const pagesFr: PagesDictionary = {
  nav: {
    about: "À propos d'orc",
    guide: "Comment ça marche",
    helpNav: "À propos et aide",
    backToBoard: "Retour au tableau",
  },
  demo: {
    play: "Lire",
    pause: "Pause",
    replay: "Rejouer",
    goToStep: "Étape {step}",
    stepOf: "{step} / {total}",
    regionLabel: "Démo animée : {title}",
  },
  about: {
    eyebrow: "Orchestrateur de tâches pour Claude Code",
    title: "Un tableau kanban qui fait ses tâches lui-même",
    lead: "Dépose une carte dans « À faire » et arrête de cliquer. Toutes les 30 secondes, le répartiteur prend des tâches dans la file, donne à chacune son propre git worktree, y lance `claude --bg`, vérifie le résultat avec ta commande de vérification et, si c'est vert, fusionne la branche lui-même — `--no-ff`, une à la fois, sans pull request. Remplis la file le soir, lis le diff le matin.",
    ctaGuide: "Comment ça marche",
    ctaAddProject: "Ajouter un projet",
    flowHeading: "Trois étapes, puis ça tourne tout seul",
    flow: {
      queue: {
        title: "Tu mets en file",
        body: "Une carte avec une consigne claire pour l'agent va dans « À faire ». Priorité, modèle, branche de base et dépendances se règlent directement sur la carte.",
      },
      work: {
        title: "L'agent travaille",
        body: "Chaque tâche a son propre worktree et sa branche `orc/task-<id>`. Plusieurs agents travaillent en parallèle sans se marcher dessus.",
      },
      ship: {
        title: "orc vérifie et fusionne",
        body: "C'est ton `verify_cmd` qui décide, pas la parole de l'agent. Vert — fusion dans la branche de base ; rouge — la tâche revient avec une explication.",
      },
    },
    featuresHeading: "Ce qu'orc fait et que les autres ne font pas",
    featuresLead: "Séparément, presque chaque fonction existe quelque part. L'ensemble complet — tableau, répartiteur automatique, vérification stricte, fusion automatique sans PR, conflits renvoyés à leur auteur et suivi du quota — personne d'autre ne le réunit.",
    features: {
      dispatcher: {
        title: "Répartiteur en mode pull",
        body: "Pas de bouton « démarrer » : le répartiteur prend les tâches lui-même et respecte les limites d'agents par projet et globales.",
      },
      verify: {
        title: "Vérification avant fusion",
        body: "Ta commande — tests, linter, build — s'exécute dans le worktree de la tâche. Rien n'est fusionné tant que la vérification est rouge.",
      },
      merge: {
        title: "Fusion automatique sans PR",
        body: "`--no-ff` dans la branche de base de la tâche, strictement une à la fois. Si tu modifies cette branche à la main, orc enregistre d'abord tes modifications dans un commit wip séparé.",
      },
      conflict: {
        title: "Les conflits retournent à leur auteur",
        body: "Un conflit de fusion sémantique va à la session qui a écrit le code — elle sait pourquoi c'est fait ainsi. Trois tentatives, puis un humain.",
      },
      quota: {
        title: "Le quota est une ressource",
        body: "Les limites de l'abonnement Claude sont toujours à l'écran, et quand elles sont atteintes, les tâches attendent la réinitialisation au lieu d'échouer.",
      },
      live: {
        title: "Les réponses arrivent dans une session vivante",
        body: "L'agent a posé une question — la carte remonte avec un badge, et ta réponse arrive dans la même session en quelques secondes, sans redémarrage.",
      },
      cost: {
        title: "Le coût de chaque tâche",
        body: "Les tokens de toutes les sessions et sous-agents d'une tâche, directement depuis les transcriptions de Claude Code, ventilés par modèle.",
      },
      summary: {
        title: "Un résumé sur la durée",
        body: "Débit, taux de réussite, temps par tâche, frictions et tâches les plus coûteuses — à côté du tableau, à une touche.",
      },
    },
    forHeading: "Pour qui",
    forItems: {
      solo: "Un développeur sans relecteur : là où les équipes s'ouvrent des pull requests, ici c'est `verify_cmd` qui décide.",
      subscription: "Fonctionne via la CLI Claude Code sur ta machine — avec l'abonnement que tu paies déjà, sans réserve de crédits séparée.",
      local: "Tout reste local : le serveur n'écoute que sur 127.0.0.1, et les données vivent à côté, dans SQLite.",
    },
    notHeading: "Ce qu'orc n'est pas, volontairement",
    notLead: "Ces créneaux appartiennent à des équipes qui les construisent depuis des années. orc ne s'y mesure pas — il prend ce que personne d'autre n'a pris.",
    notItems: {
      multiAgent: {
        title: "Pas multi-agents",
        body: "Uniquement Claude Code. Ni Codex, ni Cursor, ni OpenCode.",
      },
      diff: {
        title: "Pas de revue de diff dans l'interface",
        body: "Le résultat est un commit fusionné — lis le diff dans ton éditeur ou dans git.",
      },
      cloud: {
        title: "Ni cloud ni mode équipe",
        body: "Une machine, une personne, localhost.",
      },
    },
    limitsHeading: "Limites actuelles",
    limitsLead: "À savoir avant de confier à orc un vrai dépôt.",
    limits: {
      local: {
        title: "Claude Code uniquement, cette machine uniquement",
        body: "L'API ne répond que sur loopback ; les autres appareils n'y ont pas accès. Le démarrage automatique à l'ouverture de session n'existe que pour macOS (LaunchAgent) — sous Linux, lance le serveur toi-même ou utilise Docker.",
      },
      planMode: {
        title: "Pas de mode de permission « plan »",
        body: "Une session qui attend l'approbation d'un plan paraît « au travail » pour le répartiteur et resterait bloquée en silence, donc ce mode n'est pas encore proposé.",
      },
      quotaRegex: {
        title: "La détection du quota est une hypothèse",
        body: "Les motifs qui reconnaissent une limite épuisée sont une supposition et peuvent être ajustés dans les réglages. Après 5 nouvelles tentatives de quota d'affilée, la tâche échoue avec une explication.",
      },
      delivery: {
        title: "Les messages arrivent au prochain appel d'outil",
        body: "Une note à une session en cours passe par un hook — en général en quelques secondes, mais une session qui réfléchit longtemps la récupère plus tard. Tu peux alors l'interrompre.",
      },
      rework: {
        title: "« Reprendre » exige un worktree vivant",
        body: "« Reprendre » continue la même session dans la même copie de travail. Une fois le worktree supprimé, il ne reste qu'une nouvelle tâche.",
      },
      images: {
        title: "Les images voyagent sous forme de chemins",
        body: "`claude --bg` accepte un seul argument texte, donc l'agent reçoit le chemin de l'image et l'ouvre avec Read. png, jpeg, gif et webp jusqu'à 10 Mo.",
      },
      autocommit: {
        title: "Tes modifications non commitées sont commitées",
        body: "Avant de fusionner dans une branche où tu travailles, orc commite les changements suivis sous `wip(orc): auto-commit before merge #id`. Le push reste désactivé tant que tu ne l'actives pas.",
      },
      stop: {
        title: "Pas encore de « Stop » en douceur",
        body: "Une tâche en cours ne peut qu'être fermée manuellement ou supprimée. La mettre en pause et la renvoyer dans l'arriéré en gardant le travail reste un projet.",
      },
    },
    risksHeading: "Risques acceptés",
    risksLead: "Pas du travail inachevé, mais des choix délibérés — les éliminer reviendrait à renoncer à la raison d'être d'orc.",
    risks: {
      noHuman: {
        title: "Aucun humain entre l'agent et origin",
        body: "La fusion, et le push s'il est activé, suivent le rapport que l'agent écrit lui-même. `verify_cmd` est la seule voix indépendante.",
      },
      verifyEdited: {
        title: "verify_cmd exécute du code que l'agent vient de modifier",
        body: "Si la vérification appelle `make test` ou `npm test`, l'agent a pu modifier ce script dans la même tâche. Lancer orc sur le dépôt de quelqu'un d'autre, c'est comme lancer son Makefile.",
      },
      localRead: {
        title: "Tout processus local peut lire l'API",
        body: "Les modifications exigent le jeton de la console, pas les lectures : la liste des tâches, les descriptions et les chemins des dépôts sont visibles par tout programme lancé sous ton utilisateur.",
      },
    },
    roadmapHeading: "La suite",
    roadmapLead: "Des idées appuyées par une étude ou un plan. Pas de dates — l'ordre dépend de ce qui gêne le plus au quotidien.",
    roadmapStatus: {
      plan: "plan rédigé",
      research: "étudié",
      idea: "idée",
    },
    roadmap: {
      stop: {
        title: "Bouton « Stop »",
        body: "Arrêter une tâche en cours et la renvoyer dans l'arriéré en gardant son travail — puis reprendre au même endroit ou repartir de zéro.",
      },
      planMode: {
        title: "Mode plan",
        body: "Lire le signal « approuver le plan » de la session et l'afficher comme une carte « attend une réponse » ordinaire.",
      },
      ide: {
        title: "Ouvrir dans l'éditeur",
        body: "Des liens depuis une carte vers son worktree dans VS Code et vers la session Claude vivante ; plus tard, un mode « humain aux commandes ».",
      },
      windows: {
        title: "Plages horaires",
        body: "Laisser le répartiteur travailler seulement à certaines heures — par exemple la nuit, quand le quota est inutilisé.",
      },
      review: {
        title: "Revue avant fusion",
        body: "Une option : après une vérification verte, la tâche attend ton accord au lieu de fusionner tout de suite.",
      },
      sessionLog: {
        title: "Journal de session dans la carte",
        body: "Voir ce que fait l'agent en ce moment sans ouvrir de terminal.",
      },
    },
    footer: "orc se prononce « ork ». L'histoire complète est dans README.md et docs/ du dépôt.",
    brandBook: "Charte graphique",
  },
  guide: {
    title: "Comment ça marche",
    lead: "Pas à pas, d'un tableau vide à une tâche fusionnée. Chaque section indique où se trouvent les choses dans l'interface et ce qu'il faut y régler.",
    tocLabel: "Sommaire",
    where: "Où",
    tip: "Astuce",
    sections: {
      start: {
        title: "Avant de commencer",
        where: "Terminal, dans le dossier d'orc",
        intro: "orc tourne sur ta machine et pilote la CLI Claude Code. Voici ce qu'il lui faut :",
        steps: {
          s1: "macOS ou Linux, Python 3.12+, Node.js avec npm, et `uv`.",
          s2: "La CLI Claude Code dans le PATH, connectée à ton abonnement : `claude --bg` doit fonctionner dans un terminal.",
          s3: "Un dépôt git pour chaque projet — chaque tâche travaille dans son propre `git worktree`.",
          s4: "Installation unique : `make setup`, puis `make start` — la console s'ouvre sur http://127.0.0.1:8765.",
          s5: "En option : `make install-agent` lance le serveur à chaque ouverture de session macOS, et `make docker-up` le fait tourner dans Docker à la place.",
        },
        tip: "`make status` indique si le serveur est vivant, et `make logs` affiche son journal.",
      },
      project: {
        title: "Ajouter un projet",
        where: "Barre latérale → « + » à côté de « Projets »",
        intro: "Un projet, c'est un dépôt git plus les règles pour y travailler. Tout ici se modifie plus tard dans les réglages du projet — l'engrenage dans l'en-tête du tableau.",
        steps: {
          s1: "Nom et chemin du dépôt. Un dossier sans git ? orc propose de lancer `git init` avec un premier commit vide sur main.",
          s2: "« Agents à la fois » — combien de tâches de ce projet tournent en parallèle. Les réglages d'orc ont aussi un plafond global.",
          s3: "« Comment lancer les agents » — modèle, effort et mode de permission par défaut pour les nouvelles tâches. Chaque tâche peut les remplacer.",
          s4: "« Branche de base » — d'où partent les branches des tâches et où les résultats sont fusionnés. Vide signifie la branche actuellement extraite dans le dépôt.",
          s5: "« Vérification avant fusion » — la commande de vérification (par exemple `make test`) et son délai. C'est le principal garde-fou : sans elle, la fusion se fie uniquement à la parole de l'agent.",
          s6: "« Après la fusion » — push vers origin. Désactivé par défaut : orc ne pousse jamais de lui-même tant que tu ne l'actives pas.",
          s7: "« Mémoire du projet » — modifie CLAUDE.md ici même : des instructions permanentes que lit chaque agent de ce projet.",
          s8: "Appuie sur « Enregistrer ». Les réglages ne sont enregistrés que par le bouton, et la fenêtre ne se ferme pas sur un clic à l'extérieur tant qu'il reste des modifications non enregistrées.",
        },
        tip: "Tu as déplacé le dossier du dépôt ? Change le chemin dans les réglages du projet — orc reconnecte les copies de travail des tâches avec `git worktree repair`.",
      },
      task: {
        title: "Créer une tâche",
        where: "Bouton « Tâche » dans l'en-tête du tableau, ou la touche N",
        intro: "Le titre de la carte est pour toi ; l'agent reçoit le champ « Tâche pour l'agent ». Rédige-le comme si tu briefais un collègue qui ne connaît pas le contexte.",
        steps: {
          s1: "Titre — un nom court pour le tableau.",
          s2: "« Tâche pour l'agent » — quoi faire, où ça se trouve et comment le vérifier. Colle les captures d'écran là où elles ont leur place : Ctrl+V, glisser-déposer ou le bouton « Image ». « Texte / Aperçu » montre ce que l'agent verra.",
          s3: "« Paramètres d'exécution » — modèle, effort et mode de permission. Un champ vide reprend la valeur du projet et la suit si le projet change.",
          s4: "Modes de permission : `auto` — Claude décide lui-même ; `acceptEdits` — modifie les fichiers sans demander ; `dontAsk` — ne demande jamais, et ce qui n'est pas pré-autorisé ne s'exécute tout simplement pas ; `bypassPermissions` — aucune vérification, uniquement pour tes propres dépôts.",
          s5: "Priorité, branche de base et « Bloquée par des tâches » : une tâche dépendante attend que les tâches dont elle dépend soient terminées, même dans d'autres projets.",
          s6: "Laisse la carte dans « Arriéré » comme une note, ou mets-la dans « À faire » — le répartiteur la prend au cycle suivant. Une carte sans consigne ne peut pas aller dans « À faire ».",
        },
        tip: "La branche de base peut être changée tant que la carte est dans « Arriéré » ou « À faire ». Une fois la tâche lancée, la copie de travail existe déjà et c'est trop tard.",
      },
      dispatcher: {
        title: "Ce que fait le répartiteur",
        where: "Bas de la barre latérale — le panneau du répartiteur",
        intro: "Il y a un seul répartiteur pour tous les projets. Toutes les `poll_interval_sec` secondes (30 par défaut), il fait un passage — un cycle :",
        steps: {
          s1: "Prend des tâches dans « À faire » tant qu'il y a des places libres et crée un worktree avec la branche `orc/task-<id>` à partir de la branche de base de la tâche.",
          s2: "Y lance `claude --bg` avec ta consigne, ton modèle et ton mode de permission. La carte passe dans « En cours ».",
          s3: "Quand la session se termine, lit `.orchestrator/report.json`. Si l'agent signale un échec, la tâche revient avec son explication.",
          s4: "Lance `verify_cmd` dans le worktree — le badge « vérification ». Rouge : la tâche retourne à l'agent avec la sortie de la vérification.",
          s5: "Vert : la tâche rejoint la file de fusion — le badge « fusion » : `--no-ff` dans la branche de base, une tâche à la fois. Puis « Terminé ».",
          s6: "Le panneau du répartiteur affiche le pouls et les agents occupés. « Pause » arrête la distribution de nouvelles tâches ; « Lancer maintenant » fait un passage sans attendre le minuteur.",
        },
        tip: "Les yeux de l'orc sur le logo brillent tant que le répartiteur est vivant et pulsent pendant que les agents travaillent.",
      },
      input: {
        title: "Quand l'agent a besoin de toi",
        where: "Barre « M'attendent » au-dessus du tableau",
        intro: "Le magenta est la seule couleur de l'interface qui appelle un humain. Une carte qui a besoin de toi remonte en haut de sa colonne et reçoit un badge.",
        steps: {
          s1: "L'agent a demandé une autorisation, posé une question ou proposé un plan — la carte reçoit « attend une réponse », et le compteur de l'en-tête augmente.",
          s2: "Ouvre la carte : la question de l'agent est en haut. Réponds dans « Réponse à Claude » — les captures d'écran fonctionnent ici aussi.",
          s3: "La réponse arrive dans la même session en quelques secondes, et celle-ci reprend là où elle s'était arrêtée.",
          s4: "Tu peux écrire à une session au travail sans qu'on te le demande : le bouton « À la session » à côté du champ de note. Le texte arrive à son prochain appel d'outil sans l'interrompre.",
          s5: "Si la session ne récupère pas le message pendant quelques minutes, la carte le signale et propose « Interrompre la session » — le texte est alors livré avec un redémarrage.",
        },
        tip: "Les questions des autres projets apparaissent comme une puce séparée dans la même barre — le répartiteur est commun, donc rien ne se perd.",
      },
      problems: {
        title: "Conflits, échecs et quota",
        where: "Badges sur la carte et dans sa fenêtre",
        intro: "La plupart des problèmes se règlent sans toi. Voici ce qu'orc fait seul et quand il t'appelle.",
        steps: {
          s1: "Conflit de fusion : la tâche qui arrive en second trouve les modifications d'une autre dans ses fichiers. orc renvoie le conflit à la session qui a écrit le code ; elle le résout selon le sens, repasse la vérification et retourne dans la file de fusion. Après trois tentatives — le badge « conflit ».",
          s2: "Une tâche échouée est rouge, et la raison est dans la carte. « Réessayer » repart de zéro ; « Reprendre la session » continue la même session.",
          s3: "Quota : quand la limite Claude est atteinte, la tâche attend avec le badge « quota », et le répartiteur la reprend après la réinitialisation.",
          s4: "« non approuvé » : Claude Code ne lance pas de sessions dans un dossier que tu n'as pas approuvé. « Faire confiance au dossier et lancer » règle ça une fois par projet.",
          s5: "« copie modifiée » : la branche cible a une fusion, un rebase ou un cherry-pick inachevé. orc n'y touche pas — termine l'opération, et la tâche continue.",
        },
        tip: "Le réglage d'orc « Les conflits de fusion sont résolus par la session elle-même » — désactive-le si tu veux que chaque conflit te parvienne.",
      },
      finish: {
        title: "Terminer et faire le ménage",
        where: "Fenêtre de la tâche",
        intro: "Une tâche terminée peut être poursuivie, et une tâche bloquée peut être fermée à la main.",
        steps: {
          s1: "« Reprendre » sur une carte terminée : écris ce qu'il faut corriger — la carte revient dans « À faire », continue la même session dans le même worktree et est fusionnée une seconde fois.",
          s2: "« Fermer manuellement » est une sortie de secours pour une carte bloquée : la session s'arrête, la carte passe dans « Terminé » sans vérification ni fusion, et la branche reste non fusionnée. Glisser la carte dans « Terminé » fait la même chose.",
          s3: "« Archiver » est réversible : la carte disparaît du tableau et de la vue du répartiteur. Le filtre « Archive » dans l'en-tête affiche les tâches archivées, et « Restaurer depuis l'archive » en ramène une.",
          s4: "« Supprimer » est définitif : la tâche, sa conversation et — sauf si tu décoches — sa branche et son worktree.",
          s5: "« Terminé » a son propre menu de tri : plus récentes d'abord, plus anciennes d'abord ou échecs d'abord.",
          s6: "Une tâche terminée reste en haut de « Terminé » comme non vue tant que tu n'as pas ouvert sa carte ou coché la case dans son coin. Décoche-la et la tâche remonte en haut. Les compteurs de non vus sont sur le bouton « Terminé » et dans la liste des projets ; cela se désactive dans les réglages du projet.",
        },
        tip: "orc peut supprimer lui-même les worktrees des tâches fusionnées — voir « Nettoyer les worktrees des tâches fusionnées » dans les réglages d'orc. Tant que le worktree existe, « Reprendre » fonctionne.",
      },
      branches: {
        title: "Branches et worktrees",
        where: "En-tête du tableau — les boutons branche et dossier à côté de l'engrenage du projet",
        intro: "Les branches et les copies de travail vivent dans git, pas dans la base de données d'orc, donc ces fenêtres les lisent directement.",
        steps: {
          s1: "« Branches du projet » montre chaque branche et qui la tient : ouverte dans le dépôt, base des nouvelles tâches, non fusionnée, tâches qui y travaillent.",
          s2: "Crée, renomme et supprime des branches ici. Renommer déplace chaque carte qui faisait référence à la branche ; supprimer déplace les tâches en attente vers la branche de base du projet.",
          s3: "Les opérations dangereuses sont expliquées, pas cachées : un cadenas avec la raison quand elles casseraient un travail en cours, et une confirmation listant les pertes quand la décision t'appartient.",
          s4: "« Worktrees » liste chaque copie de travail du projet avec sa tâche, son état et sa taille, et permet de supprimer celles dont tu n'as plus besoin.",
        },
        tip: "Une branche supprimée en dehors d'orc ne disparaît pas en silence : la liste la marque « cette branche n'existe plus ».",
      },
      overview: {
        title: "Résumé, limites et événements",
        where: "Bascule « Tableau / Résumé » et bas de la barre latérale",
        intro: "Le tableau répond à « dois-je intervenir maintenant ». Tout le reste répond à des questions de plus long terme.",
        steps: {
          s1: "« Résumé » (la touche D) : tuiles, débit dans le temps, durée des tâches, ventilations par modèle, effort, mode de permission et projet, frictions et tâches les plus coûteuses. Portée — le projet courant ou tous ; période — 7, 30 ou 90 jours ou depuis le début.",
          s2: "Les limites Claude en bas de la barre latérale : les fenêtres de 5 heures et hebdomadaire de ton COMPTE, avec l'heure de réinitialisation. Le bouton d'actualisation interroge Claude immédiatement — cela prend quelques secondes.",
          s3: "Le badge pièce sur une carte est le total de tokens de la tâche sur toutes les sessions et sous-agents. La fenêtre de la tâche le ventile par modèle et par agent.",
          s4: "Événements (la touche E) : lancements, questions des agents, résultats des vérifications ; les nouveaux sont marqués. « Tous les événements et filtres » ouvre le flux complet avec des filtres par projet et par niveau.",
        },
        tip: "L'argent dans le résumé mesure l'usage aux prix de l'API — avec un abonnement, ces dollars ne sont pas facturés.",
      },
      settings: {
        title: "Réglages d'orc",
        where: "Barre latérale → « Réglages »",
        intro: "Communs à tous les projets. Ce qui est propre à un projet se trouve dans ses propres réglages.",
        steps: {
          s1: "Apparence et langue : thème — système, clair ou sombre — et une des six langues de l'interface.",
          s2: "« Agents à la fois » — le plafond global pour tous les projets ; « Cycle du répartiteur, secondes » — à quelle fréquence orc cherche du travail ; « Vérifications à la fois » — commandes de vérification en parallèle.",
          s3: "« Modèles dans les listes déroulantes » — masque les modèles que tu n'utilises jamais ; un projet peut garder sa propre liste.",
          s4: "« Modèle de tâche » et « Instruction de résolution de conflit » — le texte que reçoivent les agents ; orc remplit les espaces réservés.",
          s5: "« Motifs de quota épuisé » — une liste JSON d'expressions régulières ; une correspondance met la tâche en attente au lieu de la faire échouer.",
          s6: "Entretien : combien de jours garder les événements, la taille totale des pièces jointes, et le nettoyage automatique des worktrees des tâches fusionnées.",
        },
        tip: "Les réglages sont validés à l'enregistrement : une expression régulière ou un modèle cassé ne sera pas accepté.",
      },
      hotkeys: {
        title: "Raccourcis clavier",
        where: "N'importe où sur le tableau",
        intro: "Ils fonctionnent quand le focus n'est pas dans un champ de texte et qu'aucune fenêtre n'est ouverte.",
        keys: {
          n: "Nouvelle tâche",
          slash: "Rechercher des tâches",
          e: "Flux d'événements",
          d: "Tableau / Résumé",
          bracket: "Replier la barre latérale",
          question: "Ce guide",
          esc: "Fermer une fenêtre",
        },
      },
    },
  },
  demos: {
    board: {
      title: "Le parcours d'une tâche sur le tableau",
      card: "Ajouter un thème sombre",
      captions: {
        c1: "La carte attend dans l'arriéré — une note pour plus tard.",
        c2: "Tu la glisses dans « À faire ». C'est tout le lancement.",
        c3: "Le répartiteur la prend : worktree, branche, `claude --bg`.",
        c4: "L'agent a terminé — `verify_cmd` vérifie le résultat.",
        c5: "Vérification verte — fusion `--no-ff` dans la branche de base.",
        c6: "Terminé. La carte montre ce que la tâche a coûté en tokens.",
      },
    },
    pipeline: {
      title: "Un cycle du répartiteur",
      queue: "À faire",
      captions: {
        c1: "Il y a une place libre — la tâche est prise dans la file.",
        c2: "Un worktree et une branche séparés sont créés pour elle.",
        c3: "`claude --bg` démarre avec ta consigne.",
        c4: "La session se termine et écrit son rapport.",
        c5: "`verify_cmd` s'exécute dans le worktree de la tâche.",
        c6: "Fusion dans la branche de base, une tâche à la fois.",
      },
    },
    input: {
      title: "L'agent demande — tu réponds",
      card: "Migrer la base de données",
      otherCard: "Mettre à jour les dépendances",
      question: "Supprimer l'ancienne table users_v1 ou la garder ?",
      reply: "Garde-la pour l'instant et ajoute un TODO",
      captions: {
        c1: "L'agent travaille.",
        c2: "Il a une question : la carte devient magenta et remonte.",
        c3: "Tu ouvres la carte et vois la question.",
        c4: "Tu réponds dans « Réponse à Claude ».",
        c5: "La réponse arrive dans la même session, et le travail continue.",
      },
    },
    conflict: {
      title: "Un conflit retourne à son auteur",
      taskA: "Refonte de l'en-tête",
      taskB: "Tableau compact",
      captions: {
        c1: "Deux tâches ont fini en parallèle ; les deux visent `dev`.",
        c2: "#41 est fusionnée en premier.",
        c3: "#42 trouve les modifications de #41 dans les mêmes fichiers — un conflit.",
        c4: "orc renvoie le conflit à la session de #42 : `dev` est fusionnée dans sa branche.",
        c5: "La session le résout selon le sens et repasse la vérification.",
        c6: "#42 est fusionnée. Tu n'as rien eu à faire.",
      },
    },
    project: {
      title: "Ajouter un projet",
      projectName: "my-app",
      captions: {
        c1: "Clique sur « + » à côté de « Projets ».",
        c2: "Saisis un nom et le chemin du dépôt.",
        c3: "La commande de vérification est le garde-fou avant la fusion.",
        c4: "Combien d'agents peuvent travailler à la fois.",
        c5: "Enregistre — le projet apparaît dans la barre latérale.",
      },
    },
  },
};
