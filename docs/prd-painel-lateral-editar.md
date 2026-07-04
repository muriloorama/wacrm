# PRD — Padrão "Clicar e Editar no Painel Lateral" (Side Panel)

> **Objetivo deste documento:** descrever, de forma completa e replicável, o
> padrão de UX/engenharia usado no wacrm em que o usuário **clica num item**
> (um card, uma linha, uma conversa) e a **edição abre num painel que desliza
> do lado da tela** — sem sair da página nem perder o contexto. Serve como
> especificação para reconstruir esse comportamento em qualquer tela ou
> projeto novo.

---

## 1. Resumo

Em vez de navegar para uma página de detalhe ou abrir um modal central que
tampa tudo, o usuário clica num item e um **painel lateral (Sheet)** entra
deslizando pela direita, mostrando o formulário de edição daquele item. O
fundo escurece levemente (backdrop), o foco vai para o painel, e o usuário
edita, salva e o painel fecha — voltando exatamente para onde estava (ex.: o
kanban com o card no mesmo lugar).

Exemplo canônico no produto: **editar um negócio** no funil (kanban). Clicar
no card abre o `DealForm` num Sheet à direita.

Padrões irmãos (mesma filosofia, variação de layout): a **sidebar de contato**
no Inbox (painel persistente/colapsável) e a **tela de Configurações**
(rail de seções à esquerda + painel à direita).

---

## 2. Por que esse padrão (problema que resolve)

| Dor | Como o painel lateral resolve |
|---|---|
| Modal central tampa a lista/board e desorienta | O painel ocupa só um lado; o contexto (kanban) continua visível atrás |
| Navegar para `/deal/:id` perde o scroll/estado do board | Nada de navegação: é estado local, o board fica intacto ao fechar |
| Formulário longo não cabe num modal | O Sheet tem altura total com **corpo rolável** independente |
| Criar e editar são telas diferentes | **Mesmo painel** serve para criar (`item = null`) e editar (`item = obj`) |
| Mobile x desktop | O mesmo Sheet vira quase-full-width no mobile e um painel estreito no desktop |

Princípio central: **preservar o contexto**. O usuário nunca "sai" da tela
principal; ele abre uma gaveta, resolve, e fecha.

---

## 3. Anatomia — as 3 camadas

```
┌─ Página/Container (dono do estado) ────────────────────────┐
│   • estado: open (bool) + editingItem (obj | null)         │
│   • handlers: openForEdit(item), openForCreate(), onSaved  │
│                                                            │
│   ┌─ Lista/Board (itens clicáveis) ─────────────┐          │
│   │   Card.onClick → onEditItem(item)           │          │
│   └─────────────────────────────────────────────┘          │
│                                                            │
│   ┌─ Painel de edição (Sheet + formulário) ─────┐          │
│   │   <Sheet open onOpenChange>                  │          │
│   │     <SheetContent side="right">             │          │
│   │        header fixo · corpo rolável · footer  │          │
│   │     </SheetContent>                          │          │
│   │   </Sheet>                                   │          │
│   └─────────────────────────────────────────────┘          │
└────────────────────────────────────────────────────────────┘
```

### Camada 1 — O componente `Sheet` (reutilizável)

Arquivo: `src/components/ui/sheet.tsx`. É um wrapper fino sobre o **Base UI
Dialog** (`@base-ui/react/dialog`) configurado para deslizar de um lado.
Responsabilidades (herdadas do Base UI, "de graça"):

- **Portal**: renderiza fora da árvore, por cima de tudo (`z-50`).
- **Backdrop/overlay**: fundo semitransparente com leve blur, clicável para fechar.
- **Foco preso (focus trap)** dentro do painel enquanto aberto.
- **ESC** e **clique fora** fecham (via `onOpenChange`).
- **Animação de entrada/saída** por `data-side` (`right` desliza no eixo X).
- **Botão X** de fechar no canto (`showCloseButton`, padrão `true`).
- **A11y**: `role="dialog"`, `aria-modal`, título/descrição associados.

Props principais de `SheetContent`:

- `side`: `"top" | "right" | "bottom" | "left"` (padrão `"right"`).
- `showCloseButton`: mostra o X (padrão `true`).
- `className`: largura/estilo do painel.

