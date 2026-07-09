# PRD — Vila Real e Lourival · pós-reunião de 09/07/2026

Fonte: relatório executivo da reunião de 09/07/2026 (Murilo, Maurício/MoMentum, comercial).
Verificado contra o código e o banco de produção em 09/07/2026.

> **Restrição que domina tudo:** a campanha do Vila Real ativa **10/07** e roda 30 dias.
> Os vendedores precisam de acesso antes disso. Tudo o que não for bloqueador de
> ativação é Etapa 2 ou posterior.

---

## Correções ao que foi assumido na reunião

Três itens da ata não sobrevivem ao contato com o código. Registrar isso é metade do valor deste PRD.

**1. "Leads chegando sem origem, tudo marcado como Google" não é um bug — é a ausência de uma feature.**
Nenhuma linha do código grava `contacts.origem`. O único caminho de escrita é o seletor manual na barra lateral do inbox (`src/components/inbox/origem-select.tsx`). Os 113 contatos da Vila Real com `origem='google'` foram **todos** criados em 04/07, o dia da migração — é backfill, não classificação. Tudo que entrou depois (39 contatos, 04/07→09/07) está `NULL`, porque nada preenche.
*Consequência:* não há o que "corrigir hoje". Há uma feature de detecção automática a construir (Etapa 3).

**2. "O técnico fornece webhook e token, a equipe de tráfego configura no Facebook" não funciona com o que existe.**
`POST /api/v1/leads` exige `Authorization: Bearer <chave>` e espera `nome`/`whatsapp` no corpo. O webhook de Lead Ads do Meta não manda header de autenticação, exige um `GET` de verificação respondendo `hub.challenge`, assina o `POST` com `X-Hub-Signature-256`, e o corpo traz apenas um `leadgen_id` — nome e telefone só saem de uma **segunda** chamada à Graph API com token de página. Não existe nenhuma rota de leadgen no projeto (`find src/app/api -iname '*meta*'` → vazio).
*Consequência:* isso é desenvolvimento (Etapa 5), não configuração. Prometer o token para a Mayara hoje gera um webhook que o Meta vai rejeitar na verificação.

**3. Dois dos "urgentes de hoje" já estão feitos.**
O bug das conversas que não entram no CRM foi diagnosticado e corrigido hoje, e a renomeação das etapas de follow-up também. Detalhes na Etapa 0 e na Etapa 4.

---

## Etapa 0 — Bloqueadores de ativação (hoje, 09/07)

**Objetivo:** a campanha pode ser ligada amanhã sem queimar verba.

### 0.1 · Conversas novas não entram no CRM — **CORRIGIDO E CONFIRMADO**

> **Prova, 09/07 21:26:** o canal do Guilherme recebeu **14 mensagens de cliente e 18 de
> atendente** depois da reescrita do webhook — as primeiras desde 04/07. Rafael segue em zero,
> mas o webhook dele está registrado com `?ch=` corretamente; é ausência de tráfego, não falha.

*Causa raiz:* o uazapi permite duas instâncias com o mesmo nome, e os canais **Rafael Nascimento** (`556593449810`) e **Arquiteto Guilherme Augusto** (`556599358892`) eram ambos `crm-e281ab4a-2`. O webhook resolvia o canal por nome com `.maybeSingle()`, que **retorna erro quando mais de uma linha casa**. O erro era descartado (só se lia `data`), `channel` virava `null` e a mensagem era jogada fora sem log. Quebrou em **04/07**, quando o nome colidiu — daí a suspeita da reunião ("travamento causado pelo CRM antigo") estar errada: o CRM antigo não tem nada com isso.

*Evidência:* última mensagem de Rafael em `04/07 12:04`, de Guilherme em `04/07 12:56`. O canal **Jonas**, de nome único (`crm-e281ab4a-3`), nunca parou.

*Correção aplicada (produção, sem deploy):* webhook das duas instâncias reescrito para `…/api/whatsapp/webhook/uazapi?ch=<channelId>`. O parâmetro `ch` já era lido com prioridade máxima pelo código em produção, mas nunca era emitido — era código morto.

