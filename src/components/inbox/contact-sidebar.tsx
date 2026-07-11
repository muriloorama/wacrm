"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { Contact, Deal, Tag, PipelineStage } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  Briefcase,
  StickyNote,
  Plus,
  X,
  MapPin,
  Pencil,
  ChevronDown,
  Image as ImageIcon,
  Play,
  ImageOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { OrigemSelect } from "./origem-select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { SmartAvatar } from "@/components/ui/smart-avatar";

interface ContactSidebarProps {
  contact: Contact | null;
  // Propaga edições inline (ex.: nome) para o cabeçalho e a lista do pai.
  onContactUpdate?: (patch: Partial<Contact> & { id: string }) => void;
}

// Uma foto/vídeo trocado nas conversas do contato (para a seção "Mídias").
type MediaItem = {
  id: string;
  content_type: "image" | "video";
  media_url: string;
  created_at: string;
};

// Seção recolhível do painel: fechada por padrão, clique no cabeçalho abre.
function CollapsibleSection({
  icon: Icon,
  title,
  defaultOpen = false,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-1 py-1 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon className="h-3 w-3 shrink-0" />
        <span className="flex-1 text-left">{title}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

// Resolve a URL da mídia: URLs públicas usam direto; as proxied (autenticadas)
// viram blob via fetch. Espelha a lógica das bolhas de mensagem.
function useMediaSrc(url: string) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!url) return;
    if (!url.startsWith("/api/whatsapp/media/")) {
      setSrc(url);
      return;
    }
    let active = true;
    let blobUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to load media");
        const blob = await res.blob();
        blobUrl = URL.createObjectURL(blob);
        if (active) setSrc(blobUrl);
        else URL.revokeObjectURL(blobUrl);
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);
  return { src, error };
}

function MediaThumb({
  item,
  onOpen,
}: {
  item: MediaItem;
  onOpen: (item: MediaItem, src: string) => void;
}) {
  const { src, error } = useMediaSrc(item.media_url);
  if (error) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-md bg-muted">
        <ImageOff className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  if (!src) {
    return <div className="aspect-square animate-pulse rounded-md bg-muted" />;
  }
  return (
    <button
      type="button"
      onClick={() => onOpen(item, src)}
      className="relative aspect-square overflow-hidden rounded-md bg-muted transition-opacity hover:opacity-90"
    >
      {item.content_type === "video" ? (
        <>
          <video src={src} className="h-full w-full object-cover" />
          <span className="absolute inset-0 flex items-center justify-center bg-black/20">
            <Play className="h-5 w-5 text-white" fill="white" />
          </span>
        </>
      ) : (
        <img src={src} alt="" className="h-full w-full object-cover" />
      )}
    </button>
  );
}

// Grade de mídias + lightbox ao clicar. Fecha no ESC ou clicando no fundo.
function MediaGrid({ items }: { items: MediaItem[] }) {
  const [active, setActive] = useState<{ item: MediaItem; src: string } | null>(
    null,
  );
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  if (items.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground">Nenhuma mídia ainda</p>
    );
  }
  return (
    <>
      <div className="grid grid-cols-3 gap-1.5">
        {items.map((it) => (
          <MediaThumb
            key={it.id}
            item={it}
            onOpen={(item, src) => setActive({ item, src })}
          />
        ))}
      </div>
      {active && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4"
          onClick={() => setActive(null)}
          role="dialog"
          aria-label="Mídia ampliada"
        >
          <button
            type="button"
            onClick={() => setActive(null)}
            aria-label="Fechar"
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          {active.item.content_type === "video" ? (
            <video
              src={active.src}
              controls
              autoPlay
              onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full rounded-lg"
            />
          ) : (
            <img
              src={active.src}
              alt=""
              onClick={(e) => e.stopPropagation()}
              className="max-h-full max-w-full rounded-lg object-contain"
            />
          )}
        </div>
      )}
    </>
  );
}

