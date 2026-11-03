import type { PagesDictionary } from "./en";

/** Spanish texts for the About / How it works pages (see pages/en.ts). */
export const pagesEs: PagesDictionary = {
  nav: {
    about: "Acerca de orc",
    guide: "Cómo funciona",
    helpNav: "Acerca de y ayuda",
    backToBoard: "Volver al tablero",
  },
  demo: {
    play: "Reproducir",
    pause: "Pausa",
    replay: "Repetir",
    goToStep: "Paso {step}",
    stepOf: "{step} / {total}",
    regionLabel: "Demo animada: {title}",
  },
  about: {
    eyebrow: "Orquestador de tareas para Claude Code",
    title: "Un tablero kanban que hace sus propias tareas",
    lead: "Suelta una tarjeta en «Por hacer» y deja de hacer clic. Cada 30 segundos el despachador toma tareas de la cola, da a cada una su propio git worktree, ejecuta allí `claude --bg`, comprueba el resultado con tu comando de verificación y, si sale en verde, fusiona la rama por sí mismo — `--no-ff`, de una en una, sin pull request. Llena la cola por la noche y lee el diff por la mañana.",
    ctaGuide: "Cómo funciona",
    ctaAddProject: "Añadir proyecto",
    flowHeading: "Tres pasos, y luego funciona solo",
    flow: {
      queue: {
        title: "Tú pones en cola",
        body: "Una tarjeta con un encargo claro para el agente va a «Por hacer». Prioridad, modelo, rama base y dependencias se definen en la propia tarjeta.",
      },
      work: {
        title: "El agente trabaja",
        body: "Cada tarea recibe su propio worktree y la rama `orc/task-<id>`. Varios agentes trabajan en paralelo sin pisarse.",
      },
      ship: {
        title: "orc verifica y fusiona",
        body: "Decide tu `verify_cmd`, no la palabra del agente. Verde: fusión en la rama base; rojo: la tarea vuelve con una explicación.",
      },
    },
    featuresHeading: "Lo que orc hace y otros no",
    featuresLead: "Por separado, casi todas las funciones existen en algún sitio. El paquete completo — tablero, despachador automático, verificación estricta, fusión automática sin PR, conflictos devueltos a su autor y control de cuota — no lo reúne nadie más.",
    features: {
      dispatcher: {
        title: "Despachador de tipo pull",
        body: "No hay botón «iniciar»: el despachador toma las tareas por sí mismo y respeta los límites de agentes por proyecto y globales.",
      },
      verify: {
        title: "Verificación antes de fusionar",
        body: "Tu comando — pruebas, linter, compilación — se ejecuta en el worktree de la tarea. Nada se fusiona con una verificación en rojo.",
      },
      merge: {
        title: "Fusión automática sin PR",
        body: "`--no-ff` en la rama base de la tarea, estrictamente de una en una. Si estás editando esa rama a mano, orc primero guarda tus cambios como un commit wip aparte.",
      },
      conflict: {
        title: "Los conflictos vuelven a su autor",
        body: "Un conflicto de fusión semántico va a la sesión que escribió el código: sabe por qué se hizo así. Tres intentos, y luego un humano.",
      },
      quota: {
        title: "La cuota es un recurso",
        body: "Los límites de la suscripción de Claude están siempre a la vista y, cuando se agotan, las tareas esperan al reinicio en vez de fallar.",
      },
      live: {
        title: "Las respuestas llegan a una sesión viva",
        body: "El agente preguntó algo: la tarjeta sube con una insignia, y tu respuesta llega a la misma sesión en segundos, sin reiniciar.",
      },
      cost: {
        title: "El coste de cada tarea",
        body: "Tokens de todas las sesiones y subagentes de una tarea, directamente de las transcripciones de Claude Code, desglosados por modelo.",
      },
      summary: {
        title: "Un resumen a largo plazo",
        body: "Rendimiento, tasa de éxito, tiempo por tarea, fricción y las tareas más caras — junto al tablero, a una tecla de distancia.",
      },
    },
    forHeading: "Para quién es",
    forItems: {
      solo: "Un desarrollador sin revisor: donde los equipos se abren pull requests entre sí, aquí decide `verify_cmd`.",
      subscription: "Funciona a través de la CLI de Claude Code en tu máquina — con la suscripción que ya pagas, sin un saldo de créditos aparte.",
      local: "Todo queda en local: el servidor escucha solo en 127.0.0.1, y los datos viven en SQLite a su lado.",
    },
    notHeading: "Lo que orc deliberadamente no es",
    notLead: "Esto es terreno de equipos que llevan años construyéndolo. orc no compite ahí: se queda con lo que nadie más ha tomado.",
    notItems: {
      multiAgent: {
        title: "No es multiagente",
        body: "Solo Claude Code. Ni Codex, ni Cursor, ni OpenCode.",
      },
      diff: {
        title: "Sin revisión de diff en la interfaz",
        body: "El resultado es un commit fusionado: lee el diff en tu editor o en git.",
      },
      cloud: {
        title: "Sin nube ni modo de equipo",
        body: "Una máquina, una persona, localhost.",
      },
    },
    limitsHeading: "Limitaciones actuales",
    limitsLead: "Conviene saberlas antes de darle a orc un repositorio real.",
    limits: {
      local: {
        title: "Solo Claude Code, solo esta máquina",
        body: "La API solo responde en loopback; otros dispositivos no pueden alcanzarla. El inicio automático al iniciar sesión solo existe para macOS (LaunchAgent): en Linux arranca el servidor tú mismo o usa Docker.",
      },
      planMode: {
        title: "Sin el modo de permisos «plan»",
        body: "Una sesión que espera la aprobación del plan parece «trabajando» para el despachador y se colgaría en silencio, así que el modo aún no se ofrece.",
      },
      quotaRegex: {
        title: "La detección de cuota es una hipótesis",
        body: "Los patrones que reconocen un límite agotado son una suposición y se pueden ajustar en los ajustes. Tras 5 reintentos seguidos por cuota, la tarea falla con una explicación.",
      },
      delivery: {
        title: "Los mensajes llegan en la siguiente llamada a herramienta",
        body: "Una nota a una sesión en marcha pasa por un hook: normalmente en segundos, pero una sesión que piensa mucho rato la recoge más tarde. Entonces puedes interrumpirla.",
      },
      rework: {
        title: "Retomar necesita un worktree vivo",
        body: "«Retomar» continúa la misma sesión en la misma copia de trabajo. Una vez eliminado el worktree, solo queda crear una tarea nueva.",
      },
      images: {
        title: "Las imágenes viajan como rutas de archivo",
        body: "`claude --bg` acepta un único argumento de texto, así que el agente recibe la ruta de la imagen y la abre con Read. png, jpeg, gif y webp de hasta 10 MB.",
      },
      autocommit: {
        title: "Tus cambios sin confirmar se confirman",
        body: "Antes de fusionar en una rama en la que estás trabajando, orc confirma los cambios rastreados como `wip(orc): auto-commit before merge #id`. El push sigue desactivado hasta que lo actives.",
      },
      stop: {
        title: "Aún no hay un «Detener» suave",
        body: "Una tarea en curso solo se puede cerrar manualmente o eliminar. Pausarla y devolverla a pendientes conservando el trabajo sigue siendo un plan.",
      },
    },
    risksHeading: "Riesgos asumidos",
    risksLead: "No es trabajo pendiente, sino decisiones deliberadas: cerrarlas significaría renunciar a aquello para lo que existe orc.",
    risks: {
      noHuman: {
        title: "No hay un humano entre el agente y origin",
        body: "La fusión, y el push si está activado, se basan en el informe que escribe el propio agente. `verify_cmd` es la única voz independiente.",
      },
      verifyEdited: {
        title: "verify_cmd ejecuta código que el agente acaba de editar",
        body: "Si la verificación llama a `make test` o `npm test`, el agente pudo cambiar ese script en la misma tarea. Ejecutar orc sobre el repositorio de otra persona es como ejecutar su Makefile.",
      },
      localRead: {
        title: "Cualquier proceso local puede leer la API",
        body: "Los cambios requieren el token de la consola, las lecturas no: la lista de tareas, las descripciones y las rutas de los repositorios son visibles para cualquier programa que se ejecute con tu usuario.",
      },
    },
    roadmapHeading: "Lo que viene",
    roadmapLead: "Ideas con investigación o un plan detrás. Sin fechas: el orden depende de lo que más moleste en el uso diario.",
    roadmapStatus: {
      plan: "plan escrito",
      research: "investigado",
      idea: "idea",
    },
    roadmap: {
      stop: {
        title: "Botón «Detener»",
        body: "Detener una tarea en curso y devolverla a pendientes conservando su trabajo — luego continuar desde el mismo punto o empezar de nuevo.",
      },
      planMode: {
        title: "Modo plan",
        body: "Leer la señal «aprobar plan» de la sesión y mostrarla como una tarjeta normal «esperando respuesta».",
      },
      ide: {
        title: "Abrir en el editor",
        body: "Enlaces desde una tarjeta a su worktree en VS Code y a la sesión viva de Claude; más adelante, un modo «humano al volante».",
      },
      windows: {
        title: "Franjas horarias",
        body: "Dejar que el despachador trabaje solo a ciertas horas — por ejemplo, de noche, mientras la cuota está ociosa.",
      },
      review: {
        title: "Revisión antes de fusionar",
        body: "Un indicador opcional: tras una verificación en verde, la tarea espera tu visto bueno en lugar de fusionarse de inmediato.",
      },
      sessionLog: {
        title: "Registro de la sesión en la tarjeta",
        body: "Ver qué está haciendo el agente ahora mismo sin abrir una terminal.",
      },
    },
    footer: "orc se pronuncia «ork». La historia completa está en README.md y docs/ del repositorio.",
    brandBook: "Manual de marca",
  },
  guide: {
    title: "Cómo funciona",
    lead: "Paso a paso, de un tablero vacío a una tarea fusionada. Cada sección indica dónde está cada cosa en la interfaz y qué configurar allí.",
    tocLabel: "Contenido",
    where: "Dónde",
    tip: "Consejo",
    sections: {
      start: {
        title: "Antes de empezar",
        where: "Terminal, en la carpeta de orc",
        intro: "orc se ejecuta en tu máquina y maneja la CLI de Claude Code. Esto es lo que necesita:",
        steps: {
          s1: "macOS o Linux, Python 3.12+, Node.js con npm y `uv`.",
          s2: "La CLI de Claude Code en el PATH, con sesión iniciada en tu suscripción: `claude --bg` debe funcionar en una terminal.",
          s3: "Un repositorio git para cada proyecto: cada tarea trabaja en su propio `git worktree`.",
          s4: "Configuración única: `make setup`, luego `make start` — la consola se abre en http://127.0.0.1:8765.",
          s5: "Opcional: `make install-agent` arranca el servidor en cada inicio de sesión de macOS, y `make docker-up` lo ejecuta en Docker en su lugar.",
        },
        tip: "`make status` te dice si el servidor está vivo, y `make logs` muestra su registro.",
      },
      project: {
        title: "Añadir un proyecto",
        where: "Barra lateral → «+» junto a «Proyectos»",
        intro: "Un proyecto es un repositorio git más las reglas para trabajar en él. Todo esto se puede cambiar después en los ajustes del proyecto: el engranaje en la cabecera del tablero.",
        steps: {
          s1: "Nombre y ruta del repositorio. ¿Una carpeta sin git? orc ofrece ejecutar `git init` con un primer commit vacío en main.",
          s2: "«Agentes a la vez»: cuántas tareas de este proyecto se ejecutan en paralelo. Los ajustes de orc también tienen un límite global.",
          s3: "«Cómo ejecutar agentes»: modelo, esfuerzo y modo de permisos por defecto para las tareas nuevas. Cada tarea puede anularlos.",
          s4: "«Rama base»: de dónde parten las ramas de las tareas y adónde vuelven los resultados. Vacío significa la rama abierta en ese momento en el repositorio.",
          s5: "«Verificación antes de fusionar»: el comando de verificación (por ejemplo, `make test`) y su tiempo límite. Es la principal barrera de seguridad: sin ella, la fusión confía solo en la palabra del agente.",
          s6: "«Después de fusionar»: push a origin. Desactivado por defecto: orc nunca hace push por su cuenta hasta que lo actives.",
          s7: "«Memoria del proyecto»: edita CLAUDE.md aquí mismo — instrucciones permanentes que lee cada agente de este proyecto.",
          s8: "Pulsa «Guardar». Los ajustes solo se guardan con el botón, y el diálogo no se cierra al hacer clic fuera mientras haya cambios sin guardar.",
        },
        tip: "¿Moviste la carpeta del repositorio? Cambia la ruta en los ajustes del proyecto: orc reenlaza las copias de trabajo de las tareas con `git worktree repair`.",
      },
      task: {
        title: "Crear una tarea",
        where: "Botón «Tarea» en la cabecera del tablero, o la tecla N",
        intro: "El título de la tarjeta es para ti; el agente recibe el campo «Tarea para el agente». Escríbelo como se lo explicarías a un colega que no conoce el contexto.",
        steps: {
          s1: "Título: un nombre corto para el tablero.",
          s2: "«Tarea para el agente»: qué hacer, dónde está y cómo comprobarlo. Pega capturas justo donde correspondan: Ctrl+V, arrastrar y soltar o el botón «Imagen». «Texto / Vista previa» muestra lo que verá el agente.",
          s3: "«Parámetros de ejecución»: modelo, esfuerzo y modo de permisos. Un campo vacío toma el valor del proyecto y lo sigue si el proyecto cambia.",
          s4: "Modos de permisos: `auto` — Claude decide por sí mismo; `acceptEdits` — edita archivos sin preguntar; `dontAsk` — nunca pregunta, y lo que no está preaprobado simplemente no se ejecuta; `bypassPermissions` — sin ninguna comprobación, solo para tus propios repositorios.",
          s5: "Prioridad, rama base y «Bloqueada por tareas»: una tarea dependiente espera hasta que terminen las tareas de las que depende, incluso en otros proyectos.",
          s6: "Deja la tarjeta en «Pendientes» como nota, o ponla en «Por hacer»: el despachador la tomará en el siguiente ciclo. Una tarjeta con el encargo vacío no puede ir a «Por hacer».",
        },
        tip: "La rama base se puede cambiar mientras la tarjeta está en «Pendientes» o «Por hacer». Una vez que la tarea arranca, la copia de trabajo ya existe y es tarde.",
      },
      dispatcher: {
        title: "Qué hace el despachador",
        where: "Parte inferior de la barra lateral: el panel del despachador",
        intro: "Hay un solo despachador para todos los proyectos. Cada `poll_interval_sec` segundos (30 por defecto) hace una pasada, un ciclo:",
        steps: {
          s1: "Toma tareas de «Por hacer» mientras haya huecos libres y crea un worktree con la rama `orc/task-<id>` a partir de la rama base de la tarea.",
          s2: "Ejecuta allí `claude --bg` con tu encargo, modelo y modo de permisos. La tarjeta pasa a «En curso».",
          s3: "Cuando la sesión termina, lee `.orchestrator/report.json`. Si el agente informa de un fallo, la tarea vuelve con su explicación.",
          s4: "Ejecuta `verify_cmd` en el worktree: la insignia «verificando». Rojo: la tarea vuelve al agente con la salida de la verificación.",
          s5: "Verde: la tarea entra en la cola de fusión — la insignia «fusionando»: `--no-ff` en la rama base, una tarea cada vez. Luego, «Hecho».",
          s6: "El panel del despachador muestra el latido y los agentes ocupados. «Pausar» detiene la asignación de tareas nuevas; «Ejecutar ahora» hace una pasada sin esperar al temporizador.",
        },
        tip: "Los ojos del orco del logotipo brillan mientras el despachador está vivo y laten mientras los agentes trabajan.",
      },
      input: {
        title: "Cuando el agente te necesita",
        where: "Barra «Me esperan» encima del tablero",
        intro: "El magenta es el único color de la interfaz que llama a un humano. Una tarjeta que te necesita sube al principio de su columna y recibe una insignia.",
        steps: {
          s1: "El agente pidió permiso, hizo una pregunta o propuso un plan: la tarjeta recibe «esperando respuesta», y el contador de la cabecera aumenta.",
          s2: "Abre la tarjeta: la pregunta del agente está arriba. Responde en «Respuesta para Claude»; aquí también funcionan las capturas.",
          s3: "La respuesta llega a la misma sesión en segundos, y esta continúa donde se detuvo.",
          s4: "Puedes escribir a una sesión en marcha sin que te lo pida: el botón «A la sesión» junto al campo de nota. El texto llega en su siguiente llamada a herramienta sin interrumpirla.",
          s5: "Si la sesión no recoge el mensaje en unos minutos, la tarjeta lo indica y ofrece «Interrumpir sesión»: entonces el texto se entrega con un reinicio.",
        },
        tip: "Las preguntas de otros proyectos aparecen como un chip aparte en la misma barra: el despachador es común, así que nada se pierde.",
      },
      problems: {
        title: "Conflictos, fallos y cuota",
        where: "Insignias en la tarjeta y en su ventana",
        intro: "La mayoría de los problemas se resuelven sin ti. Esto es lo que orc hace por su cuenta y cuándo te llama.",
        steps: {
          s1: "Conflicto de fusión: la tarea que llega segunda encuentra cambios ajenos en sus archivos. orc devuelve el conflicto a la sesión que escribió el código; esta lo resuelve por su sentido, vuelve a pasar la verificación y regresa a la cola de fusión. Tras tres intentos, la insignia «conflicto».",
          s2: "Una tarea fallida está en rojo, y el motivo está en la tarjeta. «Reintentar» empieza desde cero; «Reanudar sesión» continúa la misma sesión.",
          s3: "Cuota: cuando se agota el límite de Claude, la tarea espera con la insignia «cuota», y el despachador la reanuda tras el reinicio.",
          s4: "«sin confianza»: Claude Code no inicia sesiones en una carpeta en la que no has confiado. «Confiar en la carpeta e iniciar» lo arregla una vez por proyecto.",
          s5: "«copia sucia»: la rama destino tiene un merge, rebase o cherry-pick sin terminar. orc no la toca: termina la operación y la tarea continuará.",
        },
        tip: "El ajuste de orc «Los conflictos de fusión los resuelve la propia sesión»: desactívalo si quieres que cada conflicto llegue a ti.",
      },
      finish: {
        title: "Terminar y limpiar",
        where: "Ventana de la tarea",
        intro: "Una tarea terminada se puede continuar, y una atascada se puede cerrar a mano.",
        steps: {
          s1: "«Retomar» en una tarjeta hecha: escribe qué corregir — la tarjeta vuelve a «Por hacer», continúa la misma sesión en el mismo worktree y se fusiona por segunda vez.",
          s2: "«Cerrar manualmente» es una salida de emergencia para una tarjeta atascada: la sesión se detiene, la tarjeta pasa a «Hecho» sin verificación ni fusión, y la rama queda sin fusionar. Arrastrar la tarjeta a «Hecho» hace lo mismo.",
          s3: "«Archivar» es reversible: la tarjeta desaparece del tablero y de la vista del despachador. El filtro «Archivo» de la cabecera muestra las tareas archivadas, y «Restaurar del archivo» devuelve una.",
          s4: "«Eliminar» es definitivo: la tarea, su conversación y — salvo que desmarques la casilla — su rama y su worktree.",
          s5: "«Hecho» tiene su propio menú de orden: más recientes primero, más antiguas primero o fallos primero.",
          s6: "Una tarea terminada queda arriba en «Hecho» como sin ver hasta que abras su tarjeta o marques la casilla de su esquina. Quita la marca y la tarea vuelve arriba. Los contadores de sin ver están en el botón «Hecho» y en la lista de proyectos; se desactiva en los ajustes del proyecto.",
        },
        tip: "orc puede eliminar por sí mismo los worktrees de las tareas fusionadas: mira «Limpiar worktrees de tareas fusionadas» en los ajustes de orc. Mientras exista el worktree, «Retomar» funciona.",
      },
      branches: {
        title: "Ramas y worktrees",
        where: "Cabecera del tablero: los botones de rama y carpeta junto al engranaje del proyecto",
        intro: "Las ramas y las copias de trabajo viven en git, no en la base de datos de orc, así que estas ventanas las leen directamente.",
        steps: {
          s1: "«Ramas del proyecto» muestra cada rama y quién la usa: abierta en el repositorio, base de tareas nuevas, no fusionada, tareas trabajando en ella.",
          s2: "Crea, renombra y elimina ramas aquí. Renombrar mueve todas las tarjetas que hacían referencia a la rama; eliminar pasa las tareas en espera a la rama base del proyecto.",
          s3: "Las operaciones peligrosas se explican, no se ocultan: un candado con el motivo cuando romperían trabajo en curso, y una confirmación con la lista de pérdidas cuando la decisión es tuya.",
          s4: "«Worktrees» lista cada copia de trabajo del proyecto con su tarea, estado y tamaño, y te permite eliminar las que ya no necesites.",
        },
        tip: "Una rama eliminada fuera de orc no desaparece en silencio: la lista la marca como «esta rama ya no existe».",
      },
      overview: {
        title: "Resumen, límites y eventos",
        where: "El conmutador «Tablero / Resumen» y la parte inferior de la barra lateral",
        intro: "El tablero responde a «¿tengo que intervenir ahora mismo?». Todo lo demás responde a preguntas más largas.",
        steps: {
          s1: "«Resumen» (la tecla D): indicadores, rendimiento en el tiempo, duración de las tareas, desgloses por modelo, esfuerzo, modo de permisos y proyecto, fricción y las tareas más caras. Alcance: el proyecto actual o todos; período: 7, 30 o 90 días o todo el tiempo.",
          s2: "Límites de Claude en la parte inferior de la barra lateral: las ventanas de 5 horas y semanal de tu CUENTA, con la hora de reinicio. El botón de actualizar pregunta a Claude en ese momento: tarda unos segundos.",
          s3: "La insignia de la moneda en una tarjeta es el total de tokens de la tarea en todas sus sesiones y subagentes. La ventana de la tarea lo desglosa por modelo y por agente.",
          s4: "Eventos (la tecla E): ejecuciones, preguntas de agentes, resultados de verificación; los nuevos van marcados. «Todos los eventos y filtros» abre el historial completo con filtros por proyecto y nivel.",
        },
        tip: "El dinero del resumen mide el uso a precios de la API: con una suscripción esos dólares no se cobran.",
      },
      settings: {
        title: "Ajustes de orc",
        where: "Barra lateral → «Ajustes»",
        intro: "Comunes a todos los proyectos. Lo específico de un proyecto vive en sus propios ajustes.",
        steps: {
          s1: "Apariencia e idioma: tema — del sistema, claro u oscuro — y uno de seis idiomas de interfaz.",
          s2: "«Agentes a la vez»: el límite global entre proyectos; «Ciclo del despachador, segundos»: con qué frecuencia orc busca trabajo; «Verificaciones a la vez»: comandos de verificación en paralelo.",
          s3: "«Modelos en los desplegables»: oculta los modelos que nunca usas; un proyecto puede tener su propia lista.",
          s4: "«Plantilla de la tarea» e «Instrucción para resolver conflictos»: el texto que reciben los agentes; orc rellena los marcadores.",
          s5: "«Patrones de cuota agotada»: una lista JSON de expresiones regulares; una coincidencia pone la tarea en espera en vez de hacerla fallar.",
          s6: "Mantenimiento: cuántos días conservar los eventos, el tamaño total de los adjuntos y la limpieza automática de los worktrees de tareas fusionadas.",
        },
        tip: "Los ajustes se validan al guardar: no se acepta una expresión regular o una plantilla rotas.",
      },
      hotkeys: {
        title: "Atajos de teclado",
        where: "En cualquier parte del tablero",
        intro: "Funcionan cuando el foco no está en un campo de texto y no hay ninguna ventana abierta.",
        keys: {
          n: "Nueva tarea",
          slash: "Buscar tareas",
          e: "Historial de eventos",
          d: "Tablero / Resumen",
          bracket: "Contraer la barra lateral",
          question: "Esta guía",
          esc: "Cerrar una ventana",
        },
      },
    },
  },
  demos: {
    board: {
      title: "El recorrido de una tarea por el tablero",
      card: "Añadir un tema oscuro",
      captions: {
        c1: "La tarjeta espera en pendientes: una nota para más tarde.",
        c2: "La arrastras a «Por hacer». Ese es todo el arranque.",
        c3: "El despachador la toma: worktree, rama, `claude --bg`.",
        c4: "El agente ha terminado: `verify_cmd` comprueba el resultado.",
        c5: "Verificación en verde: fusión `--no-ff` en la rama base.",
        c6: "Hecho. La tarjeta muestra lo que costó la tarea en tokens.",
      },
    },
    pipeline: {
      title: "Un ciclo del despachador",
      queue: "Por hacer",
      captions: {
        c1: "Hay un hueco libre: la tarea se toma de la cola.",
        c2: "Se crean para ella un worktree y una rama propios.",
        c3: "`claude --bg` arranca con tu encargo.",
        c4: "La sesión termina y escribe su informe.",
        c5: "`verify_cmd` se ejecuta en el worktree de la tarea.",
        c6: "Fusión en la rama base, una tarea cada vez.",
      },
    },
    input: {
      title: "El agente pregunta, tú respondes",
      card: "Migrar la base de datos",
      otherCard: "Actualizar dependencias",
      question: "¿Elimino la tabla antigua users_v1 o la conservo?",
      reply: "Consérvala por ahora y añade un TODO",
      captions: {
        c1: "El agente está trabajando.",
        c2: "Tiene una pregunta: la tarjeta se vuelve magenta y sube.",
        c3: "Abres la tarjeta y ves la pregunta.",
        c4: "Respondes en «Respuesta para Claude».",
        c5: "La respuesta llega a la misma sesión, y el trabajo sigue.",
      },
    },
    conflict: {
      title: "Un conflicto vuelve a su autor",
      taskA: "Rediseño de la cabecera",
      taskB: "Tablero compacto",
      captions: {
        c1: "Dos tareas terminaron en paralelo; ambas apuntan a `dev`.",
        c2: "#41 se fusiona primero.",
        c3: "#42 encuentra los cambios de #41 en los mismos archivos: un conflicto.",
        c4: "orc devuelve el conflicto a la sesión de #42: `dev` se fusiona en su rama.",
        c5: "La sesión lo resuelve por su sentido y vuelve a pasar la verificación.",
        c6: "#42 se fusiona. No tuviste que hacer nada.",
      },
    },
    project: {
      title: "Añadir un proyecto",
      projectName: "my-app",
      captions: {
        c1: "Haz clic en «+» junto a «Proyectos».",
        c2: "Introduce un nombre y la ruta del repositorio.",
        c3: "El comando de verificación es la barrera antes de fusionar.",
        c4: "Cuántos agentes pueden trabajar a la vez.",
        c5: "Guarda: el proyecto aparece en la barra lateral.",
      },
    },
  },
};