*Correção no working tree (precisa deploy):*
- webhook resolve por `body.owner` (telefone da instância, único) antes do nome;
- colisão de nome agora emite `console.error` com os ids, em vez de descartar em silêncio;
- `webhookUrl()` passa a emitir `?ch=` para todo canal novo.

- [x] Confirmado com mensagem real (Guilherme, 09/07 20:00–21:26).
- [x] Re-registrado `?ch=` em Lourival e Canal 1. **4 dos 5 canais** já não dependem do nome.
- [ ] **Jonas fica de fora**: token inválido impede re-registrar o webhook. Ele ainda resolve pelo nome, que por sorte é único. Ver 0.3.
- [ ] Deploy do código (fallback por `owner` + log de colisão + `?ch=` para canais novos).

### 0.2 · Teste de ponta a ponta antes de ativar

Não ativar tráfego com bug em aberto. Critério de aceite, com lead real:

- [ ] preencher o formulário → o lead entra no CRM;
- [ ] a origem vem correta (depende da Etapa 3 — **hoje vai vir nula**);
- [ ] o card cai no funil certo (depende da Etapa 2);
- [ ] o vendedor certo enxerga o lead (depende da Etapa 1);
- [ ] responder pelo CRM e a mensagem chega no WhatsApp do lead.

> **Decisão necessária:** os critérios 2, 3 e 4 dependem de etapas que não ficam prontas hoje.
> Ou a ativação de 10/07 aceita lead sem origem e no funil antigo, ou ela escorrega.

### 0.3 · Token inválido do canal Jonas — **bug novo, descoberto hoje**

`uazapi_instance_token` e `uazapi_instance_id` do canal Jonas estão errados no banco (`401 Invalid token`; o id real é `r9810f90e17e345`, o banco diz `rd4e1c6192338a8`). Ele **recebe** normalmente, porque entrada não usa token — mas o **envio pelo CRM** provavelmente falha. As mensagens `agent` dele podem estar vindo do celular.

- [ ] Reconectar o canal Jonas pela UI para regravar id e token.
- [ ] Confirmar envio pelo CRM.

---

## Etapa 1 — Acesso segregado por vendedor (antes de 10/07)

**Decisão da reunião:** um login por vendedor, cada um vendo só o que lhe cabe; Exdras e Bruna como ADM, vendo tudo. Motivo declarado: os vendedores espiam conversas uns dos outros.

**Estado:** o mecanismo está **pronto e aplicado em produção** (migration `048_channel_members.sql`), mas **não restringe nada ainda**, porque todos os membros da Vila Real são `admin`.

*Como funciona:* `owner`/`admin` veem todos os canais; `agent`/`viewer` veem só os canais atribuídos em `channel_members`. Deny-by-default. O filtro se propaga por RLS para conversas, mensagens, contatos e cards do Kanban. Envio e reação já ficam barrados de graça, porque usam o cliente do usuário.

*Contatos sem conversa nenhuma* (lead de formulário, importado, manual) **continuam visíveis a todos** — eram 293 de 536, e escondê-los quebraria o funil de formulário.

*Validado em produção*, com `auth.uid()` forjado dentro de `BEGIN…ROLLBACK`:

| Perfil | Canais | Conversas | Mensagens | Contatos |
|---|---|---|---|---|
| Owner (antes e depois) | 3 | 94 | 1514 | 165 |
| Agente só com canal Jonas | 1 | 35 | 656 | 110 |
| Agente sem canal nenhum | 0 | 0 | 0 | 78 |

Os 110 fecham exatamente: 78 órfãos + 32 contatos do Jonas. Os 55 contatos exclusivos de Rafael/Guilherme ficaram ocultos.

- [ ] Deploy da UI (`member-channels-dialog.tsx`) e da rota `/api/account/members/[userId]/channels`. *Typecheck e lint passam; ainda não exercitei rodando o app.*
- [ ] Criar logins: **Exdras** e **Bruna** (`admin`), e um por vendedor (`agent`).
- [ ] Rebaixar para `agent` quem hoje é `admin` e atende.
- [ ] Atribuir a cada vendedor o seu canal.
- [ ] Treinar os vendedores no login individual.