Largura padrão: `w-3/4` no mobile, `sm:max-w-sm` no desktop (o `DealForm`
sobrescreve para `sm:max-w-lg`).

Subcomponentes exportados: `Sheet`, `SheetTrigger`, `SheetClose`,
`SheetContent`, `SheetHeader`, `SheetFooter`, `SheetTitle`, `SheetDescription`.

### Camada 2 — O container dono do estado

Quem controla o painel é a **página** (não o card, não o form). Ela guarda:

```tsx
const [dealFormOpen, setDealFormOpen] = useState(false);
const [editingDeal, setEditingDeal]   = useState<Deal | null>(null);
const [defaultStageId, setDefaultStageId] = useState("");

// Abrir para EDITAR um item existente
const handleEditDeal = useCallback((deal: Deal) => {
  setEditingDeal(deal);
  setDefaultStageId(deal.stage_id);
  setDealFormOpen(true);
}, []);

// Abrir para CRIAR (mesmo painel, item = null)
const handleAddDeal = useCallback((stageId?: string) => {
  setEditingDeal(null);
  setDefaultStageId(stageId ?? stages[0]?.id ?? "");
  setDealFormOpen(true);
}, [stages]);
```

E renderiza o painel uma única vez, no fim da página:

```tsx
<DealForm
  open={dealFormOpen}
  onOpenChange={setDealFormOpen}
  deal={editingDeal}            // null = criar, objeto = editar
  pipelineId={selectedPipelineId}
  stages={stages}
  defaultStageId={defaultStageId}
  onSaved={refreshDeals}        // callback pós-salvar (refetch)
/>
```

Regra de ouro: **`editingItem = null` → modo criar; `editingItem = objeto` →
modo editar.** Um só painel para os dois fluxos.

### Camada 3 — O item clicável (o gatilho)

O card só **avisa** o container que foi clicado — ele não sabe nada do painel:

```tsx
// deal-card.tsx (resumo)
<button
  type="button"
  onClick={(e) => {
    if (isOverlay) return;      // ignora o "fantasma" do drag overlay
    e.stopPropagation();        // não deixa o clique borbulhar para a coluna
    onEdit(deal);               // ← só dispara o callback do pai
  }}
>
  …conteúdo do card…
</button>
```

No board, o card é embrulhado pelo dnd-kit; o `PointerSensor` exige mover
**5px** antes de virar arraste, então um toque simples continua sendo clique
(abre o painel) e um arraste move o card:

```tsx
useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
```

---

## 4. O formulário dentro do Sheet (estrutura interna)

O `DealForm` monta o Sheet e organiza o conteúdo em **3 faixas**: header fixo,
corpo rolável, footer fixo (padrão "app shell" dentro da gaveta).

```tsx
<Sheet open={open} onOpenChange={onOpenChange}>
  <SheetContent
    side="right"
    className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
  >
    <div className="flex h-full flex-col">
      {/* HEADER fixo */}
      <SheetHeader className="border-b border-border/50 p-4">
        <SheetTitle>{deal ? "Editar Negócio" : "Novo Negócio"}</SheetTitle>
      </SheetHeader>

      {/* CORPO rolável — só ele rola, header e footer ficam fixos */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* …campos do formulário… */}
      </div>

      {/* FOOTER fixo com ações (Salvar / Cancelar) */}
    </div>
  </SheetContent>
</Sheet>
```

Detalhes que fazem a diferença:

- `p-0` no `SheetContent` + padding próprio nas faixas = header/footer coláveis
  nas bordas e corpo com scroll isolado.
- `flex h-full flex-col` + `flex-1 overflow-y-auto` no corpo = o formulário
  longo rola sem empurrar o header/footer.
- O **título muda** conforme criar/editar (`deal ? "Editar" : "Novo"`).

---

## 5. Fluxo de dados (ciclo de vida)

