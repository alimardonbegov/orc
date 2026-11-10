import type { PagesDictionary } from "./en";

/** Portuguese texts for the About / How it works pages (see pages/en.ts). */
export const pagesPt: PagesDictionary = {
  nav: {
    about: "Sobre o orc",
    guide: "Como funciona",
    helpNav: "Sobre e ajuda",
    backToBoard: "Voltar ao quadro",
  },
  demo: {
    play: "Reproduzir",
    pause: "Pausar",
    replay: "Repetir",
    goToStep: "Passo {step}",
    stepOf: "{step} / {total}",
    regionLabel: "Demonstração animada: {title}",
  },
  about: {
    eyebrow: "Orquestrador de tarefas para Claude Code",
    title: "Um quadro kanban que faz as próprias tarefas",
    lead: "Coloque um cartão em «A fazer» e pare de clicar. A cada 30 segundos o despachante pega tarefas da fila, dá a cada uma seu próprio git worktree, executa `claude --bg` nele, confere o resultado com o seu comando de verificação e, se der verde, faz o merge do branch sozinho — `--no-ff`, um de cada vez, sem pull request. Encha a fila à noite, leia o diff de manhã.",
    ctaGuide: "Como funciona",
    ctaAddProject: "Adicionar projeto",
    flowHeading: "Três passos, e depois ele anda sozinho",
    flow: {
      queue: {
        title: "Você enfileira",
        body: "Um cartão com um encargo claro para o agente vai para «A fazer». Prioridade, modelo, branch base e dependências são definidos no próprio cartão.",
      },
      work: {
        title: "O agente trabalha",
        body: "Cada tarefa ganha seu próprio worktree e o branch `orc/task-<id>`. Vários agentes trabalham em paralelo sem atrapalhar uns aos outros.",
      },
      ship: {
        title: "O orc verifica e mescla",
        body: "Quem decide é o seu `verify_cmd`, não a palavra do agente. Verde — merge no branch base; vermelho — a tarefa volta com uma explicação.",
      },
    },
    featuresHeading: "O que o orc faz e os outros não",
    featuresLead: "Separadamente, quase todo recurso existe em algum lugar. O pacote completo — quadro, despachante automático, verificação rígida antes do merge, merge automático sem PR, conflitos devolvidos ao autor e controle de cota — ninguém mais junta.",
    features: {
      dispatcher: {
        title: "Despachante por demanda",
        body: "Sem botão «iniciar»: o despachante pega as tarefas sozinho e respeita os limites de agentes por projeto e o geral.",
      },
      verify: {
        title: "Verificação antes do merge",
        body: "O seu comando — testes, linter, build — roda no worktree da tarefa. Nada passa para o merge com a verificação vermelha.",
      },
      merge: {
        title: "Merge automático sem PR",
        body: "`--no-ff` no branch base da tarefa, estritamente um de cada vez. Se você está editando esse branch à mão, o orc primeiro salva suas edições num commit wip separado.",
      },
      conflict: {
        title: "Conflitos voltam para o autor",
        body: "Um conflito de merge semântico vai para a sessão que escreveu o código — ela sabe por que foi feito assim. Três tentativas, depois um humano.",
      },
      quota: {
        title: "Cota é um recurso",
        body: "Os limites da assinatura do Claude estão sempre na tela, e quando acabam as tarefas esperam o reinício em vez de falhar.",
      },
      live: {
        title: "Respostas chegam à sessão ativa",
        body: "O agente perguntou algo — o cartão sobe com um selo, e a sua resposta chega à mesma sessão em segundos, sem reinício.",
      },
      cost: {
        title: "O custo de cada tarefa",
        body: "Tokens de todas as sessões e subagentes de uma tarefa, direto das transcrições do Claude Code, detalhados por modelo.",
      },
      summary: {
        title: "Um resumo de longo prazo",
        body: "Vazão, taxa de sucesso, tempo por tarefa, atritos e as tarefas mais caras — ao lado do quadro, a uma tecla de distância.",
      },
    },
    forHeading: "Para quem é",
    forItems: {
      solo: "Um desenvolvedor sem revisor: onde equipes abrem pull requests umas para as outras, aqui quem decide é o `verify_cmd`.",
      subscription: "Roda pelo CLI do Claude Code na sua máquina — na assinatura que você já paga, sem um pacote de créditos à parte.",
      local: "Tudo fica local: o servidor escuta apenas em 127.0.0.1, e os dados ficam num SQLite ao lado.",
    },
    notHeading: "O que o orc deliberadamente não é",
    notLead: "Isso pertence a equipes que constroem essas coisas há anos. O orc não compete aí — ele pega o que ninguém mais pegou.",
    notItems: {
      multiAgent: {
        title: "Não é multiagente",
        body: "Só Claude Code. Nada de Codex, Cursor ou OpenCode.",
      },
      diff: {
        title: "Sem revisão de diff na interface",
        body: "O resultado é um commit mesclado — leia o diff no seu editor ou no git.",
      },
      cloud: {
        title: "Sem nuvem nem modo de equipe",
        body: "Uma máquina, uma pessoa, localhost.",
      },
    },
    limitsHeading: "Limitações atuais",
    limitsLead: "Vale saber antes de entregar ao orc um repositório de verdade.",
    limits: {
      local: {
        title: "Só Claude Code, só nesta máquina",
        body: "A API responde apenas no loopback; outros dispositivos não a alcançam. A inicialização automática no login existe só para macOS (LaunchAgent) — no Linux, inicie o servidor você mesmo ou use Docker.",
      },
      planMode: {
        title: "Sem o modo de permissão «plan»",
        body: "Uma sessão esperando a aprovação do plano parece «trabalhando» para o despachante e ficaria travada em silêncio, por isso o modo ainda não é oferecido.",
      },
      quotaRegex: {
        title: "A detecção de cota é uma hipótese",
        body: "Os padrões que reconhecem um limite esgotado são um palpite e podem ser ajustados nas configurações. Depois de 5 novas tentativas por cota seguidas, a tarefa falha com uma explicação.",
      },
      delivery: {
        title: "Mensagens chegam na próxima chamada de ferramenta",
        body: "Uma nota para uma sessão em andamento passa por um hook — geralmente em segundos, mas uma sessão que pensa por muito tempo a recebe mais tarde. Aí você pode interrompê-la.",
      },
      rework: {
        title: "«Retomar» precisa de um worktree vivo",
        body: "«Retomar» continua a mesma sessão na mesma cópia de trabalho. Depois que o worktree é removido, só resta uma tarefa nova.",
      },
      images: {
        title: "Imagens viajam como caminhos de arquivo",
        body: "`claude --bg` aceita um único argumento de texto, então o agente recebe o caminho da imagem e a abre com Read. png, jpeg, gif e webp de até 10 MB.",
      },
      autocommit: {
        title: "Suas edições sem commit vão para um commit",
        body: "Antes de mesclar num branch em que você está trabalhando, o orc faz commit das alterações rastreadas como `wip(orc): auto-commit before merge #id`. O push fica desligado até você ligá-lo.",
      },
      stop: {
        title: "Ainda não há um «Parar» suave",
        body: "Uma tarefa em andamento só pode ser fechada manualmente ou excluída. Pausá-la e devolvê-la aos pendentes mantendo o trabalho ainda é um plano.",
      },
    },
    risksHeading: "Riscos aceitos",
    risksLead: "Não é trabalho inacabado, e sim decisões deliberadas — eliminá-los significaria abrir mão daquilo para que o orc existe.",
    risks: {
      noHuman: {
        title: "Nenhum humano entre o agente e o origin",
        body: "O merge, e o push se estiver ligado, seguem a palavra do próprio agente de que o trabalho está feito. O `verify_cmd` é a única voz independente.",
      },
      verifyEdited: {
        title: "O verify_cmd executa código que o agente acabou de editar",
        body: "Se a verificação chama `make test` ou `npm test`, o agente pode ter alterado esse script na mesma tarefa. Rodar o orc no repositório de outra pessoa é como rodar o Makefile dela.",
      },
      localRead: {
        title: "Qualquer processo local pode ler a API",
        body: "Alterações exigem o token do console, leituras não: a lista de tarefas, as descrições e os caminhos dos repositórios ficam visíveis para qualquer programa rodando com o seu usuário.",
      },
    },
    roadmapHeading: "O que vem a seguir",
    roadmapLead: "Ideias com pesquisa ou plano por trás. Sem datas — a ordem depende do que mais incomoda no uso diário.",
    roadmapStatus: {
      plan: "plano escrito",
      research: "pesquisado",
      idea: "ideia",
    },
    roadmap: {
      stop: {
        title: "Botão «Parar»",
        body: "Parar uma tarefa em andamento e devolvê-la aos pendentes mantendo o trabalho — depois continuar do mesmo ponto ou recomeçar.",
      },
      planMode: {
        title: "Modo plan",
        body: "Ler o sinal «aprovar plano» da sessão e mostrá-lo como um cartão comum «aguardando resposta».",
      },
      ide: {
        title: "Abrir no editor",
        body: "Links do cartão para o worktree dele no VS Code e para a sessão ativa do Claude; mais tarde, um modo «humano no volante».",
      },
      windows: {
        title: "Janelas de horário",
        body: "Deixar o despachante trabalhar só em horários definidos — por exemplo, de madrugada, enquanto a cota está ociosa.",
      },
      review: {
        title: "Revisão antes do merge",
        body: "Uma opção: depois da verificação verde, a tarefa espera o seu OK em vez de mesclar na hora.",
      },
      sessionLog: {
        title: "Log da sessão no cartão",
        body: "Ver o que o agente está fazendo agora sem abrir um terminal.",
      },
    },
    footer: "orc se pronuncia «ork». A história completa está no README.md e em docs/ no repositório.",
    brandBook: "Manual de marca",
  },
  guide: {
    title: "Como funciona",
    lead: "Passo a passo, de um quadro vazio até uma tarefa mesclada. Cada seção diz onde as coisas ficam na interface e o que configurar ali.",
    tocLabel: "Conteúdo",
    where: "Onde",
    tip: "Dica",
    sections: {
      start: {
        title: "Antes de começar",
        where: "Terminal, na pasta do orc",
        intro: "O orc roda na sua máquina e comanda o CLI do Claude Code. Veja do que ele precisa:",
        steps: {
          s1: "macOS ou Linux, Python 3.12+, Node.js com npm e `uv`.",
          s2: "CLI do Claude Code no PATH, logado na sua assinatura: `claude --bg` precisa funcionar num terminal.",
          s3: "Um repositório git para cada projeto — cada tarefa trabalha no seu próprio `git worktree`.",
          s4: "Configuração única: `make setup`, depois `make start` — o console abre em http://127.0.0.1:8765.",
          s5: "Opcional: `make install-agent` inicia o servidor a cada login no macOS, e `make docker-up` o executa no Docker.",
        },
        tip: "`make status` diz se o servidor está vivo, e `make logs` mostra o log dele.",
      },
      project: {
        title: "Adicione um projeto",
        where: "Barra lateral → «+» ao lado de «Projetos»",
        intro: "Um projeto é um repositório git mais as regras para trabalhar nele. Tudo aqui pode ser alterado depois nas configurações do projeto — a engrenagem no cabeçalho do quadro.",
        steps: {
          s1: "Nome e caminho do repositório. Pasta sem git? O orc oferece executar `git init` com um primeiro commit vazio no main.",
          s2: "«Agentes ao mesmo tempo» — quantas tarefas deste projeto rodam em paralelo. As configurações do orc também têm um limite geral.",
          s3: "«Agentes»: quem lidera o projeto e quantos rodam ao mesmo tempo. Modelo, esforço e modo de permissões são definidos em cada agente; os valores do projeto («Ajustes de reserva», nas configurações do projeto) valem só para um agente que não os define.",
          s4: "«Branch base» — de onde partem os branches das tarefas e para onde os resultados voltam. Vazio significa o branch aberto no repositório no momento.",
          s5: "«Verificação antes do merge» — o comando verify (por exemplo, `make test`) e seu tempo limite. Esta é a principal barreira de segurança: sem ela, o merge confia apenas na palavra do agente.",
          s6: "«Depois do merge» — push para o origin. Desligado por padrão: o orc nunca faz push sozinho até você ativar.",
          s7: "«Memória do projeto» — edite o CLAUDE.md aqui mesmo: instruções permanentes que todo agente deste projeto lê.",
          s8: "Clique em «Salvar». As configurações só são salvas pelo botão, e a janela não fecha com um clique fora enquanto houver alterações não salvas.",
        },
        tip: "Moveu a pasta do repositório? Altere o caminho nas configurações do projeto — o orc reconecta as cópias de trabalho das tarefas com `git worktree repair`.",
      },
      task: {
        title: "Crie uma tarefa",
        where: "Botão «Tarefa» no cabeçalho do quadro, ou a tecla N",
        intro: "O título do cartão é para você; o agente recebe o campo «Tarefa para o agente». Escreva como se estivesse passando o trabalho a um colega que não conhece o contexto.",
        steps: {
          s1: "Título — um nome curto para o quadro.",
          s2: "«Tarefa para o agente» — o que fazer, onde está e como verificar. Cole capturas de tela exatamente onde fazem sentido: Ctrl+V, arrastando ou pelo botão «Imagem». «Texto / Pré-visualização» mostra o que o agente vai ver.",
          s3: "«Responsável» — o agente que faz o trabalho. O modelo, o esforço e o modo de permissões vêm do agente; um cartão sem responsável fica com você e não vai para o trabalho.",
          s4: "Modos de permissão: `auto` — o Claude decide sozinho; `acceptEdits` — edita arquivos sem perguntar; `dontAsk` — nunca pergunta, e o que não está pré-aprovado simplesmente não é executado; `bypassPermissions` — nenhuma verificação, apenas para seus próprios repositórios.",
          s5: "Prioridade, branch base e «Aguarda»: um cartão espera até que os cartões dos quais depende sejam mesclados, mesmo em outros projetos. «Adicionar propriedade» adiciona etiquetas e datas de plano, que a fila nunca lê.",
          s6: "Deixe o cartão em «Pendentes» como anotação, ou coloque-o em «A fazer» — o despachante o pega no próximo ciclo. Um cartão com o encargo vazio não pode ir para «A fazer».",
        },
        tip: "O branch base pode ser alterado enquanto o cartão está em «Pendentes» ou «A fazer». Depois que a tarefa começa, a cópia de trabalho já existe e é tarde demais.",
      },
      card: {
        title: "O cartão",
        where: "Clique em um cartão do quadro",
        intro: "Um cartão descreve o trabalho uma vez, e tudo entre você e o agente acontece na conversa dele. A coluna da esquerda é para ler; a da direita, para os fatos.",
        steps: {
          s1: "A descrição fica no lugar: uma pergunta do agente nunca a empurra. Clique para editar; o campo cresce com o texto.",
          s2: "«Relações»: o que o cartão aguarda, o que vem a seguir e as subtarefas com um anel feitas/total. «+» cria uma subtarefa com o projeto, a branch e o agente do pai; «Lista / Árvore» mostra toda a cadeia em volta do cartão.",
          s3: "«Conversa»: as mensagens e comandos da sessão e as etapas que o orc adiciona — entregue, verificação, merge, conflito. O campo abaixo muda com o estado: «Enviar ao agente» enquanto o agente trabalha ou espera, «Continuar» e «Tentar novamente» após uma falha, «Retomar» quando o cartão está pronto.",
          s4: "«Nota, o agente não a vê» fica no cartão e nunca chega à sessão.",
          s5: "A coluna da direita: status, responsável, prioridade, branch e as propriedades que você adicionou. O «Registro de execução» lista cada execução com o motivo, o desfecho e o custo, e cada verificação com a saída.",
          s6: "«Detalhes» embaixo: quem criou o cartão, quando começou e terminou, a branch, o worktree e o comando para entrar na sessão.",
        },
        tip: "Um cartão abre no topo, para ler a tarefa. Ele abre no fim da conversa quando espera por você, e o chip do agente no cabeçalho também leva até lá.",
      },
      dispatcher: {
        title: "O que o despachante faz",
        where: "Rodapé da barra lateral — o painel do despachante",
        intro: "Há um despachante para todos os projetos. A cada `poll_interval_sec` segundos (30 por padrão) ele faz uma passada — um ciclo:",
        steps: {
          s1: "Pega tarefas de «A fazer» enquanto houver vagas livres e cria um worktree com o branch `orc/task-<id>` a partir do branch base da tarefa.",
          s2: "Executa `claude --bg` ali com o seu encargo, modelo e modo de permissão. O cartão vai para «Em andamento».",
          s3: "Espera o agente executar `orc task done` e terminar o turno. Se ele executar `orc task fail`, a tarefa para com o motivo dele. Se não fizer nenhum dos dois, o cartão espera por você. Se executar `orc task wakeup`, o cartão dorme sem vaga de worker até o despertar.",
          s4: "Executa o `verify_cmd` no worktree — o selo «verificando». Vermelho: a tarefa volta ao agente com a saída da verificação.",
          s5: "Verde: a tarefa entra na fila de merge — o selo «mesclando»: `--no-ff` no branch base, uma tarefa de cada vez. Depois, «Concluído».",
          s6: "O painel do despachante mostra o sinal de vida e os agentes ocupados. «Pausar» para de despachar tarefas novas; «Executar agora» faz uma passada sem esperar o temporizador.",
        },
        tip: "Os olhos do orc no logo brilham enquanto o despachante está vivo e pulsam enquanto os agentes trabalham.",
      },
      input: {
        title: "Quando o agente precisa de você",
        where: "Barra «Esperam por mim» acima do quadro",
        intro: "Magenta é a única cor da interface que chama um humano. Um cartão que precisa de você sobe para o topo da coluna e ganha um selo.",
        steps: {
          s1: "O agente pediu permissão, fez uma pergunta ou propôs um plano — o cartão recebe «aguardando resposta», e o contador no cabeçalho aumenta.",
          s2: "Abra o cartão. Uma permissão, uma escolha ou um plano chega como formulário no fim da conversa, no lugar do campo de texto. Uma pergunta simples é a última mensagem do agente, marcada «À espera da sua resposta»: responda no campo de texto — capturas de tela também funcionam aqui.",
          s3: "A resposta vai para a mesma sessão em segundos, e ela continua de onde parou.",
          s4: "Você pode escrever a uma sessão em andamento sem ser perguntado: «Enviar ao agente» no campo de texto. O texto chega na próxima chamada de ferramenta sem interrompê-la; «Interromper» para antes o passo atual, como Esc.",
          s5: "Uma mensagem a caminho mostra o estado abaixo dela: «à espera do próximo passo do agente», depois «lido». Se o agente está num passo longo, «Interromper» o para, como Esc, e ele lê a sua mensagem mais cedo.",
          s6: "O agente entrega o trabalho com `orc task done`. Se parou sem isso e o trabalho parece pronto, «Aceitar o trabalho» ao lado de «Enviar ao agente» o entrega por ele: a verificação roda mesmo assim.",
        },
        tip: "Perguntas de outros projetos aparecem como um chip separado na mesma barra — o despachante é compartilhado, então nada se perde.",
      },
      problems: {
        title: "Conflitos, falhas e cota",
        where: "Selos no cartão e na janela dele",
        intro: "A maioria dos problemas se resolve sem você. Veja o que o orc faz sozinho e quando ele chama você.",
        steps: {
          s1: "Conflito de merge: a tarefa que chega em segundo lugar encontra edições alheias nos seus arquivos. O orc devolve o conflito à sessão que escreveu o código; ela o resolve pelo sentido, passa de novo pela verificação e volta à fila de merge. Depois de três tentativas — o selo «conflito».",
          s2: "Uma tarefa que falhou fica vermelha, e o motivo está na conversa dela. «Continuar» retoma a mesma sessão, com a sua mensagem se você escrever uma; «Tentar novamente» começa do zero; «Aceitar o trabalho» envia o que a sessão fez para a verificação.",
          s3: "Cota: quando o limite do Claude acaba, a tarefa espera com o selo «cota», e o despachante a retoma após o reinício.",
          s4: "«sem confiança»: o Claude Code não inicia sessões numa pasta em que você não confiou. «Confiar na pasta e iniciar» resolve isso uma vez por projeto.",
          s5: "«cópia suja»: o branch de destino tem um merge, rebase ou cherry-pick inacabado. O orc não mexe nele — termine a operação, e a tarefa continua.",
        },
        tip: "A configuração do orc «Conflitos de merge são resolvidos pela própria sessão» — desative-a se quiser que todo conflito chegue até você.",
      },
      finish: {
        title: "Conclusão e limpeza",
        where: "Janela da tarefa",
        intro: "Uma tarefa concluída pode ser continuada, e uma travada pode ser fechada à mão.",
        steps: {
          s1: "«Retomar» num cartão concluído: escreva o que corrigir — o cartão volta para «A fazer», continua a mesma sessão no mesmo worktree e é mesclado uma segunda vez.",
          s2: "«Fechar manualmente» é uma saída de emergência para um cartão travado: a sessão para, o cartão vai para «Concluído» sem verificação nem merge, e o branch fica sem merge. Arrastar o cartão para «Concluído» faz o mesmo.",
          s3: "«Arquivar» é reversível: o cartão some do quadro e da vista do despachante. O filtro «Arquivo» no cabeçalho mostra as tarefas arquivadas, e «Restaurar do arquivo» traz uma de volta.",
          s4: "«Excluir» é definitivo: a tarefa, a conversa dela e — a menos que você desmarque — o branch e o worktree dela.",
          s5: "«Concluído» tem seu próprio menu de ordenação: mais recentes primeiro, mais antigas primeiro ou falhas primeiro.",
          s6: "Uma tarefa concluída fica no topo de «Concluído» como não vista até você abrir o cartão ou marcar a caixa no canto dele. Desmarque e a tarefa volta ao topo. Os contadores de não vistos ficam no botão «Concluído» e na lista de projetos; isso se desativa nas configurações do projeto.",
        },
        tip: "O orc pode remover sozinho os worktrees de tarefas mescladas — veja «Limpar worktrees de tarefas mescladas» nas configurações do orc. Enquanto o worktree existir, «Retomar» funciona.",
      },
      branches: {
        title: "Branches e worktrees",
        where: "Cabeçalho do quadro — os botões de branch e de pasta ao lado da engrenagem do projeto",
        intro: "Branches e cópias de trabalho vivem no git, não no banco de dados do orc, então essas janelas os leem diretamente.",
        steps: {
          s1: "«Branches do projeto» mostra todos os branches e quem os ocupa: aberto no repositório, base para tarefas novas, não mesclado, tarefas trabalhando nele.",
          s2: "Crie, renomeie e exclua branches aqui. Renomear move todos os cartões que apontavam para o branch; excluir move as tarefas em espera para o branch base do projeto.",
          s3: "Operações perigosas são explicadas, não escondidas: um cadeado com o motivo quando quebrariam um trabalho em andamento, e uma confirmação listando as perdas quando a decisão é sua.",
          s4: "«Worktrees» lista todas as cópias de trabalho do projeto com a tarefa, o estado e o tamanho, e permite remover as que você não precisa mais.",
        },
        tip: "Um branch excluído fora do orc não some em silêncio: a lista o marca com «esse branch não existe mais».",
      },
      overview: {
        title: "Resumo, limites e eventos",
        where: "Alternador «Quadro / Resumo» e o rodapé da barra lateral",
        intro: "O quadro responde «preciso intervir agora?». Todo o resto responde a perguntas mais longas.",
        steps: {
          s1: "«Resumo» (a tecla D): blocos, vazão ao longo do tempo, duração das tarefas, detalhamento por modelo, esforço, modo de permissão e projeto, atritos e as tarefas mais caras. Escopo — o projeto atual ou todos; período — 7, 30 ou 90 dias ou todo o período.",
          s2: "Limites do Claude no rodapé da barra lateral: as janelas de 5 horas e semanal da sua CONTA, com a hora do reinício. O botão de atualizar pergunta ao Claude na hora — leva alguns segundos.",
          s3: "O selo de moeda num cartão é o total de tokens da tarefa em todas as sessões e subagentes. A janela da tarefa detalha por modelo e por agente.",
          s4: "Eventos (a tecla E): execuções, perguntas de agentes, resultados de verificação; os novos ficam marcados. «Todos os eventos e filtros» abre o feed completo com filtros por projeto e nível.",
        },
        tip: "O dinheiro no resumo mede o uso pelos preços da API — numa assinatura esses dólares não são cobrados.",
      },
      settings: {
        title: "Configurações do orc",
        where: "Barra lateral → «Configurações»",
        intro: "Compartilhadas entre todos os projetos. O que é específico de um projeto fica nas configurações dele.",
        steps: {
          s1: "Aparência e idioma: tema — do sistema, claro ou escuro — e um dos seis idiomas da interface.",
          s2: "«Agentes ao mesmo tempo» — o limite geral entre os projetos; «Ciclo do despachante, segundos» — com que frequência o orc procura trabalho; «Verificações ao mesmo tempo» — comandos verify em paralelo.",
          s3: "«Modelos nas listas suspensas» — oculte modelos que você nunca usa; um projeto pode manter sua própria lista.",
          s4: "«Modelo de tarefa» e «Instrução para resolução de conflito» — o texto que os agentes recebem; o orc preenche os marcadores.",
          s5: "«Padrões de cota esgotada» — uma lista JSON de expressões regulares; uma correspondência manda a tarefa esperar em vez de falhar.",
          s6: "Manutenção: quantos dias manter os eventos, o tamanho total dos anexos e a limpeza automática dos worktrees de tarefas mescladas.",
        },
        tip: "As configurações são validadas ao salvar: uma expressão regular ou um modelo quebrado não será aceito.",
      },
      hotkeys: {
        title: "Atalhos de teclado",
        where: "Em qualquer lugar do quadro",
        intro: "Funcionam quando o foco não está num campo de texto e nenhuma janela está aberta.",
        keys: {
          n: "Nova tarefa",
          slash: "Buscar tarefas",
          e: "Feed de eventos",
          d: "Quadro / Resumo",
          bracket: "Recolher a barra lateral",
          question: "Este guia",
          esc: "Fechar uma janela",
        },
      },
    },
  },
  demos: {
    board: {
      title: "O caminho de uma tarefa pelo quadro",
      card: "Adicionar um tema escuro",
      captions: {
        c1: "O cartão espera nos pendentes — uma anotação para depois.",
        c2: "Você o arrasta para «A fazer». Esse é todo o lançamento.",
        c3: "O despachante o pega: worktree, branch, `claude --bg`.",
        c4: "O agente terminou — o `verify_cmd` confere o resultado.",
        c5: "Verificação verde — merge `--no-ff` no branch base.",
        c6: "Concluído. O cartão mostra quanto a tarefa custou em tokens.",
      },
    },
    pipeline: {
      title: "Um ciclo do despachante",
      queue: "A fazer",
      captions: {
        c1: "Há uma vaga livre — a tarefa é tirada da fila.",
        c2: "Um worktree e um branch separados são criados para ela.",
        c3: "`claude --bg` começa com o seu encargo.",
        c4: "A sessão executa `orc task done` e termina o turno.",
        c5: "O `verify_cmd` roda no worktree da tarefa.",
        c6: "Merge no branch base, uma tarefa de cada vez.",
      },
    },
    input: {
      title: "O agente pergunta — você responde",
      card: "Migrar o banco de dados",
      otherCard: "Atualizar dependências",
      question: "Excluir a tabela antiga users_v1 ou mantê-la?",
      reply: "Mantenha por enquanto e adicione um TODO",
      captions: {
        c1: "O agente está trabalhando.",
        c2: "Ele tem uma pergunta: o cartão fica magenta e sobe.",
        c3: "Você abre o cartão: a pergunta é a última mensagem dele.",
        c4: "Você responde no campo de texto logo abaixo.",
        c5: "A resposta chega à mesma sessão, e o trabalho continua.",
      },
    },
    conflict: {
      title: "Um conflito volta para o autor",
      taskA: "Redesenho do cabeçalho",
      taskB: "Quadro compacto",
      captions: {
        c1: "Duas tarefas terminaram em paralelo; ambas miram `dev`.",
        c2: "#41 é mesclada primeiro.",
        c3: "#42 encontra as edições de #41 nos mesmos arquivos — um conflito.",
        c4: "O orc devolve o conflito à sessão de #42: `dev` é mesclado no branch dela.",
        c5: "A sessão o resolve pelo sentido e passa de novo pela verificação.",
        c6: "#42 é mesclada. Você não precisou fazer nada.",
      },
    },
    project: {
      title: "Adicionando um projeto",
      projectName: "my-app",
      captions: {
        c1: "Clique em «+» ao lado de «Projetos».",
        c2: "Informe um nome e o caminho do repositório.",
        c3: "O comando de verificação é a barreira antes do merge.",
        c4: "Quantos agentes podem trabalhar ao mesmo tempo.",
        c5: "Salve — o projeto aparece na barra lateral.",
      },
    },
  },
};