> **Ponto de atenção — segregação por canal, não por atribuição.**
> A ata diz "vendo só as conversas **atribuídas** a ele". O que foi construído filtra por **canal**.
> Na Vila Real coincide, porque cada vendedor tem o próprio número (Rafael, Guilherme, Jonas).
> Se um dia dois vendedores dividirem um número, a segregação **não** vale entre eles.
> Filtrar também por `conversations.assigned_agent_id` é um segundo eixo, não construído.

> **Ponto de atenção — conta compartilhada.**
> O atendente real da Vila Real hoje é um login único (`villarealmarmores@gmail.com`, "Equipe").
> Um login por vendedor exige criar os usuários; não dá para derivar dos existentes.

> **Ponto de atenção — comercial.**
> Ficou combinado atrasar de propósito esta entrega como moeda de troca na renovação.
> A capacidade técnica está pronta hoje. Segurar é uma escolha de negócio; registrada aqui
> para que seja uma escolha consciente, e não um esquecimento.

---

## Etapa 2 — Funil único — **FEITO no código**

**Decisão:** descartar a separação entre "Funil de Vendas" e "Funil de Vendas Formulário".

**Estado:** a ingestão de lead foi extraída para `src/lib/api/v1/leads.ts` (`ingestLead`), usada pelas
duas entradas — formulário de site (`/api/v1/leads`) e Lead Ads do Meta. O lead agora cai no
**`Funil de Vendas`** da conta, na primeira etapa, e recebe `origem = 'formulario'`.

A gravação de origem usa `.is('origem', null)`: **o primeiro sinal vence**. Um contato que já veio
do WhatsApp não vira "formulário" só porque preencheu um formulário depois.

> **Consequência assumida, e ela é real.** O kanban `Formulário` existia justamente para que as
> automações do funil principal **não** agissem sobre leads de formulário. Com o funil único,
> elas passam a agir — inclusive a regra `Aguardando Atendimento → Em Atendimento`.
> Foi decidido na reunião; fica registrado para não virar surpresa depois.

- [x] `ingestLead` compartilhado, funil único, `origem='formulario'`.
- [ ] Migrar os 3 cards do funil `Formulário` da Vila Real e remover o funil. *Não fiz: mover card muda etapa, é dado de produção.*
- [ ] Revisar se alguma automação do Funil de Vendas se comporta mal com um lead que nunca mandou mensagem.

---

## Etapa 3 — Origem do lead: detectar e travar

**Decisão da reunião:** travar a origem dos leads de formulário; e cadastrar detecção automática **por frase de saudação**, com o comercial/Mayara enviando as frases das campanhas.

**Estado:** nada disso existe. `contacts.origem` só é escrita à mão, e `contacts_update` libera **qualquer `agent`** a alterar.

> ### O plano da reunião está obsoleto — e para melhor
>
> Casar frase de saudação é heurística: quebra quando a campanha muda o texto, quando o
> lead apaga a mensagem antes de enviar, e não distingue Instagram de Facebook.
>
> **O uazapi já entrega a atribuição do Meta dentro do JSON da mensagem.** Verificado hoje
> contra a instância do Lourival (`/message/find`, 875 mensagens): existem mensagens com
> `entryPointConversionSource = "ctwa_ad"` e `conversionSource = "FB_Ads"`.
>
> Em `content.contextInfo.externalAdReply` vêm, entre outras: `ctwaClid`, `sourceID`,
> `sourceURL`, `sourceApp`, `sourceType`, `ref`, `title`, `body` — e o
> **`greetingMessageBody`**, que é exatamente a frase de saudação que a reunião ia pedir
> para a Mayara coletar. Ela já chega de graça.
>
> **Consequência:** o CRM não fica só com a origem — fica com o `sourceID` do anúncio, ou seja,
> dá para atribuir lead → criativo, que é o que o time de tráfego realmente quer.
>
> **Hoje esse dado é jogado fora.** O webhook só consome os campos que tipou, e
> `public.messages` **não tem coluna de payload cru** — nada é preservado.
>
> **Mas o `ctwa` não resolve o Google.** Lead de Google Ads chega por link `wa.me`: cai em
> `click_to_chat_link`, sem `externalAdReply` e sem `sourceID`. Ali a **frase de saudação é o
> único sinal**. Ou seja, os dois mecanismos se complementam e a pendência das frases
> **continua valendo** — o que muda é que ela deixa de ser o mecanismo principal e passa a
> cobrir só o caso Google.

