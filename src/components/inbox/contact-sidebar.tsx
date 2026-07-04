"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatCurrency } from "@/lib/currency";
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
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
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

    // Etapas de cada funil envolvido nos negócios deste contato — para o
    // seletor que permite mover o negócio de estágio direto daqui.
    const pipelineIds = [
      ...new Set(dealRows.map((d) => d.pipeline_id).filter(Boolean)),
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
  }, [contact]);

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
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
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
          <div className="mb-4">
            <div className="mb-2 flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <MapPin className="h-3 w-3" />
              Origem
            </div>
            <OrigemSelect contactId={contact.id} value={contact.origem} />
          </div>

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Etiquetas
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
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
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Briefcase className="h-3 w-3" />
              Negócios ativos
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">Nenhum negócio</p>
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
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Nota única do contato — editável, salva ao sair do campo. */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <StickyNote className="h-3 w-3" />
                Nota
              </div>
              {savingNote && (
                <span className="text-[10px] text-muted-foreground">
                  salvando…
                </span>
              )}
            </div>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onBlur={saveNote}
              placeholder="Escreva uma nota sobre este contato..."
              rows={5}
              className="mt-2 w-full resize-y rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
            <p className="mt-1 px-1 text-[10px] text-muted-foreground">
              Salva automaticamente ao clicar fora.
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