```
1. Usuário clica no card
        │  onEdit(deal)
        ▼
2. Página: setEditingDeal(deal) + setDealFormOpen(true)
        │
        ▼
3. Sheet abre (anima da direita). O DealForm, ao abrir:
   • carrega dados auxiliares (contatos, etapas, etiquetas, membros)
   • popula os campos a partir do prop `deal` (ou vazio se null)
        │
        ▼
4. Usuário edita e clica Salvar
   • valida
   • grava no Supabase (insert se novo, update se editando)
        │
        ▼
5. onSaved()  →  a página refaz o fetch dos negócios (refreshDeals)
   onOpenChange(false)  →  o Sheet fecha (anima de volta)
        │
        ▼
6. Board volta ao normal, já com o dado atualizado. Contexto preservado.
```

Pontos importantes:
- O painel **carrega seus próprios dados** ao abrir (self-contained), o pai só
  passa o item e recebe o `onSaved`.
- **Atualização otimista opcional**: no wacrm, mover card entre etapas é
  otimista com rollback; o formulário usa refetch simples pós-salvar.
- Fechar por ESC / clique-fora / X chama o mesmo `onOpenChange(false)`.

---

## 6. Responsivo e acessibilidade

**Responsivo** (tudo via classes do `SheetContent`):
- Mobile: painel ocupa `w-3/4` (ou `w-full` quando o form pede) — quase tela
  cheia, mas o backdrop à esquerda ainda indica "gaveta".
- Desktop: `sm:max-w-lg` (ou `sm:max-w-sm` no padrão) — painel estreito, board
  visível atrás.
- Entrada/saída animadas por `data-[side=right]:...translate-x-[2.5rem]` +
  `data-starting-style` / `data-ending-style` (Base UI).

**Acessibilidade** (herdada do Base UI Dialog — não precisa reimplementar):
- Foco move para o painel ao abrir e fica preso nele.
- `Esc` fecha; foco retorna ao gatilho ao fechar.
- `role="dialog"`, `aria-modal`, `SheetTitle`/`SheetDescription` ligam o
  rótulo. Sempre inclua um `SheetTitle` (mesmo `sr-only`) para leitor de tela.

---

## 7. Tokens de estilo usados (tema)

Para o painel combinar com o tema (claro/escuro) do app, use variáveis, nunca
cores fixas:

- Superfície do painel: `bg-popover` + `text-popover-foreground`.
- Bordas/divisórias: `border-border`, `border-border/50`.
- Backdrop: `bg-background/10` + `supports-backdrop-filter:backdrop-blur-xs`.
- Realce/foco: `text-primary`, `bg-primary/15`.
- Texto secundário: `text-muted-foreground`.

O tema é controlado por `data-mode` no `<html>` (não pela classe `.dark`).

---

## 8. Passo a passo para replicar (checklist)

1. **Tenha um componente `Sheet`** (Base UI Dialog ou Radix Dialog) com
   `side`, portal, backdrop, focus-trap e botão de fechar. (Reaproveite
   `src/components/ui/sheet.tsx`.)
2. **No container/página**, crie o estado:
   `const [open, setOpen] = useState(false)` e
   `const [editing, setEditing] = useState<T | null>(null)`.
3. **Crie dois handlers**: `openForEdit(item)` (`setEditing(item); setOpen(true)`)
   e `openForCreate()` (`setEditing(null); setOpen(true)`).
4. **Nos itens clicáveis**, chame `onEdit(item)` no `onClick`
   (com `stopPropagation` se estiver dentro de área arrastável/aninhada).
5. **Renderize UM painel** no fim da página, controlado por `open`/`onOpenChange`,
   recebendo `item={editing}` e um callback `onSaved`.
6. **Dentro do painel**, monte header fixo + corpo `overflow-y-auto` + footer;
   título condicional ("Editar" vs "Novo").
7. O painel **carrega seus dados** ao abrir e **popula** a partir do item.
8. Ao salvar: grava → `onSaved()` (o pai refaz o fetch) → `onOpenChange(false)`.
9. Se houver drag-and-drop, use `activationConstraint: { distance: 5 }` para
   não confundir clique com arraste.

Snippet mínimo (genérico):