Mapeamento determinístico observado:

| `entryPointConversionSource` | `entryPointConversionApp` | origem |
|---|---|---|
| `ctwa_ad` | `instagram` | `instagram` (pago) |
| `ctwa_ad` | `facebook` | `facebook` (pago) |
| `click_to_chat_link` | — | Google/site — **desempatar pela frase** |
| `phone_number_hyperlink` | — | orgânico |
| `global_search_new_chat` | — | orgânico |

**Frases de saudação — Lourival** (fornecidas em 09/07):

| Frase (match exato, normalizado) | Origem |
|---|---|
| `Olá! Tenho interesse e queria mais informações, por favor.` | Meta |
| `Olá, gostaria de mais informações!` | Google |
| `Olá! Gostaria de um orçamento.` | Google |

*Validado contra o histórico real do Lourival:* a frase Meta apareceu numa mensagem com
`ctwa_ad` + `app=instagram` + `externalAdReply`; a frase Google apareceu com
`click_to_chat_link` e **sem** dado de anúncio. Os dois sinais concordam.

> **Cuidado com o match.** Só 2 das 875 mensagens casaram alguma frase — amostra de 1 por
> origem. E existe `"gostaria de fazer um orçamento"` (2x) no histórico, **parecido mas não
> idêntico** à frase do Google. A saudação é pré-preenchida pelo link, então o match deve ser
> **exato** (normalizando acento, caixa e espaço) e **só na primeira mensagem do contato**.
> Match aproximado classificaria como Google quem apenas digitou algo parecido.
>
> **Precedência:** quando houver `ctwa`, ele vence — é dado do Meta, não heurística.

**Frases da Vila Real ainda não existem** (pendência do comercial/Mayara). Sem elas, o lead de
Google da Vila Real fica sem origem — o `ctwa` cobrirá só Instagram/Facebook.

### 3.0 · Confirmar o formato no webhook (pré-requisito)
O dado acima foi lido da API de histórico (`/message/find`), onde o caminho é
`content.contextInfo`. O **payload do webhook** pode aninhar diferente — nosso tipo hoje
declara `contextInfo` no topo da mensagem (usado só para `stanzaId` de reação).
- [ ] Logar `contextInfo` cru no webhook e confirmar o caminho com uma mensagem de anúncio real.
- [ ] **A campanha da Vila Real começa 10/07** — é a primeira chance de ver um `ctwa_ad` chegando ao vivo. Ligar o log antes.

### 3.1 · Persistir a atribuição
- [ ] Guardar o payload de atribuição (coluna `jsonb` em `contacts` ou tabela `contact_attribution`): `ctwaClid`, `sourceID`, `sourceURL`, `sourceApp`, `entryPointConversionSource`.
- [ ] Derivar `contacts.origem` do mapa acima, na **primeira** mensagem do contato.
- [ ] Configuração por conta: `accounts.saudacoes` (`frase → origem`), alimentando o desempate do `click_to_chat_link`. Cadastrar as 3 frases do Lourival; cobrar as da Vila Real.
- [ ] `POST /api/v1/leads` grava `origem = 'formulario'`. *Hoje não grava — os 4 contatos com essa origem foram marcados à mão.*

### 3.2 · Travar contra alteração
- [ ] Coluna `contacts.origem_locked` (ou `origem_source`) marcando origem definida pelo sistema.
- [ ] Policy: `agent` não altera `origem` quando travada; `admin` altera.
- [ ] UI: seletor desabilitado com explicação, em vez de sumir.

### 3.3 · Backfill (limitado)
Dá para varrer o histórico via `/message/find` e preencher origem retroativa. **Mas o retorno é baixo:**
só 2 das 875 mensagens do Lourival têm `ctwa_ad`. Os 113 contatos `google` da Vila Real são
chute do backfill de migração, não dado real — considerar **limpar para `NULL`** em vez de manter
uma atribuição falsa que ninguém pode auditar.

---

