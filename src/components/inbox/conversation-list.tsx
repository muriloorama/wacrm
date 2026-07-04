"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  Image as ImageIcon,
  Mic,
  Video,
  FileText,
  Check,
  Archive,
  ArchiveRestore,
  Pin,
  PinOff,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { SmartAvatar } from "@/components/ui/smart-avatar";
import { stripWhatsAppMarkers } from "./linkified-text";

/** Canal de WhatsApp para o seletor de caixa de entrada. */
type ChannelOption = { id: string; name: string };
/** Valor do seletor quando nenhum canal específico está selecionado. */
const ALL_CHANNELS = "all";

/** Funil (pipeline) da conta para o filtro por funil. */
type PipelineOption = { id: string; name: string };
/** Valor do seletor quando nenhum funil específico está selecionado. */
const ALL_PIPELINES = "all";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

/**
 * Prévia de mídia: quando `last_message_text` é um dos marcadores crus
 * ("[imagem]", "[áudio]", "[vídeo]", "[documento]") mostramos um ícone +
 * rótulo curto em vez do texto literal. Retorna `null` para texto comum.
 */
const MEDIA_PREVIEWS: Record<
  string,
  { icon: typeof ImageIcon; label: string }
> = {
  "[imagem]": { icon: ImageIcon, label: "Foto" },
  "[áudio]": { icon: Mic, label: "Áudio" },
  "[vídeo]": { icon: Video, label: "Vídeo" },
  "[documento]": { icon: FileText, label: "Documento" },
};

