<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../web/public/brand/orc-mark-dark.svg">
    <img src="../../web/public/brand/orc-mark-light.svg" alt="orc logo" width="96" height="96">
  </picture>
</p>

<p align="center">
  <a href="../../README.md">English</a> ·
  <b>Español</b> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ru.md">Русский</a>
</p>

# orc

**Una cola de tareas para Claude Code.** orc ejecuta cada tarea en su propio worktree de git con `claude --bg`, comprueba el resultado con tu propio comando y fusiona las ramas terminadas en tu rama, una a una.

> Esta es una versión abreviada. La documentación completa está en inglés.

## Por qué orc

- **Una tarea, un worktree.** Cada tarea arranca en su propio worktree mediante `claude --bg`: las sesiones nunca comparten contexto ni copia de trabajo.
- **Fusión FIFO, estrictamente una a la vez.** Las ramas terminadas se fusionan con `--no-ff` en el orden en que quedaron listas. Si la rama está ocupada, la tarea espera en la cola en lugar de fallar.
- **Conflictos pequeños, resueltos por su autor.** Si hay un conflicto, orc lo devuelve a la misma sesión que escribió el código, porque es la que sabe por qué el código es como es.
- **Tu propia suscripción.** Las sesiones se ejecutan con tu CLI de Claude Code, en tu máquina, y cuentan para la suscripción que ya tienes.

## Qué incluye

- **Tablero kanban** con Backlog, To do, In progress y Done. Todo lo que te necesita (una pregunta, un fallo, un conflicto) se reúne en la franja «Waiting for me». Acciones por lotes y vistas guardadas.
- **Despachador automático.** Cada 30 segundos toma tareas de «To do», respetando los límites de trabajadores y las dependencias.
- **Puerta de verificación.** Tu `verify_cmd` (tests, linter, build) se ejecuta en el worktree de la tarea. Nada se fusiona con una comprobación en rojo.
- **Agentes.** Un modelo, un esfuerzo, un modo de permisos y un prompt bajo un nombre y un avatar. Un agente no pertenece a un proyecto, tiene su propia página con actividad en vivo y puede tener memoria propia.
- **Chats con agentes**, en cualquier proyecto o en ninguno, en un worktree privado donde nada se fusiona. El líder de un proyecto ve el tablero y propone tareas, que llegan al backlog solo con tu aprobación.
- **Agentes que planifican el trabajo.** Una sesión, un chat o un líder puede dividir una funcionalidad grande en tarjetas enlazadas con `orc task add`, `batch` y `link`, ordenarlas con dependencias y etapas, dormir con `orc task wakeup` y despertar cuando terminen sus subtareas. El despachador ejecuta la cadena solo.
- **Rutinas.** Una instrucción más un horario (cada N minutos, horas o días, o cron). No necesitan proyecto: sin él, cada ejecución es un chat con el agente.
- **Preguntas y respuestas en vivo.** Permisos, preguntas y aprobaciones de plan aparecen en la tarjeta y tu respuesta llega a la misma sesión en marcha.
- **Tokens, cuota y resumen.** Tokens por tarjeta, límites de 5 horas y semanales de tu cuenta, y una vista de resumen con éxito, tiempos y coste.
- **Seis idiomas de interfaz** (inglés, español, francés, alemán, portugués y ruso) y temas claro y oscuro.

## Cómo funciona

1. Añade un proyecto: la ruta de un repositorio git, un `verify_cmd` y un límite de trabajadores.
2. Crea un agente y una tarjeta, asígnala al agente y muévela a «To do».
3. El despachador crea un worktree en una rama nueva `orc/task-N` y lanza `claude --bg` con el encargo.
4. El agente termina con `orc task done`; orc ejecuta `verify_cmd`. Un fallo vuelve a la misma sesión.
5. Las tareas verificadas se fusionan por FIFO con `git merge --no-ff`. Los conflictos vuelven a la sesión que escribió el código, y después a ti.

## Inicio rápido

Necesitas macOS o Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 20.19+ o 22.12+, git 2.38+ y la CLI de [Claude Code](https://github.com/anthropics/claude-code) con sesión iniciada.

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup          # uv sync, npm ci, web UI build
uv run orc doctor   # environment check
make start          # run the server in the background
make stop           # stop it
```

Abre <http://127.0.0.1:8765>, añade un proyecto, crea una tarjeta y arrástrala a «To do».

**Seguridad.** orc ejecuta código como tú, sin supervisión: ese es su trabajo. Escucha solo en loopback; nunca expongas el puerto. Lee la sección [Security](../../README.md#security) antes de usarlo.

## Documentación (en inglés)

- [Agents creating tasks](../agent-tasks.md)
- [How orc works](../how-it-works.md)
- [Agents, leads, chats and memory](../internals/agents.md)
- [Installing from a wheel](../install.md)

## Licencia

[MIT](../../LICENSE)