## Etapa 4 — Follow-up automático

**Estado:** o motor existe (`/api/cron/followups`, de hora em hora, seg–sex 9h–17h).

### 4.1 · Renomear etapa — **FEITO**
`Follow-up Manual` → `Sem Resposta Follow-up AT`, no código e no banco (migration `047`).

> **Achado grave, colateral:** a Vila Real **já havia renomeado** essa etapa pela UI, e o cron
> casava a etapa por nome exato. Resultado: a fase de escalada **nunca moveu um único card** lá
> — 0 negócios na etapa. Não era cosmético; estava quebrado em silêncio desde a renomeação.
> O cron agora aceita o nome novo e o antigo, para que a próxima renomeação não repita isso.
>
> A ata registra o nome como `"Sem resposta FUP AT"`; foi implementado `"Sem Resposta Follow-up AT"`,
> conforme instrução direta. **Confirmar qual é o certo.**

### 4.2 · Pendente
- [ ] Reescrever a frase padrão do follow-up, mais neutra (**comercial**).
- [ ] Revisar a movimentação automática entre `Follow-up Automático`, `Respondeu Follow-up` e `Sem Resposta Follow-up AT` — agora que a escalada volta a funcionar, o comportamento real da Vila Real muda.
- [ ] **Sem IA**, por decisão de custo. Vale medir antes de fechar: o custo por mensagem de um modelo pequeno é fração de centavo, e o ponto de comparação é uma venda recuperada, não o custo por cliente.

---

## Etapa 5 — Formulário instantâneo do Meta — **CONSTRUÍDO, falta configurar**

> **Esta é a campanha da Vila Real de 10/07.** Não é click-to-WhatsApp: é Lead Ads.
> Logo o `ctwa` da Etapa 3 **não se aplica** a ela — a origem vem como `formulario`.
> Isto é o bloqueador de amanhã.

**Estado:** rota `GET/POST /api/webhooks/meta/leadgen` implementada, com migration `049_meta_leadgen.sql`
(`meta_pages` para `page_id → conta` + token de página cifrado; `meta_lead_events` para dedupe)
**já aplicada em produção**.

Exercitado contra o app rodando, não só typecheck:

| Caso | Resultado |
|---|---|
| `GET` com verify token correto | `200`, ecoa o `hub.challenge` em `text/plain` |
| `GET` com token errado / sem challenge | `403` |
| `POST` sem assinatura / errada / malformada | `401` |
| `POST` com assinatura válida | `200` |
| `POST` com corpo adulterado e assinatura antiga | `401` |
| Página não mapeada (permanente) | `200` — reentregar não ajudaria |
| Graph API falha (transitório) | `500` — o Meta reentrega; o dedupe torna inofensivo |
| Evento que não é `leadgen` | `200`, ignorado |

Decisões de projeto que valem registro:
- **Assinatura sobre os bytes crus.** Lemos `request.text()` e só então damos parse; reserializar o JSON quebraria o HMAC.
- **500 de propósito em falha transitória.** Perder um lead pago é pior que uma retentativa.
- **Dedupe por `leadgen_id`** antes de qualquer trabalho, porque o Meta reentrega.

### Conexão por cliente: OAuth, não `INSERT` manual

O primeiro desenho pedia uma linha em `meta_pages` por cliente, com o page access token
colado à mão. Não escala — e token colado à mão é token que vaza. Substituído por um fluxo
de OAuth, igual em espírito ao QR do WhatsApp:

**Configurações → Formulários do Meta → "Conectar Facebook"** →
`GET /api/meta/oauth/start` (admin+, emite um `state` assinado com o accountId) →
diálogo do Meta → `GET /api/meta/oauth/callback` → troca o `code` por um user token longo,
lista as páginas do usuário, **assina o campo `leadgen` de cada uma**
(`POST /{page_id}/subscribed_apps`) e grava `meta_pages` com o token cifrado.

O admin nunca vê nem copia segredo nenhum. Escopos: `pages_show_list`,
`pages_read_engagement`, `pages_manage_metadata`, `leads_retrieval`.