type InboxFilter = ConversationStatus | "all" | "unread" | "archived";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "Todas", value: "all" },
  { label: "Não lidas", value: "unread" },
  { label: "Abertas", value: "open" },
  { label: "Pendentes", value: "pending" },
  { label: "Fechadas", value: "closed" },
  { label: "Arquivadas", value: "archived" },
];

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // Seletor de caixa de entrada por canal de WhatsApp. `null` = todos os canais.
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  // Overrides otimistas das etiquetas do contato, alteradas pelo menu de
  // contexto (botão direito) na lista. Chave = contact_id → ids de etiquetas.
  // Sobrepõem `conversation.contact.tags` para refletir a mudança na hora,
  // sem depender de um refetch/realtime do pai.
  const [contactTagOverrides, setContactTagOverrides] = useState<
    Record<string, string[]>
  >({});
  // Filtro por funil (pipeline). `null` = todos os funis. Quando um funil
  // está selecionado, `pipelineContactIds` guarda os contact_ids que têm
  // negócio (deal) nesse funil; só essas conversas passam no filtro.
  const { accountId } = useAuth();
  const [pipelines, setPipelines] = useState<PipelineOption[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string | null>(
    null,
  );
  const [pipelineContactIds, setPipelineContactIds] = useState<Set<string> | null>(
    null,
  );
  // Overrides otimistas do estado `archived` das conversas, alterados pelo
  // menu de contexto (botão direito). Chave = conversation_id → arquivada?
  // Sobrepõem `conversation.archived` para refletir na hora, sem refetch.
  const [archivedOverrides, setArchivedOverrides] = useState<
    Record<string, boolean>
  >({});
  // Overrides otimistas do estado "fixada" das conversas, alterados pelo menu
  // de contexto. Chave = conversation_id → fixada? Sobrepõem `pinned_at` para
  // refletir na hora e reordenar (fixadas no topo) sem esperar refetch/realtime.
  const [pinnedOverrides, setPinnedOverrides] = useState<
    Record<string, boolean>
  >({});

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      let query = supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      // Escopo por canal: quando um canal específico está selecionado, carrega
      // só as conversas dele. "Todos os canais" (null) mantém a consulta ampla.
      if (selectedChannelId) {
        query = query.eq("channel_id", selectedChannelId);
      }

      const { data, error } = await query;

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
    // `selectedChannelId` refetches (scoped) when the agent switches the
    // inbox channel selector.
  }, [resyncToken, selectedChannelId]);

  // Carrega os canais da conta para o seletor de caixa de entrada. Lido
  // direto de whatsapp_channels (RLS por conta) — leve, sem tocar o provedor.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("whatsapp_channels")
        .select("id, name")
        .order("created_at", { ascending: true });
      if (!cancelled && data) {
        setChannels(
          data.map((c) => ({ id: c.id as string, name: (c.name as string) ?? "Canal" })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Funis (pipelines) da conta para o filtro por funil. Carregados uma vez;
  // escopo por conta via account_id (RLS por conta também garante isso).
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("pipelines")
        .select("id, name")
        .eq("account_id", accountId)
        .order("name");
      if (!cancelled && data) {
        setPipelines(
          data.map((p) => ({
            id: p.id as string,
            name: (p.name as string) ?? "Funil",
          })),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Ao escolher um funil, busca os contact_ids com negócio (deal) nele e monta
  // um Set. `null` quando nenhum funil está selecionado (filtro desligado).
  useEffect(() => {
    if (!selectedPipelineId) {
      setPipelineContactIds(null);
      return;
    }
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("deals")
        .select("contact_id")
        .eq("pipeline_id", selectedPipelineId);
      if (cancelled) return;
      const set = new Set<string>();
      for (const d of data ?? []) {
        const cid = d.contact_id as string | null;
        if (cid) set.add(cid);
      }
      setPipelineContactIds(set);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  // Mapa canal → nome, para exibir de qual caixa de entrada é cada conversa.
  // Só faz sentido quando há mais de um canal; com um único, o badge é ruído.
  const channelNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of channels) m.set(ch.id, ch.name);
    return m;
  }, [channels]);
  // Mostra o nome do canal (caixa de entrada) em cada conversa sempre que
  // houver ao menos um canal — para o usuário saber a qual caixa pertence.
  const showChannelBadge = channels.length >= 1;

  const filtered = useMemo(() => {
    let result = conversations;

    // Guarda por canal também no cliente: o realtime do pai anexa conversas
    // de qualquer canal ao estado, então filtramos aqui para não vazar
    // conversas de outro canal quando um específico está selecionado.
    if (selectedChannelId) {
      result = result.filter((c) => c.channel_id === selectedChannelId);
    }

    // Arquivadas: por padrão a lista NÃO as mostra — mesmo quando o realtime
    // do pai injeta uma conversa arquivada que recebeu mensagem nova. Só o
    // filtro "Arquivadas" as exibe (e aí mostra SOMENTE as arquivadas).
    // Usa o override otimista quando existe, senão o valor da conversa.
    const isArchived = (c: Conversation) =>
      archivedOverrides[c.id] ?? c.archived ?? false;
    if (filter === "archived") {
      result = result.filter((c) => isArchived(c));
    } else {
      result = result.filter((c) => !isArchived(c));
      if (filter === "unread") {
        result = result.filter((c) => c.unread_count > 0);
      } else if (filter !== "all") {
        result = result.filter((c) => c.status === filter);
      }
    }

    // Filtro por funil: só conversas cujo contato tem negócio no funil.
    if (pipelineContactIds) {
      result = result.filter(
        (c) => c.contact_id != null && pipelineContactIds.has(c.contact_id),
      );
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    // Conversas fixadas sobem para o topo (estilo WhatsApp). `result` já vem
    // ordenado por `last_message_at DESC`; um sort estável por "fixada?" mantém
    // a ordem relativa dentro de cada grupo (fixadas e não-fixadas).
    const isPinned = (c: Conversation) =>
      pinnedOverrides[c.id] ?? Boolean(c.pinned_at);
    result = [...result].sort(
      (a, b) => Number(isPinned(b)) - Number(isPinned(a)),
    );

    return result;
  }, [
    conversations,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    selectedChannelId,
    pipelineContactIds,
    archivedOverrides,
    pinnedOverrides,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  /**
   * Ids de etiquetas atuais de um contato: usa o override otimista se houver,
   * senão deriva de `contact.tags` embutido na conversa.
   */
  const getContactTagIds = useCallback(
    (conv: Conversation): string[] => {
      const contactId = conv.contact?.id;
      if (contactId && contactTagOverrides[contactId]) {
        return contactTagOverrides[contactId];
      }
      return (conv.contact?.tags ?? []).map((t) => t.id);
    },
    [contactTagOverrides]
  );

  /**
   * Adiciona/remove uma etiqueta do contato (menu de contexto na lista).
   * Espelha o padrão de `contact-detail-view.tsx`: insert/delete na tabela de
   * junção `contact_tags`. Atualiza o override otimista para refletir na UI.
   */
  const toggleContactTag = useCallback(
    async (contactId: string, tagId: string, currentIds: string[]) => {
      const supabase = createClient();
      const isSelected = currentIds.includes(tagId);
      const next = isSelected
        ? currentIds.filter((id) => id !== tagId)
        : [...currentIds, tagId];

      // Otimista: reflete já, reverte no erro.
      setContactTagOverrides((prev) => ({ ...prev, [contactId]: next }));

      const { error } = isSelected
        ? await supabase
            .from("contact_tags")
            .delete()
            .eq("contact_id", contactId)
            .eq("tag_id", tagId)
        : await supabase
            .from("contact_tags")
            .insert({ contact_id: contactId, tag_id: tagId });

      if (error) {
        setContactTagOverrides((prev) => ({ ...prev, [contactId]: currentIds }));
        toast.error("Falha ao atualizar etiqueta");
      }
    },
    []
  );

  /**
   * Arquiva/desarquiva uma conversa (menu de contexto na lista). Atualiza a
   * coluna `conversations.archived` e o override otimista para refletir já.
   */
  const toggleArchived = useCallback(
    async (conversationId: string, nextArchived: boolean) => {
      const supabase = createClient();
      // Otimista: reflete já, reverte no erro.
      setArchivedOverrides((prev) => ({
        ...prev,
        [conversationId]: nextArchived,
      }));

      const { error } = await supabase
        .from("conversations")
        .update({ archived: nextArchived })
        .eq("id", conversationId);

      if (error) {
        setArchivedOverrides((prev) => ({
          ...prev,
          [conversationId]: !nextArchived,
        }));
        toast.error(
          nextArchived
            ? "Falha ao arquivar conversa"
            : "Falha ao desarquivar conversa",
        );
      }
    },
    [],
  );

  /**
   * Fixa/desafixa uma conversa (menu de contexto na lista). Grava `pinned_at`
   * (timestamp ao fixar, null ao desafixar) e atualiza o override otimista
   * para subir/descer a conversa na hora. Pin é por conta (igual arquivar).
   */
  const togglePinned = useCallback(
    async (conversationId: string, nextPinned: boolean) => {
      const supabase = createClient();
      // Otimista: reflete já, reverte no erro.
      setPinnedOverrides((prev) => ({
        ...prev,
        [conversationId]: nextPinned,
      }));

      const { error } = await supabase
        .from("conversations")
        .update({ pinned_at: nextPinned ? new Date().toISOString() : null })
        .eq("id", conversationId);

      if (error) {
        setPinnedOverrides((prev) => ({
          ...prev,
          [conversationId]: !nextPinned,
        }));
        toast.error(
          nextPinned ? "Falha ao fixar conversa" : "Falha ao desafixar conversa",
        );
      }
    },
    [],
  );

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        {/* Seletor de caixa de entrada por canal. Só aparece quando há mais
            de um canal — com um único canal, filtrar não faz diferença. */}
        {channels.length > 1 && (
          <Select
            value={selectedChannelId ?? ALL_CHANNELS}
            onValueChange={(v) =>
              setSelectedChannelId(v === ALL_CHANNELS ? null : v)
            }
          >
            <SelectTrigger className="h-8 w-full border-border bg-muted text-sm text-foreground">
              <SelectValue placeholder="Todos os canais" />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              <SelectItem value={ALL_CHANNELS}>Todos os canais</SelectItem>
              {channels.map((ch) => (
                <SelectItem key={ch.id} value={ch.id}>
                  {ch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Filtro por funil (pipeline). Só aparece quando há funis na conta.
            "Todos os funis" limpa o filtro. */}
        {pipelines.length > 0 && (
          <Select
            value={selectedPipelineId ?? ALL_PIPELINES}
            onValueChange={(v) =>
              setSelectedPipelineId(v === ALL_PIPELINES ? null : v)
            }
          >
            <SelectTrigger className="h-8 w-full border-border bg-muted text-sm text-foreground">
              <SelectValue placeholder="Todos os funis" />
            </SelectTrigger>
            <SelectContent className="border-border bg-popover">
              <SelectItem value={ALL_PIPELINES}>Todos os funis</SelectItem>
              {pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder="Buscar conversas..."
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? "Todas"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Etiquetas
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Empresa"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  Todas as empresas
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Etiqueta"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Limpar tudo
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                channelName={
                  showChannelBadge && conv.channel_id
                    ? channelNameById.get(conv.channel_id) ?? null
                    : null
                }
                tags={tags}
                contactTagIds={getContactTagIds(conv)}
                onToggleContactTag={toggleContactTag}
                isArchived={
                  archivedOverrides[conv.id] ?? conv.archived ?? false
                }
                onToggleArchived={toggleArchived}
                isPinned={
                  pinnedOverrides[conv.id] ?? Boolean(conv.pinned_at)
                }
                onTogglePinned={togglePinned}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Nome do canal (caixa de entrada) da conversa; null oculta o badge. */
  channelName: string | null;
  /** Etiquetas da conta, para o menu de contexto (botão direito). */
  tags: Tag[];
  /** Ids das etiquetas que o contato desta conversa já possui. */
  contactTagIds: string[];
  /** Adiciona/remove uma etiqueta do contato. */
  onToggleContactTag: (
    contactId: string,
    tagId: string,
    currentIds: string[]
  ) => void;
  /** Se a conversa está arquivada (usado no rótulo do menu de contexto). */
  isArchived: boolean;
  /** Arquiva/desarquiva a conversa. */
  onToggleArchived: (conversationId: string, nextArchived: boolean) => void;
  /** Se a conversa está fixada (indicador visual + rótulo do menu). */
  isPinned: boolean;
  /** Fixa/desafixa a conversa. */
  onTogglePinned: (conversationId: string, nextPinned: boolean) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  channelName,
  tags,
  contactTagIds,
  onToggleContactTag,
  isArchived,
  onToggleArchived,
  isPinned,
  onTogglePinned,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();

  // Menu de contexto (botão direito) → etiquetas. Um DropdownMenu controlado,
  // ancorado num ponto invisível posicionado no local do clique.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
    setMenuOpen(true);
  }, []);

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: ptBR,
      })
    : "";

  // Prévia de mídia: marcador cru → ícone + rótulo. undefined = texto comum.
  const mediaPreview = conversation.last_message_text
    ? MEDIA_PREVIEWS[conversation.last_message_text]
    : undefined;

  const contactId = contact?.id ?? null;

  return (
    <>
    <button
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        <SmartAvatar
          src={contact?.avatar_url}
          alt={displayName}
          fallback={initials}
          className="h-10 w-10 rounded-full object-cover"
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            {isPinned && (
              <Pin className="size-3 fill-current text-muted-foreground" />
            )}
            {timeAgo}
          </span>
        </div>
        {channelName && (
          <Badge
            variant="secondary"
            className="mt-1 h-4 px-1.5 text-[10px] font-normal"
          >
            {channelName}
          </Badge>
        )}
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
            {mediaPreview ? (
              <>
                <mediaPreview.icon className="size-3 shrink-0" />
                <span className="truncate">{mediaPreview.label}</span>
              </>
            ) : conversation.last_message_text ? (
              stripWhatsAppMarkers(conversation.last_message_text)
            ) : (
              "Nenhuma mensagem ainda"
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>

    {/* Menu de contexto (botão direito) → etiquetas do contato + arquivar.
        DropdownMenu controlado, ancorado num ponto invisível (fixed) no
        local do clique. Arquivar está sempre disponível; etiquetas só com
        um contato e etiquetas na conta. */}
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        render={
          <span
            aria-hidden
            className="pointer-events-none fixed"
            style={{ left: menuPos.x, top: menuPos.y }}
          />
        }
      />
      <DropdownMenuContent
        align="start"
        className="max-h-64 w-56 overflow-y-auto border-border bg-popover"
      >
        {contactId && tags.length > 0 && (
          <>
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Etiquetas
            </div>
            {tags.map((t) => {
              const checked = contactTagIds.includes(t.id);
              return (
                <DropdownMenuItem
                  key={t.id}
                  // Base UI usa `onClick` (não `onSelect`, que é do Radix e no
                  // Base UI vira o evento DOM nativo, nunca disparando).
                  // `closeOnClick={false}` mantém o menu aberto para alternar
                  // várias etiquetas de uma vez.
                  closeOnClick={false}
                  onClick={() =>
                    onToggleContactTag(contactId, t.id, contactTagIds)
                  }
                  className="text-sm text-popover-foreground"
                >
                  <span className="flex flex-1 items-center gap-2">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: t.color }}
                    />
                    <span className="truncate">{t.name}</span>
                  </span>
                  {checked && (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  )}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onClick={() => onTogglePinned(conversation.id, !isPinned)}
          className="text-sm text-popover-foreground"
        >
          {isPinned ? (
            <>
              <PinOff className="size-3.5 shrink-0" />
              <span>Desafixar conversa</span>
            </>
          ) : (
            <>
              <Pin className="size-3.5 shrink-0" />
              <span>Fixar conversa</span>
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onToggleArchived(conversation.id, !isArchived)}
          className="text-sm text-popover-foreground"
        >
          {isArchived ? (
            <>
              <ArchiveRestore className="size-3.5 shrink-0" />
              <span>Desarquivar conversa</span>
            </>
          ) : (
            <>
              <Archive className="size-3.5 shrink-0" />
              <span>Arquivar conversa</span>
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    </>
  );
}
