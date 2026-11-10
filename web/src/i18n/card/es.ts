import type { cardEn } from "./en";

export const cardEs: typeof cardEn = {
  "search": "Buscar",
  "searchIn": "Buscar: {label}",
  "nothingFound": "No se encontró nada",
  "agent": {
    "label": "Responsable",
    "none": "Sin asignar",
    "noneHint": "Se encarga una persona: la tarjeta no pasa a trabajo",
    "noAgents": "Aún no hay agentes. Solo pasa a trabajo una tarjeta con agente.",
    "create": "Crear un agente"
  },
  "priority": {
    "label": "Prioridad"
  },
  "branch": {
    "label": "Rama"
  },
  "dependsOn": {
    "label": "Espera a",
    "none": "Nada"
  },
  "labels": {
    "label": "Etiquetas",
    "none": "Sin etiquetas",
    "searchLabel": "Buscar o crear una etiqueta",
    "searchPlaceholder": "Buscar o escribir una nueva",
    "empty": "Aún no hay etiquetas. Escribe un nombre para crear una.",
    "create": "Crear «{name}»"
  },
  "startDate": {
    "label": "Fecha de inicio"
  },
  "dueDate": {
    "label": "Fecha límite",
    "overdue": "Vencida"
  },
  "date": {
    "clear": "Quitar la fecha"
  },
  "status": {
    "label": "Estado",
    "lockedHint": "Una tarjeta en curso la mueve su sesión, no la mano"
  },
  "addProperty": "Añadir propiedad",
  "details": {
    "createdBy": "Creada por",
    "byCard": "Agente de la tarjeta #{id}",
    "byRoutine": "Rutina, ejecución {run}",
    "byOwner": "Propietario",
    "updated": "Actualizada",
    "finished": "Terminada"
  },
  "relations": {
    "heading": "Relaciones",
    "viewLabel": "Mostrar relaciones como",
    "list": "Lista",
    "tree": "Árbol",
    "chain": "Toda la cadena",
    "comesNext": "Viene después",
    "subtasks": "Subtareas",
    "noSubtasks": "Sin subtareas",
    "wake": "Reactivar la tarjeta cuando todas las subtareas estén listas",
    "wakeHint": "La tarjeta vuelve una vez a la cola para revisar el resultado. Una subtarea fallida la retiene. Desactivado por defecto.",
    "addSubtask": "Nueva subtarea",
    "attach": "Adjuntar una tarjeta existente como subtarea",
    "attachEmpty": "No hay tarjetas para adjuntar",
    "detach": "Quitar #{id} de las subtareas",
    "editWaits": "Cambiar lo que espera",
    "gone": "archivada o eliminada",
    "failedHint": "#{id} falló: retiene esta tarjeta hasta que se corrija",
    "thisCard": "esta tarjeta",
    "repeat": "mostrada arriba",
    "repeatHint": "Ya está más arriba en el árbol: espera a más de una tarjeta",
    "cycle": "anillo",
    "cycleHint": "La cadena vuelve a esta tarjeta: nada en un anillo puede empezar",
    "expand": "Expandir",
    "collapse": "Contraer",
    "progressTitle": "{done} de {total} subtareas hechas",
    "subtaskOf": "Subtarea de",
    "formParent": "Subtarea de #{id}",
    "formParentRemove": "No es subtarea",
    "stage": "Etapa {n}",
    "noStage": "Sin etapa",
    "setStage": "Etapa de #{id}",
    "viaStage": "etapa",
    "viaStageHint": "Espera a la etapa anterior del padre: empieza cuando todas las tarjetas de esa etapa están terminadas"
  },
  "form": {
    "createAndStart": "Crear e iniciar",
    "startNeeds": "Para iniciar de inmediato, la tarjeta necesita responsable y descripción"
  },
  "modal": {
    "saving": "Guardando…",
    "saved": "Guardado",
    "saveFailed": "No se pudo guardar la tarjeta: {error}",
    "editDescription": "Editar la descripción",
    "emptyDescription": "Añade una descripción: es lo que recibe el agente",
    "details": "Detalles",
    "toThreadEnd": "Ir al final de la conversación",
    "runsWith": "Se ejecuta con: {params}",
    "runsWithHint": "Se define en el agente y el proyecto, no en la tarjeta",
  },
  "presence": {
    "person": "Se encarga una persona",
    "assigned": "asignado",
    "queued": "en cola",
    "noAgentName": "Claude"
  },
  "log": {
    "heading": "Registro de ejecución",
    "active": "{count} en curso",
    "showAll": "Ver todo",
    "showAllMore": "Ver todo ({count} más)",
    "dialogTitle": "Registro de ejecución de #{id}",
    "spent": "Gastado",
    "tokens": "Tokens",
    "agentTime": "Tiempo del agente",
    "tokensCount": "{tokens} tokens",
    "running": "en curso",
    "openThread": "Abrir en el hilo",
    "stop": "Detener",
    "retry": "Ejecutar de nuevo en la misma sesión",
    "stopTitle": "¿Detener el agente?",
    "stopBody": "El agente se detiene ahora y la tarjeta te espera como fallida. Su trabajo se conserva: puedes reanudarlo o reintentarlo.",
    "checkPassed": "Comprobación superada",
    "checkFailed": "Comprobación fallida",
    "noOutput": "La comprobación no imprimió nada.",
    "exitCode": "Comprobación terminada con código {code}",
    "noOutputCode": "La comprobación no imprimió nada y terminó con el código {code}.",
    "timedOut": "Comprobación agotó el tiempo",
    "noOutputTimedOut": "El tiempo límite detuvo la comprobación.",
    "trigger": {
      "none": "Ejecución",
      "start": "Inicio",
      "rework": "Retrabajo",
      "resume": "Reanudado por ti",
      "crash": "Reanudado tras un fallo",
      "quota": "Reanudado tras el límite",
      "verify_failed": "Devuelto tras la comprobación",
      "conflict": "Resuelve un conflicto de merge",
      "message": "Tu mensaje",
      "subtasks_done": "Reactivada: subtareas listas",
      "wakeup": "Despertada"
    },
    "outcome": {
      "handed_in": "Entregado",
      "failed": "Fallido",
      "stopped": "Detenido",
      "quota": "Alcanzó el límite de uso",
      "superseded": "Sustituido por la siguiente ejecución",
      "sleeping": "Dormida hasta despertar"
    },
    "merge": {
      "merged": "Fusionado en {target}",
      "failed": "El merge falló",
      "conflict": "Conflicto con {target}"
    }
  },
  "wakeups": {
    "heading": "Despertares",
    "at": "A las {time}",
    "task": "Cuando #{id} esté lista",
    "deadline": "a más tardar {time}",
    "cancel": "Cancelar el despertar",
    "history": "Historial ({count})",
    "fired": "Disparado",
    "cancelled": "Cancelado",
    "nothingLeft": "Nada despertará esta tarjeta: escribe al agente, acepta el trabajo o cierra la tarjeta.",
    "note": "Nota"
  },
  "failure": {
    "details": "Detalles técnicos",
    "hideDetails": "Ocultar detalles",
    "session_lost": {
      "reason": "Se perdió la sesión.",
      "hint": "orc ya no alcanza la sesión del agente. Pulsa «{continue}» para seguir donde quedó, o «{retry}» para empezar de cero."
    },
    "quota_limit": {
      "reason": "Se alcanzó el límite de uso.",
      "hint": "Primero tiene que restablecerse el límite. Espera y pulsa «{continue}»."
    },
    "project_unavailable": {
      "reason": "La carpeta del proyecto no está disponible.",
      "hint": "Corrige la ruta en los ajustes del proyecto (o restaura la carpeta) y pulsa «{retry}»."
    },
    "branch_gone": {
      "reason": "La rama o la copia de trabajo de la tarea ya no existe.",
      "hint": "No queda nada desde donde seguir. Pulsa «{retry}» para empezar la tarea de nuevo."
    },
    "check_failed_again": {
      "reason": "La comprobación falló dos veces.",
      "hint": "Lee la salida de la comprobación en el registro de ejecución. Escribe en el campo qué corregir y pulsa «{continue}», o pulsa «{accept}» si el trabajo está bien."
    },
    "conflict_unresolved": {
      "reason": "La rama choca con la de destino y no se pudo conciliar.",
      "hint": "Concilia las ramas a mano en el repositorio y pulsa «{resolved}»."
    },
    "stopped_by_owner": {
      "reason": "Detuviste al agente.",
      "hint": "Su trabajo se conserva. Pulsa «{continue}» para que siga, o «{retry}» para empezar de nuevo."
    },
    "agent_reported": {
      "reason": "El agente dice que no pudo terminar.",
      "hint": "Su explicación está en los detalles técnicos. Responde en el campo y pulsa «{continue}», o «{retry}» para empezar de nuevo."
    }
  },
  "deliverables": {
    "heading": "Archivos",
    "open": "Abrir {name}",
    "download": "Descargar",
    "versions": "Versiones de {name}",
    "version": "Versión {n}",
    "loading": "Cargando…",
    "tooBig": "Demasiado grande para la vista previa: descárgalo.",
    "failed": "No se pudo cargar el archivo.",
    "noPreview": "Este tipo no se muestra aquí: descárgalo.",
    "note": "Entregado por el agente. Se muestra como contenido y nunca se ejecuta."
  },
  "notReady": {
    "title": "La tarjeta no está lista",
    "body": "La tarjeta #{id} «{title}» aún no puede pasar a trabajo.",
    "assignee": "No hay nadie asignado, así que se encarga una persona. Asigna un agente.",
    "fix": "Corregir"
  },
  "quickActions": {
    "heading": "Acciones rápidas",
    "hint": "Mensajes listos para el agente. Aparecen en la tarjeta y con / en el campo de respuesta.",
    "defaults": {
      "review": "Revisar",
      "tests": "Escribir pruebas",
      "summary": "Resumir",
      "simplify": "Simplificar"
    },
    "title": "Título",
    "prompt": "Texto para el agente",
    "add": "Añadir una acción",
    "remove": "Quitar {title}",
    "up": "Subir {title}",
    "down": "Bajar {title}",
    "reset": "Restaurar el conjunto por defecto",
    "unavailable": "En este estado el agente no recibe mensajes.",
    "menu": "Acciones rápidas",
    "none": "Ninguna acción coincide",
    "empty": "No hay acciones rápidas.",
    "sent": "Enviado: {title}"
  },
  "settings": {
    "heading": "Tarjetas de tareas",
    "headingHint": "Qué muestra una tarjeta y con qué empieza una nueva.",
    "defaultAgent": "Responsable por defecto",
    "defaultAgentHint": "Las tarjetas nuevas se asignan a este agente.",
    "defaultPriority": "Prioridad por defecto",
    "properties": "Propiedades de la tarjeta",
    "propertiesHint": "Una propiedad oculta sigue visible si la tarjeta tiene un valor en ella.",
    "staleAgent": "El agente #{id} ya no está disponible",
    "ownLabel": "Ajustes propios para este proyecto",
    "ownHint": "Desactivado: el proyecto sigue los ajustes de orc."
  }
};