Detalhes que valem registro:
- **O `state` é HMAC-assinado** e vale 15 min. Sem isso, alguém chamaria o callback com o
  `accountId` de outra conta e plantaria a própria página lá dentro. Coberto por teste
  (`src/lib/meta/oauth.test.ts`), incluindo o ataque de reusar o MAC trocando o payload.
- **`page_id` é chave primária global.** O callback recusa conectar uma página que já
  pertence a outra conta — senão um upsert a sequestraria, e os leads dela cairiam na conta
  errada. Reconectar a mesma conta continua permitido (renova o token).
- **Assina antes de gravar.** Se o Meta recusar a assinatura, a página não entra no banco;
  do contrário ficaria uma linha que nunca receberia webhook.
- **Não há `INSERT` pela UI** (policy só de `SELECT` e `DELETE`, migration `050`). Um `INSERT`
  livre deixaria um admin apontar `page_id` alheio para a própria conta.

### Falta para amanhã (tudo configuração, nada de código)
- [ ] Na Vercel: `META_APP_ID`, `META_APP_SECRET` (**está vazio hoje**) e `META_VERIFY_TOKEN`. São do **app**, valem para todos os clientes.
- [ ] No app do Meta: cadastrar o redirect `https://super-crm.pro/api/meta/oauth/callback` e o webhook `https://super-crm.pro/api/webhooks/meta/leadgen` (campo `leadgen`).
- [ ] O cliente (ou você, como admin da conta) clica em **Conectar Facebook**. Isso substitui entregar webhook e token para a Mayara.
- [ ] Teste com lead real antes de ativar.

**Não testado de verdade:** a chamada à Graph API só foi exercitada com token falso (falha esperada, `OAuthException` code 190). O caminho feliz — `field_data` → contato → card — **nunca rodou com um lead real**. Os nomes de campo (`full_name`, `phone_number`) são o padrão do Meta, mas se o formulário da Vila Real usar rótulos customizados, o `pick()` não acha o telefone e o lead é descartado com log. **Conferir os nomes dos campos do formulário antes de ativar.**

**Enquanto isso:** tráfego vai para o site, rastreado por GTM (**Maurício**).

---

## Etapa 6 — Monitoramento (a lição de 04/07)

O bug das conversas passou **5 dias** despercebido e só apareceu porque alguém reparou. O comercial pediu aviso automático "sempre que der ruim".

- [ ] Heartbeat: se nenhuma mensagem entrar, por conta, durante X minutos em horário comercial → alerta.
- [ ] Alertar quando o webhook não resolver o canal (o `console.error` novo já dá o gancho).
- [ ] Alertar em `401` do uazapi (teria pego o token do Jonas).

---

## Etapa 7 — Comercial (fora do escopo técnico)

Modelo fechado: **R$ 300/cliente** na implementação (45 dias), recorrência enquanto o cliente permanecer, manutenção de 6 meses entre **R$ 250 e R$ 350** para quem não virar recorrente. O CRM antigo não será mais evoluído.

- [ ] Emitir o boleto do cliente pendente (**Murilo**, segunda-feira).

---

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Ativar a campanha em 10/07 com origem nula e funil antigo | Verba gasta em lead que não se rastreia | Aceitar conscientemente, ou adiar a ativação |
| Webhook do Meta prometido como configuração | Mayara tenta configurar e o Meta rejeita | Comunicar hoje que é desenvolvimento; usar intermediário se apertar |
| Token do Jonas inválido | Vendedor não responde pelo CRM | Reconectar o canal (0.3) |
| Etapa 2 reverte decisão de engenharia | Automações do funil principal passam a rodar sobre leads de formulário | Confirmar com o cliente antes |
| Segurar a Etapa 1 por estratégia | A capacidade já existe; atraso é escolha | Precificar na renovação em vez de atrasar |

---

## Ordem sugerida

1. **Hoje:** confirmar 0.1 com mensagem real → deploy → Etapa 1 (logins e atribuição) → 0.3.
2. **Antes de ativar:** rodar 0.2 e decidir o que é aceitável ficar de fora.
3. **Semana:** Etapa 3 (origem), Etapa 2 (funil único), Etapa 4.2.
4. **Depois:** Etapa 5 (Meta), Etapa 6 (monitoramento).
