import type { cardEn } from "./en";

export const cardPt: typeof cardEn = {
  "search": "Pesquisar",
  "searchIn": "Pesquisar: {label}",
  "nothingFound": "Nada encontrado",
  "agent": {
    "label": "Responsável",
    "none": "Sem responsável",
    "noneHint": "Uma pessoa cuida disso: o cartão não vai para o trabalho",
    "noAgents": "Ainda não há agentes. Só vai para o trabalho um cartão com agente.",
    "create": "Criar um agente"
  },
  "priority": {
    "label": "Prioridade"
  },
  "branch": {
    "label": "Branch"
  },
  "dependsOn": {
    "label": "Aguarda",
    "none": "Nada"
  },
  "labels": {
    "label": "Etiquetas",
    "none": "Sem etiquetas",
    "searchLabel": "Procurar ou criar uma etiqueta",
    "searchPlaceholder": "Procurar ou digitar uma nova",
    "empty": "Ainda não há etiquetas. Digite um nome para criar uma.",
    "create": "Criar «{name}»"
  },
  "startDate": {
    "label": "Data de início"
  },
  "dueDate": {
    "label": "Prazo",
    "overdue": "Atrasado"
  },
  "date": {
    "clear": "Remover a data"
  },
  "status": {
    "label": "Estado",
    "lockedHint": "Um cartão em andamento é movido pela sessão, não à mão"
  },
  "addProperty": "Adicionar propriedade",
  "details": {
    "createdBy": "Criado por",
    "byCard": "Agente do cartão #{id}",
    "byRoutine": "Rotina, execução {run}",
    "byOwner": "Proprietário",
    "updated": "Atualizado",
    "finished": "Concluído"
  },
  "relations": {
    "heading": "Relações",
    "viewLabel": "Mostrar relações como",
    "list": "Lista",
    "tree": "Árvore",
    "chain": "A cadeia inteira",
    "comesNext": "Vem a seguir",
    "subtasks": "Subtarefas",
    "noSubtasks": "Sem subtarefas",
    "wake": "Reativar o cartão quando todas as subtarefas estiverem prontas",
    "wakeHint": "O cartão volta uma vez à fila para conferir o resultado. Uma subtarefa com falha o segura. Desligado por padrão.",
    "addSubtask": "Nova subtarefa",
    "attach": "Anexar um cartão existente como subtarefa",
    "attachEmpty": "Nenhum cartão para anexar",
    "detach": "Tirar #{id} das subtarefas",
    "editWaits": "Mudar o que ele espera",
    "gone": "arquivado ou excluído",
    "failedHint": "#{id} falhou: segura este cartão até ser corrigido",
    "thisCard": "este cartão",
    "repeat": "mostrado acima",
    "repeatHint": "Já está mais acima na árvore: espera por mais de um cartão",
    "cycle": "anel",
    "cycleHint": "A cadeia volta a este cartão: nada num anel pode começar",
    "expand": "Expandir",
    "collapse": "Recolher",
    "progressTitle": "{done} de {total} subtarefas concluídas",
    "subtaskOf": "Subtarefa de",
    "formParent": "Subtarefa de #{id}",
    "formParentRemove": "Não é subtarefa",
    "stage": "Etapa {n}",
    "noStage": "Sem etapa",
    "setStage": "Etapa de #{id}",
    "viaStage": "etapa",
    "viaStageHint": "Aguarda a etapa anterior do pai: começa quando todos os cartões dessa etapa estão concluídos"
  },
  "form": {
    "createAndStart": "Criar e iniciar",
    "startNeeds": "Para iniciar agora, o cartão precisa de responsável e descrição"
  },
  "modal": {
    "saving": "Salvando…",
    "saved": "Salvo",
    "saveFailed": "Não foi possível salvar o cartão: {error}",
    "editDescription": "Editar a descrição",
    "emptyDescription": "Adicione uma descrição: é o que o agente recebe",
    "details": "Detalhes",
    "toThreadEnd": "Ir para o fim da conversa",
    "runsWith": "Executa com: {params}",
    "runsWithHint": "Definido no agente e no projeto, não no cartão",
  },
  "presence": {
    "person": "Uma pessoa cuida disso",
    "assigned": "atribuído",
    "queued": "na fila",
    "noAgentName": "Claude"
  },
  "log": {
    "heading": "Registro de execução",
    "active": "{count} em andamento",
    "showAll": "Mostrar tudo",
    "showAllMore": "Mostrar tudo (mais {count})",
    "dialogTitle": "Registro de execução de #{id}",
    "spent": "Gasto",
    "tokens": "Tokens",
    "agentTime": "Tempo do agente",
    "tokensCount": "{tokens} tokens",
    "running": "em andamento",
    "openThread": "Abrir na conversa",
    "stop": "Parar",
    "retry": "Executar de novo na mesma sessão",
    "stopTitle": "Parar o agente?",
    "stopBody": "O agente para agora e o cartão espera por você como falho. O trabalho fica: você pode retomá-lo ou tentar de novo.",
    "checkPassed": "Verificação aprovada",
    "checkFailed": "Verificação falhou",
    "noOutput": "A verificação não imprimiu nada.",
    "exitCode": "Verificação terminou com o código {code}",
    "noOutputCode": "A verificação não imprimiu nada e terminou com o código {code}.",
    "timedOut": "Verificação excedeu o tempo",
    "noOutputTimedOut": "A verificação foi interrompida pelo tempo limite.",
    "trigger": {
      "none": "Execução",
      "start": "Início",
      "rework": "Retrabalho",
      "resume": "Retomado por você",
      "crash": "Retomado após uma falha",
      "quota": "Retomado após o limite",
      "verify_failed": "Devolvido após a verificação",
      "conflict": "Resolve um conflito de merge",
      "message": "Sua mensagem",
      "subtasks_done": "Reativada: subtarefas prontas",
      "wakeup": "Despertada"
    },
    "outcome": {
      "handed_in": "Entregue",
      "failed": "Falhou",
      "stopped": "Parado",
      "quota": "Atingiu o limite de uso",
      "superseded": "Substituído pela próxima execução",
      "sleeping": "Dormindo até despertar"
    },
    "merge": {
      "merged": "Mesclado em {target}",
      "failed": "O merge falhou",
      "conflict": "Conflito com {target}"
    }
  },
  "wakeups": {
    "heading": "Despertares",
    "at": "Às {time}",
    "task": "Quando #{id} estiver pronta",
    "deadline": "no máximo até {time}",
    "cancel": "Cancelar o despertar",
    "history": "Histórico ({count})",
    "fired": "Disparado",
    "cancelled": "Cancelado",
    "nothingLeft": "Nada vai despertar este cartão: escreva ao agente, aceite o trabalho ou feche o cartão.",
    "note": "Nota"
  },
  "failure": {
    "details": "Detalhes técnicos",
    "hideDetails": "Ocultar detalhes",
    "session_lost": {
      "reason": "A sessão foi perdida.",
      "hint": "O orc não alcança mais a sessão do agente. Pressione «{continue}» para retomar de onde parou, ou «{retry}» para começar do zero."
    },
    "quota_limit": {
      "reason": "O limite de uso foi atingido.",
      "hint": "Primeiro o limite precisa ser reiniciado. Aguarde e pressione «{continue}»."
    },
    "project_unavailable": {
      "reason": "A pasta do projeto não está disponível.",
      "hint": "Corrija o caminho nas configurações do projeto (ou restaure a pasta) e pressione «{retry}»."
    },
    "branch_gone": {
      "reason": "A branch ou a cópia de trabalho da tarefa sumiu.",
      "hint": "Não resta nada de onde continuar. Pressione «{retry}» para recomeçar a tarefa do zero."
    },
    "check_failed_again": {
      "reason": "A verificação falhou duas vezes.",
      "hint": "Leia a saída da verificação no registro de execução. Escreva no campo o que corrigir e pressione «{continue}», ou «{accept}» se o trabalho estiver bom."
    },
    "conflict_unresolved": {
      "reason": "A branch conflita com o destino e não foi possível conciliá-las.",
      "hint": "Concilie as branches à mão no repositório e pressione «{resolved}»."
    },
    "stopped_by_owner": {
      "reason": "Você parou o agente.",
      "hint": "O trabalho dele foi mantido. Pressione «{continue}» para ele seguir, ou «{retry}» para recomeçar."
    },
    "agent_reported": {
      "reason": "O agente diz que não conseguiu terminar.",
      "hint": "A explicação dele está nos detalhes técnicos. Responda no campo e pressione «{continue}», ou «{retry}» para recomeçar."
    }
  },
  "deliverables": {
    "heading": "Arquivos",
    "open": "Abrir {name}",
    "download": "Baixar",
    "versions": "Versões de {name}",
    "version": "Versão {n}",
    "loading": "Carregando…",
    "tooBig": "Grande demais para a pré-visualização: baixe o arquivo.",
    "failed": "Não foi possível carregar o arquivo.",
    "noPreview": "Este tipo não é exibido aqui: baixe o arquivo.",
    "note": "Entregue pelo agente. É mostrado como conteúdo e nunca executado."
  },
  "notReady": {
    "title": "O cartão não está pronto",
    "body": "O cartão #{id} \"{title}\" ainda não pode ir para o trabalho.",
    "assignee": "Ninguém foi atribuído, então uma pessoa cuida dele. Atribua um agente.",
    "fix": "Corrigir"
  },
  "quickActions": {
    "heading": "Ações rápidas",
    "hint": "Mensagens prontas para o agente. Aparecem no cartão e com / no campo de resposta.",
    "defaults": {
      "review": "Revisar",
      "tests": "Escrever testes",
      "summary": "Resumir",
      "simplify": "Simplificar"
    },
    "title": "Título",
    "prompt": "Texto para o agente",
    "add": "Adicionar uma ação",
    "remove": "Remover {title}",
    "up": "Subir {title}",
    "down": "Descer {title}",
    "reset": "Restaurar o conjunto padrão",
    "unavailable": "Neste estado o agente não recebe mensagens.",
    "menu": "Ações rápidas",
    "none": "Nenhuma ação correspondente",
    "empty": "Sem ações rápidas.",
    "sent": "Enviado: {title}"
  },
  "settings": {
    "heading": "Cartões de tarefas",
    "headingHint": "O que um cartão mostra e com o que um novo começa.",
    "defaultAgent": "Responsável padrão",
    "defaultAgentHint": "Novos cartões são atribuídos a este agente.",
    "defaultPriority": "Prioridade padrão",
    "properties": "Propriedades do cartão",
    "propertiesHint": "Uma propriedade oculta continua visível se o cartão tiver um valor nela.",
    "staleAgent": "O agente #{id} não está mais disponível",
    "ownLabel": "Configurações próprias para este projeto",
    "ownHint": "Desligado: o projeto segue as configurações do orc."
  }
};
