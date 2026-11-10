import type { cardEn } from "./en";

export const cardFr: typeof cardEn = {
  "search": "Rechercher",
  "searchIn": "Rechercher : {label}",
  "nothingFound": "Rien trouvé",
  "agent": {
    "label": "Responsable",
    "none": "Non assignée",
    "noneHint": "Une personne s'en occupe : la carte ne part pas en travail",
    "noAgents": "Aucun agent pour l'instant. Seule une carte avec un agent part en travail.",
    "create": "Créer un agent"
  },
  "priority": {
    "label": "Priorité"
  },
  "branch": {
    "label": "Branche"
  },
  "dependsOn": {
    "label": "Attend",
    "none": "Rien"
  },
  "labels": {
    "label": "Étiquettes",
    "none": "Aucune étiquette",
    "searchLabel": "Chercher ou créer une étiquette",
    "searchPlaceholder": "Chercher ou saisir une nouvelle étiquette",
    "empty": "Pas encore d'étiquette. Saisissez un nom pour en créer une.",
    "create": "Créer « {name} »"
  },
  "startDate": {
    "label": "Date de début"
  },
  "dueDate": {
    "label": "Échéance",
    "overdue": "En retard"
  },
  "date": {
    "clear": "Effacer la date"
  },
  "status": {
    "label": "Statut",
    "lockedHint": "Une carte en cours est déplacée par sa session, pas à la main"
  },
  "addProperty": "Ajouter une propriété",
  "details": {
    "createdBy": "Créée par",
    "byCard": "Agent de la carte #{id}",
    "byRoutine": "Routine, exécution {run}",
    "byOwner": "Propriétaire",
    "updated": "Mise à jour",
    "finished": "Terminée"
  },
  "relations": {
    "heading": "Relations",
    "viewLabel": "Afficher les relations en",
    "list": "Liste",
    "tree": "Arbre",
    "chain": "Toute la chaîne",
    "comesNext": "Vient ensuite",
    "subtasks": "Sous-tâches",
    "noSubtasks": "Aucune sous-tâche",
    "wake": "Réveiller la carte quand toutes les sous-tâches sont terminées",
    "wakeHint": "La carte retourne une fois dans la file pour vérifier le résultat. Une sous-tâche échouée la retient. Désactivé par défaut.",
    "addSubtask": "Nouvelle sous-tâche",
    "attach": "Rattacher une carte existante comme sous-tâche",
    "attachEmpty": "Aucune carte à rattacher",
    "detach": "Retirer #{id} des sous-tâches",
    "editWaits": "Modifier ce qu'elle attend",
    "gone": "archivée ou supprimée",
    "failedHint": "#{id} a échoué : elle retient cette carte jusqu'à sa correction",
    "thisCard": "cette carte",
    "repeat": "affichée plus haut",
    "repeatHint": "Déjà plus haut dans l'arbre : elle attend plus d'une carte",
    "cycle": "boucle",
    "cycleHint": "La chaîne revient à cette carte : rien dans une boucle ne peut démarrer",
    "expand": "Déplier",
    "collapse": "Replier",
    "progressTitle": "{done} sous-tâches terminées sur {total}",
    "subtaskOf": "Sous-tâche de",
    "formParent": "Sous-tâche de #{id}",
    "formParentRemove": "Pas une sous-tâche",
    "stage": "Étape {n}",
    "noStage": "Sans étape",
    "setStage": "Étape de #{id}",
    "viaStage": "étape",
    "viaStageHint": "Attend l’étape précédente du parent : démarre quand toutes les cartes de cette étape sont terminées"
  },
  "form": {
    "createAndStart": "Créer et lancer",
    "startNeeds": "Pour lancer tout de suite, la carte doit avoir un responsable et une description"
  },
  "modal": {
    "saving": "Enregistrement…",
    "saved": "Enregistré",
    "saveFailed": "Impossible d'enregistrer la carte : {error}",
    "editDescription": "Modifier la description",
    "emptyDescription": "Ajoutez une description : c'est ce que reçoit l'agent",
    "details": "Détails",
    "toThreadEnd": "Aller à la fin de la conversation",
    "runsWith": "Lancé avec : {params}",
    "runsWithHint": "Défini dans l'agent et le projet, pas dans la carte",
  },
  "presence": {
    "person": "Une personne s'en occupe",
    "assigned": "assigné",
    "queued": "en file d'attente",
    "noAgentName": "Claude"
  },
  "log": {
    "heading": "Journal d'exécution",
    "active": "{count} en cours",
    "showAll": "Tout afficher",
    "showAllMore": "Tout afficher ({count} de plus)",
    "dialogTitle": "Journal d'exécution de #{id}",
    "spent": "Dépensé",
    "tokens": "Jetons",
    "agentTime": "Temps de l'agent",
    "tokensCount": "{tokens} jetons",
    "running": "en cours",
    "openThread": "Ouvrir dans le fil",
    "stop": "Arrêter",
    "retry": "Relancer dans la même session",
    "stopTitle": "Arrêter l'agent ?",
    "stopBody": "L'agent s'arrête maintenant et la carte vous attend comme échouée. Son travail reste : vous pouvez le reprendre ou réessayer.",
    "checkPassed": "Vérification réussie",
    "checkFailed": "Vérification échouée",
    "noOutput": "La vérification n'a rien affiché.",
    "exitCode": "Vérification terminée avec le code {code}",
    "noOutputCode": "La vérification n'a rien affiché et s'est terminée avec le code {code}.",
    "timedOut": "Vérification expirée",
    "noOutputTimedOut": "La vérification a été arrêtée par le délai.",
    "trigger": {
      "none": "Exécution",
      "start": "Démarrage",
      "rework": "Reprise du travail",
      "resume": "Repris par vous",
      "crash": "Repris après un plantage",
      "quota": "Repris après la limite",
      "verify_failed": "Renvoyé après la vérification",
      "conflict": "Résout un conflit de fusion",
      "message": "Votre message",
      "subtasks_done": "Réveillée : sous-tâches terminées",
      "wakeup": "Réveil"
    },
    "outcome": {
      "handed_in": "Remis",
      "failed": "Échoué",
      "stopped": "Arrêté",
      "quota": "Limite d'utilisation atteinte",
      "superseded": "Remplacé par l'exécution suivante",
      "sleeping": "Endormie jusqu'au réveil"
    },
    "merge": {
      "merged": "Fusionné dans {target}",
      "failed": "La fusion a échoué",
      "conflict": "Conflit avec {target}"
    }
  },
  "wakeups": {
    "heading": "Réveils",
    "at": "À {time}",
    "task": "Quand #{id} sera terminée",
    "deadline": "au plus tard {time}",
    "cancel": "Annuler le réveil",
    "history": "Historique ({count})",
    "fired": "Déclenché",
    "cancelled": "Annulé",
    "nothingLeft": "Rien ne réveillera cette carte : écrivez à l'agent, acceptez le travail ou fermez la carte.",
    "note": "Note"
  },
  "failure": {
    "details": "Détails techniques",
    "hideDetails": "Masquer les détails",
    "session_lost": {
      "reason": "La session est perdue.",
      "hint": "orc n'atteint plus la session de l'agent. Appuyez sur «{continue}» pour reprendre là où elle s'est arrêtée, ou sur «{retry}» pour repartir de zéro."
    },
    "quota_limit": {
      "reason": "La limite d'utilisation est atteinte.",
      "hint": "La limite doit d'abord se réinitialiser. Patientez, puis appuyez sur «{continue}»."
    },
    "project_unavailable": {
      "reason": "Le dossier du projet est inaccessible.",
      "hint": "Corrigez le chemin dans les réglages du projet (ou restaurez le dossier), puis appuyez sur «{retry}»."
    },
    "branch_gone": {
      "reason": "La branche ou la copie de travail de la tâche a disparu.",
      "hint": "Il n'y a plus rien d'où reprendre. Appuyez sur «{retry}» pour recommencer la tâche à zéro."
    },
    "check_failed_again": {
      "reason": "La vérification a échoué deux fois.",
      "hint": "Lisez la sortie de la vérification dans le journal d'exécution. Écrivez dans le champ quoi corriger et appuyez sur «{continue}», ou sur «{accept}» si le travail convient."
    },
    "conflict_unresolved": {
      "reason": "La branche entre en conflit avec la cible et n'a pas pu être réconciliée.",
      "hint": "Réconciliez les branches à la main dans le dépôt, puis appuyez sur «{resolved}»."
    },
    "stopped_by_owner": {
      "reason": "Vous avez arrêté l'agent.",
      "hint": "Son travail est conservé. Appuyez sur «{continue}» pour qu'il poursuive, ou sur «{retry}» pour recommencer."
    },
    "agent_reported": {
      "reason": "L'agent dit ne pas avoir pu terminer.",
      "hint": "Son explication est dans les détails techniques. Répondez dans le champ et appuyez sur «{continue}», ou sur «{retry}» pour recommencer."
    }
  },
  "deliverables": {
    "heading": "Fichiers",
    "open": "Ouvrir {name}",
    "download": "Télécharger",
    "versions": "Versions de {name}",
    "version": "Version {n}",
    "loading": "Chargement…",
    "tooBig": "Trop volumineux pour l'aperçu : téléchargez-le.",
    "failed": "Impossible de charger le fichier.",
    "noPreview": "Ce type n'est pas affiché ici : téléchargez-le.",
    "note": "Remis par l'agent. Il est affiché comme simple contenu et n'est jamais exécuté."
  },
  "notReady": {
    "title": "La carte n'est pas prête",
    "body": "La carte #{id} « {title} » ne peut pas encore partir en travail.",
    "assignee": "Personne n'est assigné, donc une personne s'en occupe. Assignez un agent.",
    "fix": "Corriger"
  },
  "quickActions": {
    "heading": "Actions rapides",
    "hint": "Messages prêts pour l'agent. Ils apparaissent sur la carte et avec / dans le champ de réponse.",
    "defaults": {
      "review": "Relire",
      "tests": "Écrire des tests",
      "summary": "Résumer",
      "simplify": "Simplifier"
    },
    "title": "Titre",
    "prompt": "Texte pour l'agent",
    "add": "Ajouter une action",
    "remove": "Retirer {title}",
    "up": "Monter {title}",
    "down": "Descendre {title}",
    "reset": "Rétablir l'ensemble par défaut",
    "unavailable": "Dans cet état, l'agent ne reçoit pas de message.",
    "menu": "Actions rapides",
    "none": "Aucune action correspondante",
    "empty": "Aucune action rapide.",
    "sent": "Envoyé : {title}"
  },
  "settings": {
    "heading": "Cartes de tâches",
    "headingHint": "Ce qu'une carte affiche et avec quoi une nouvelle commence.",
    "defaultAgent": "Responsable par défaut",
    "defaultAgentHint": "Les nouvelles cartes sont assignées à cet agent.",
    "defaultPriority": "Priorité par défaut",
    "properties": "Propriétés de la carte",
    "propertiesHint": "Une propriété masquée reste visible si la carte contient une valeur.",
    "staleAgent": "L'agent #{id} n'est plus disponible",
    "ownLabel": "Réglages propres à ce projet",
    "ownHint": "Désactivé : le projet suit les réglages d'orc."
  }
};