export function ContactSidebar({
  contact,
  onContactUpdate,
}: ContactSidebarProps) {
  const { accountId, defaultCurrency } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  // Funil padrão da conta (alvo do botão "criar negócio" quando não há um).
  const [defaultPipelineId, setDefaultPipelineId] = useState<string | null>(
    null,
  );
  const [creatingDeal, setCreatingDeal] = useState(false);
  // Edição inline do valor de um negócio direto no painel.
  const [editingDealId, setEditingDealId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingValue, setSavingValue] = useState(false);
  // Etapas disponíveis por funil (para o seletor de estágio dos negócios).
  const [stagesByPipeline, setStagesByPipeline] = useState<
    Record<string, PipelineStage[]>
  >({});
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [savingTag, setSavingTag] = useState(false);
  // Nota ÚNICA editável do contato (não é mais um log de várias notas).
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  // Edição inline do nome do contato direto no cabeçalho do painel.
  const [editingName, setEditingName] = useState(false);
  const [nameText, setNameText] = useState("");
  const [savingName, setSavingName] = useState(false);
  // Fotos e vídeos trocados nas conversas do contato (seção "Mídias").
  const [media, setMedia] = useState<MediaItem[]>([]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, contact tags, and all account tags in parallel
    const [dealsRes, tagsRes, allTagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      supabase.from("tags").select("*").order("name"),
    ]);

    const dealRows = (dealsRes.data ?? []) as Deal[];
    if (dealsRes.data) setDeals(dealRows);
    if (allTagsRes.data) setAllTags(allTagsRes.data);

    // Funil padrão da conta (o primeiro) — alvo do "criar negócio".
    let defPipe: string | null = null;
    if (accountId) {
      const { data: pipes } = await supabase
        .from("pipelines")
        .select("id")
        .eq("account_id", accountId)
        .order("created_at", { ascending: true })
        .limit(1);
      defPipe = (pipes?.[0]?.id as string) ?? null;
    }
    setDefaultPipelineId(defPipe);

    // Etapas dos funis envolvidos (dos negócios + o funil padrão) — para o
    // seletor de estágio e para o novo negócio já ter suas etapas.
    const pipelineIds = [
      ...new Set(
        [...dealRows.map((d) => d.pipeline_id), defPipe].filter(
          (x): x is string => !!x,
        ),
      ),
    ];
    if (pipelineIds.length > 0) {
      const { data: stageRows } = await supabase
        .from("pipeline_stages")
        .select("*")
        .in("pipeline_id", pipelineIds)
        .order("position", { ascending: true });
      const byPipe: Record<string, PipelineStage[]> = {};
      for (const s of (stageRows ?? []) as PipelineStage[]) {
        (byPipe[s.pipeline_id] ??= []).push(s);
      }
      setStagesByPipeline(byPipe);
    } else {
      setStagesByPipeline({});
    }
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }

    // Mídias (fotos/vídeos) de TODAS as conversas deste contato, mais
    // recentes primeiro. Duas etapas para não depender de join/RLS aninhado.
    const { data: convs } = await supabase
      .from("conversations")
      .select("id")
      .eq("contact_id", contact.id);
    const convIds = (convs ?? []).map((c) => c.id as string);
    if (convIds.length > 0) {
      const { data: mediaRows } = await supabase
        .from("messages")
        .select("id, content_type, media_url, created_at")
        .in("conversation_id", convIds)
        .in("content_type", ["image", "video"])
        .not("media_url", "is", null)
        .order("created_at", { ascending: false })
        .limit(60);
      setMedia((mediaRows ?? []) as MediaItem[]);
    } else {
      setMedia([]);
    }
  }, [contact, accountId]);

  const handleAddTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      setSavingTag(true);

      const supabase = createClient();
      const { data, error } = await supabase
        .from("contact_tags")
        .insert({ contact_id: contact.id, tag_id: tag.id })
        .select("id")
        .single();

      if (error || !data) {
        toast.error("Falha ao adicionar etiqueta");
      } else {
        setTags((prev) => [...prev, { ...tag, contact_tag_id: data.id }]);
        toast.success("Etiqueta adicionada");
      }
      setSavingTag(false);
    },
    [contact],
  );

  const handleRemoveTag = useCallback(
    async (contactTagId: string) => {
      setSavingTag(true);

      const supabase = createClient();
      const { error } = await supabase
        .from("contact_tags")
        .delete()
        .eq("id", contactTagId);

      if (error) {
        toast.error("Falha ao remover etiqueta");
      } else {
        setTags((prev) =>
          prev.filter((t) => t.contact_tag_id !== contactTagId),
        );
        toast.success("Etiqueta removida");
      }
      setSavingTag(false);
    },
    [],
  );

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  // Ao trocar de contato, carrega a nota única dele no campo editável.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNoteText(contact?.notes ?? "");
  }, [contact?.id, contact?.notes]);

  // Salva a nota ÚNICA (grava em contacts.notes). Chamado no blur do campo.
  const saveNote = useCallback(async () => {
    if (!contact) return;
    const next = noteText.trim();
    if (next === (contact.notes ?? "").trim()) return; // nada mudou
    setSavingNote(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("contacts")
      .update({ notes: next || null })
      .eq("id", contact.id);
    setSavingNote(false);
    if (error) {
      toast.error("Falha ao salvar a nota");
      return;
    }
    // Reflete localmente para o dep de comparação não disparar de novo.
    contact.notes = next || null;
  }, [contact, noteText]);

  // Abre o editor inline do nome, pré-preenchendo com o nome atual.
  const startEditingName = useCallback(() => {
    if (!contact) return;
    setNameText(contact.name ?? "");
    setEditingName(true);
  }, [contact]);

  // Salva o nome (grava em contacts.name). Chamado no blur/Enter do campo.
  const saveName = useCallback(async () => {
    if (!contact) return;
    const next = nameText.trim();
    setEditingName(false);
    if (next === (contact.name ?? "").trim()) return; // nada mudou
    setSavingName(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("contacts")
      .update({ name: next || null })
      .eq("id", contact.id);
    setSavingName(false);
    if (error) {
      toast.error("Falha ao salvar o nome");
      return;
    }
    // Reflete localmente para o cabeçalho/avatar atualizarem sem refetch.
    contact.name = next || undefined;
    // Sobe a mudança para o pai (cabeçalho + lista de conversas).
    onContactUpdate?.({ id: contact.id, name: next || undefined });
    toast.success("Nome atualizado");
  }, [contact, nameText, onContactUpdate]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Selecione uma conversa</p>
      </div>
    );
  }

  const startEditValue = (deal: Deal) => {
    setEditingDealId(deal.id);
    setEditValue(deal.value != null ? String(deal.value) : "");
  };

  const saveDealValue = async (dealId: string) => {
    const parsed = parseFloat(editValue.replace(",", ".")) || 0;
    setSavingValue(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("deals")
      .update({ value: parsed })
      .eq("id", dealId);
    setSavingValue(false);
    if (error) {
      toast.error("Falha ao salvar o valor");
      return;
    }
    setDeals((prev) =>
      prev.map((d) => (d.id === dealId ? { ...d, value: parsed } : d)),
    );
    setEditingDealId(null);
  };

  // Move o negócio para outra etapa do kanban direto daqui (otimista).
  const changeStage = async (deal: Deal, newStageId: string) => {
    if (newStageId === deal.stage_id) return;
    const stages = stagesByPipeline[deal.pipeline_id] ?? [];
    const newStage = stages.find((s) => s.id === newStageId) ?? null;
    setDeals((prev) =>
      prev.map((d) =>
        d.id === deal.id
          ? { ...d, stage_id: newStageId, stage: newStage ?? d.stage }
          : d,
      ),
    );
    const supabase = createClient();
    const { error } = await supabase
      .from("deals")
      .update({ stage_id: newStageId })
      .eq("id", deal.id);
    if (error) {
      toast.error("Falha ao mover o negócio");
      // rollback
      setDeals((prev) =>
        prev.map((d) =>
          d.id === deal.id
            ? { ...d, stage_id: deal.stage_id, stage: deal.stage }
            : d,
        ),
      );
    }
  };

  // Cria um negócio já vinculado a este contato, no funil padrão da conta,
  // na primeira etapa. Aparece na hora na lista (com o seletor de etapa).
  const createDeal = async () => {
    if (!contact || !accountId || !defaultPipelineId) return;
    const stages = stagesByPipeline[defaultPipelineId] ?? [];
    const firstStage = stages[0];
    if (!firstStage) {
      toast.error("O funil não tem etapas configuradas");
      return;
    }
    setCreatingDeal(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const { data, error } = await supabase
      .from("deals")
      .insert({
        account_id: accountId,
        user_id: session?.user?.id,
        pipeline_id: defaultPipelineId,
        stage_id: firstStage.id,
        contact_id: contact.id,
        title: contact.name || contact.phone || "Novo negócio",
        value: 0,
        currency: defaultCurrency,
        status: "open",
      })
      .select("*, stage:pipeline_stages(*)")
      .single();
    setCreatingDeal(false);
    if (error || !data) {
      toast.error("Falha ao criar negócio");
      return;
    }
    setDeals((prev) => [data as Deal, ...prev]);
    toast.success("Negócio criado");
  };

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              <SmartAvatar
                src={contact.avatar_url}
                alt={displayName}
                fallback={initials}
                className="h-16 w-16 rounded-full object-cover"
              />
            </div>
            {editingName ? (
              <input
                type="text"
                autoFocus
                value={nameText}
                onChange={(e) => setNameText(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveName();
                  } else if (e.key === "Escape") {
                    setEditingName(false);
                  }
                }}
                placeholder="Nome do contato"
                className="mt-3 w-full rounded-md border border-input bg-background px-2 py-1 text-center text-sm font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            ) : (
              <button
                type="button"
                onClick={startEditingName}
                disabled={savingName}
                className="group mt-3 flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-muted disabled:opacity-60"
                title="Editar nome"
              >
                <h3 className="text-sm font-semibold text-foreground">
                  {savingName ? nameText.trim() || contact.phone : displayName}
                </h3>
                <Pencil className="h-3 w-3 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100" />
              </button>
            )}
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Origem — de onde veio o lead */}
          <CollapsibleSection icon={MapPin} title="Origem">
            <OrigemSelect contactId={contact.id} value={contact.origem} />
          </CollapsibleSection>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <CollapsibleSection icon={TagIcon} title="Etiquetas">
            <div className="flex flex-wrap items-center gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Nenhuma etiqueta</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                    <button
                      type="button"
                      onClick={() => handleRemoveTag(tag.contact_tag_id)}
                      disabled={savingTag}
                      aria-label={`Remover etiqueta ${tag.name}`}
                      className="rounded-full transition-opacity hover:opacity-70 disabled:opacity-50"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))
              )}
            </div>

            {(() => {
              const availableTags = allTags.filter(
                (t) => !tags.some((ct) => ct.id === t.id),
              );
              return (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        disabled={savingTag || availableTags.length === 0}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg px-1 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        <Plus className="h-3 w-3" />
                        Adicionar etiqueta
                      </button>
                    }
                  />
                  <DropdownMenuContent align="start" className="max-h-60">
                    {availableTags.map((tag) => (
                      <DropdownMenuItem
                        key={tag.id}
                        onClick={() => handleAddTag(tag)}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: tag.color }}
                        />
                        {tag.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })()}
          </CollapsibleSection>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <CollapsibleSection icon={Briefcase} title="Negócios ativos">
            {defaultPipelineId && deals.length > 0 && (
              <div className="mb-2 flex justify-end px-1">
                <button
                  type="button"
                  onClick={createDeal}
                  disabled={creatingDeal}
                  title="Adicionar negócio"
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Adicionar
                </button>
              </div>
            )}
            <div className="space-y-2">
              {deals.length === 0 ? (
                defaultPipelineId ? (
                  <button
                    type="button"
                    onClick={createDeal}
                    disabled={creatingDeal}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-3 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:bg-muted hover:text-foreground disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {creatingDeal ? "Criando…" : "Adicionar a um negócio"}
                  </button>
                ) : (
                  <p className="px-1 text-xs text-muted-foreground">
                    Nenhum negócio
                  </p>
                )
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      {editingDealId === deal.id ? (
                        <input
                          type="number"
                          autoFocus
                          value={editValue}
                          disabled={savingValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={() => saveDealValue(deal.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveDealValue(deal.id);
                            if (e.key === "Escape") setEditingDealId(null);
                          }}
                          className="h-6 w-24 rounded border border-border bg-background px-1.5 text-xs text-foreground outline-none focus:border-primary"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEditValue(deal)}
                          title="Clique para editar o valor"
                          className="rounded font-medium text-foreground hover:underline"
                        >
                          {formatCurrency(deal.value, deal.currency)}
                        </button>
                      )}
                      {(() => {
                        const stages =
                          stagesByPipeline[deal.pipeline_id] ?? [];
                        const cur =
                          stages.find((s) => s.id === deal.stage_id) ??
                          deal.stage ??
                          null;
                        // Sem etapas carregadas: mostra só o chip (fallback).
                        if (stages.length === 0) {
                          return cur ? (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]"
                              style={{
                                backgroundColor: `${cur.color}20`,
                                color: cur.color,
                              }}
                            >
                              {cur.name}
                            </span>
                          ) : null;
                        }
                        return (
                          <select
                            value={deal.stage_id}
                            onChange={(e) => changeStage(deal, e.target.value)}
                            title="Mover para outra etapa do funil"
                            className="shrink-0 cursor-pointer rounded-full border px-2 py-0.5 text-[10px] font-medium outline-none"
                            style={{
                              backgroundColor: `${cur?.color ?? "#94a3b8"}20`,
                              color: cur?.color ?? "var(--foreground)",
                              borderColor: `${cur?.color ?? "#94a3b8"}40`,
                            }}
                          >
                            {stages.map((s) => (
                              <option
                                key={s.id}
                                value={s.id}
                                style={{
                                  color: "var(--foreground)",
                                  background: "var(--popover)",
                                }}
                              >
                                {s.name}
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                    </div>
                  </div>
                ))
              )}
            </div>
          </CollapsibleSection>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Nota única do contato — editável, salva ao sair do campo. */}
          <CollapsibleSection icon={StickyNote} title="Nota">
            {savingNote && (
              <p className="mb-1 px-1 text-[10px] text-muted-foreground">
                salvando…
              </p>
            )}
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onBlur={saveNote}
              placeholder="Escreva uma nota sobre este contato..."
              rows={5}
              className="w-full resize-y rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
            <p className="mt-1 px-1 text-[10px] text-muted-foreground">
              Salva automaticamente ao clicar fora.
            </p>
          </CollapsibleSection>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Mídias — fotos e vídeos trocados nas conversas do contato. */}
          <CollapsibleSection icon={ImageIcon} title="Mídias">
            <MediaGrid items={media} />
          </CollapsibleSection>
        </div>
      </ScrollArea>
    </div>
  );
}