```tsx
function Board({ items }: { items: T[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);

  const edit   = (i: T) => { setEditing(i); setOpen(true); };
  const create = ()      => { setEditing(null); setOpen(true); };

  return (
    <>
      <button onClick={create}>Novo</button>
      {items.map((i) => (
        <button key={i.id} onClick={() => edit(i)}>{i.title}</button>
      ))}

      <ItemForm
        open={open}
        onOpenChange={setOpen}
        item={editing}          // null = criar
        onSaved={refetch}
      />
    </>
  );
}

function ItemForm({ open, onOpenChange, item, onSaved }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg p-0">
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b p-4">
            <SheetTitle>{item ? "Editar" : "Novo"}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">{/* campos */}</div>
          <SheetFooter>{/* Salvar / Cancelar */}</SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

---

## 9. Variações do mesmo padrão no wacrm

| Uso | Variante | Observação |
|---|---|---|
| Editar negócio (kanban) | **Sheet overlay** à direita | Backdrop + slide; foco no form |
| Sidebar de contato (Inbox) | **Coluna persistente/colapsável** | Fica fixa ao lado; toggle `contactPanelOpen` (não é overlay) |
| Configurações | **Rail à esquerda + painel à direita** | Deep-link por `?tab=`; troca de painel sem navegar |

Quando usar cada um:
- **Sheet overlay**: edição pontual e focada (um item por vez), em telas onde o
  fundo deve ficar visível mas inativo.
- **Coluna persistente**: quando o painel acompanha o item selecionado e o
  usuário alterna muito entre lista e detalhe (ex.: chat + dados do contato).
- **Rail + painel**: navegação entre seções de um mesmo espaço (settings).

---

## 10. Armadilhas (pitfalls) já resolvidas aqui

- **Clique virando arraste**: sem `activationConstraint.distance`, um toque no
  card era interpretado como drag e o painel não abria. Solução: `distance: 5`.
- **Clique borbulhando**: sem `e.stopPropagation()` no card, o clique atingia a
  coluna/droppable. Sempre isole o clique do item.
- **"Card fantasma" do DragOverlay**: o overlay renderiza uma cópia do card;
  guarde uma flag (`isOverlay`) e **ignore o onClick** nela.
- **Sheet dentro de Sheet**: evite abrir um Sheet a partir de outro; prefira
  trocar o conteúdo do mesmo painel.
- **Título ausente**: Base UI Dialog exige um `Title` para a11y — inclua sempre
  (use `sr-only` se não quiser mostrar).
- **Cores fixas**: use tokens (`bg-popover`, `border-border`) para o painel
  seguir o tema; cores hardcoded quebram no dark mode.

---

## 11. Referências no código (wacrm)

- Componente reutilizável: `src/components/ui/sheet.tsx`
- Formulário no Sheet: `src/components/pipelines/deal-form.tsx`
- Estado + wiring: `src/app/(dashboard)/pipelines/page.tsx`
  (`dealFormOpen`, `editingDeal`, `handleEditDeal`, `handleAddDeal`, `<DealForm>`)
- Item clicável + drag: `src/components/pipelines/deal-card.tsx` e
  `src/components/pipelines/pipeline-board.tsx` (`PointerSensor`, `DragOverlay`)
- Variante coluna persistente: `src/components/inbox/message-thread.tsx`
  (`contactPanelOpen` / `onToggleContactPanel`) + `contact-sidebar.tsx`
- Variante rail+painel: `src/app/(dashboard)/settings/page.tsx` +
  `src/components/settings/settings-rail.tsx`

---

## 12. Critérios de aceite (para considerar "replicado com sucesso")

- [ ] Clicar num item abre o painel deslizando do lado, sem navegar de página.
- [ ] O board/lista continua visível atrás (com backdrop), e volta intacto ao fechar.
- [ ] O mesmo painel cria (`item = null`) e edita (`item = objeto`).
- [ ] Header e footer ficam fixos; só o corpo do formulário rola.
- [ ] Fecha por: botão X, tecla Esc, clique fora — todos via `onOpenChange(false)`.
- [ ] Ao salvar, o dado aparece atualizado na lista (via `onSaved`/refetch) e o painel fecha.
- [ ] Mobile: painel quase full-width; desktop: painel estreito.
- [ ] Foco entra no painel ao abrir e retorna ao item ao fechar (a11y).
- [ ] Se houver drag-and-drop, clique ≠ arraste (distância mínima de ativação).
