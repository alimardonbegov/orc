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
  <a href="README.de.md">Deutsch</a> ·
  <b>Português</b> ·
  <a href="README.ru.md">Русский</a>
</p>

# orc

**Uma fila de tarefas para o Claude Code.** O orc executa cada tarefa no seu próprio worktree do git com `claude --bg`, verifica o resultado com o seu próprio comando e mescla as branches concluídas na sua branch, uma de cada vez.

> Esta é uma versão resumida. A documentação completa está em inglês.

## Por que o orc

- **Uma tarefa, um worktree.** Cada tarefa começa no seu próprio worktree via `claude --bg`: as sessões nunca compartilham contexto nem cópia de trabalho.
- **Merge FIFO, estritamente um por vez.** As branches concluídas são mescladas com `--no-ff` na ordem em que ficaram prontas. Se a branch estiver ocupada, a tarefa espera na fila em vez de falhar.
- **Conflitos pequenos, resolvidos pelo autor.** Se houver conflito, o orc o devolve à mesma sessão que escreveu o código, porque ela sabe por que o código é como é.
- **Sua própria assinatura.** As sessões rodam pela sua CLI do Claude Code, na sua máquina, e contam na assinatura que você já tem.

## Recursos

- **Quadro kanban** com Backlog, To do, In progress e Done. Tudo o que precisa de você (uma pergunta, uma falha, um conflito) fica na faixa «Waiting for me». Ações em lote e visões salvas.
- **Despachante automático.** A cada 30 segundos pega tarefas de «To do», respeitando limites de workers e dependências.
- **Portão de verificação.** Seu `verify_cmd` (testes, linter, build) roda no worktree da tarefa. Nada é mesclado com a verificação vermelha.
- **Agentes.** Modelo, esforço, modo de permissões e prompt sob um nome e um avatar. Um agente não pertence a um projeto, tem página própria com atividade ao vivo e pode ter memória própria.
- **Chats com agentes**, em qualquer projeto ou em nenhum, num worktree privado de onde nada é mesclado. O líder do projeto vê o quadro e propõe tarefas, que só chegam ao backlog com a sua aprovação.
- **Agentes que planejam o trabalho.** Uma sessão, um chat ou um líder pode dividir uma funcionalidade grande em cartões ligados com `orc task add`, `batch` e `link`, ordená-los com dependências e etapas, dormir com `orc task wakeup` e acordar quando as subtarefas terminarem. O despachante executa a cadeia sozinho.
- **Rotinas.** Uma instrução mais um horário (a cada N minutos, horas ou dias, ou cron). Não precisam de projeto: sem ele, cada execução é um chat com o agente.
- **Perguntas e respostas ao vivo.** Permissões, perguntas e aprovações de plano aparecem no cartão, e a sua resposta chega à mesma sessão em andamento.
- **Tokens, cota e resumo.** Tokens por cartão, limites de 5 horas e semanais da sua conta e uma visão de resumo com taxa de sucesso, tempos e custo.
- **Seis idiomas de interface** (inglês, espanhol, francês, alemão, português e russo) e temas claro e escuro.

## Como funciona

1. Adicione um projeto: o caminho de um repositório git, um `verify_cmd` e um limite de workers.
2. Crie um agente e um cartão, atribua-o ao agente e mova-o para «To do».
3. O despachante cria um worktree numa nova branch `orc/task-N` e inicia `claude --bg` com a tarefa.
4. O agente termina com `orc task done`; o orc roda o `verify_cmd`. Uma falha volta para a mesma sessão.
5. As tarefas verificadas são mescladas em FIFO com `git merge --no-ff`. Os conflitos voltam para a sessão que escreveu o código e, depois, para você.

## Início rápido

Você precisa de macOS ou Linux, Python 3.12+, [uv](https://docs.astral.sh/uv/), Node.js 20.19+ ou 22.12+, git 2.38+ e a CLI do [Claude Code](https://github.com/anthropics/claude-code) com login feito.

```bash
git clone https://github.com/alimardonbegov/orc.git
cd orc
make setup          # uv sync, npm ci, web UI build
uv run orc doctor   # environment check
make start          # run the server in the background
make stop           # stop it
```

Abra <http://127.0.0.1:8765>, adicione um projeto, crie um cartão e arraste-o para «To do».

**Segurança.** O orc executa código como você, sem supervisão: esse é o trabalho dele. Ele escuta apenas em loopback; nunca exponha a porta. Leia a seção [Security](../../README.md#security) antes de usar.

## Documentação (em inglês)

- [Agents creating tasks](../agent-tasks.md)
- [How orc works](../how-it-works.md)
- [Agents, leads, chats and memory](../internals/agents.md)
- [Installing from a wheel](../install.md)

## Licença

[MIT](../../LICENSE)
