"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X, Phone, Clock } from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { useAuth } from "@/hooks/use-auth";
import { SmartAvatar } from "@/components/ui/smart-avatar";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("pt-BR", {
    month: "short",
    day: "numeric",
  });
}

// Tempo relativo curto ("agora", "há 5 min", "há 3 h", "há 2 dias"). Igual ao
// kanban antigo — dá noção de "quão fresco" está o card.
function tempoRelativo(iso?: string): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return null;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} ${d === 1 ? "dia" : "dias"}`;
}

// Formata telefone brasileiro (+55 (DD) NNNNN-NNNN). Sem casar o padrão,
// devolve o valor original — nunca esconde a informação.
function formatPhone(raw?: string): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  if (d.length === 13 && d.startsWith("55"))
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  if (d.length === 12 && d.startsWith("55"))
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 8)}-${d.slice(8)}`;
  if (d.length === 11)
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10)
    return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
}

function initial(name?: string, fallback?: string) {
  const source = (name || fallback || "?").trim();
  return source ? source.charAt(0).toUpperCase() : "?";
}

export function DealCard({ deal, stage, onEdit, isOverlay }: DealCardProps) {
  const { account } = useAuth();
  const color = stage?.color ?? "#94a3b8";
  const contactName =
    deal.contact?.name || deal.contact?.phone || "Sem contato";
  const phone = formatPhone(deal.contact?.phone);
  const assigneeLabel = deal.assignee?.full_name || null;
  // Título só vira linha própria quando acrescenta algo além do nome do contato.
  const showTitle =
    deal.title && deal.title.trim() && deal.title.trim() !== contactName.trim();
  // Origem do lead (do contato), resolvida na config de origens da conta.
  const origem = deal.contact?.origem
    ? account?.origens.find((o) => o.id === deal.contact?.origem) ?? null
    : null;
  const relative = tempoRelativo(deal.updated_at);

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      style={{ borderTopColor: color, borderTopWidth: 3 }}
      className={`group relative w-full cursor-pointer overflow-hidden rounded-2xl border border-border/50 bg-card/70 p-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-lg"
      }`}
    >
      {/* Cabeçalho: avatar + nome/telefone + status */}
      <div className="flex items-start gap-2.5">
        <SmartAvatar
          src={deal.contact?.avatar_url}
          alt={contactName}
          className="h-9 w-9 shrink-0 rounded-full object-cover"
          fallback={
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ background: color }}
            >
              {initial(deal.contact?.name, deal.contact?.phone)}
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className="truncate text-sm font-semibold leading-snug text-foreground">
              {contactName}
            </span>
            {deal.status === "won" && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
                <Check className="h-3 w-3" />
                Ganho
              </span>
            )}
            {deal.status === "lost" && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                <X className="h-3 w-3" />
                Perdido
              </span>
            )}
          </div>
          {phone && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              <Phone className="h-3 w-3 shrink-0" />
              <span className="truncate">{phone}</span>
            </div>
          )}
        </div>
      </div>

      {/* Título do negócio (quando diferente do nome do contato) */}
      {showTitle && (
        <p className="mt-2 line-clamp-2 text-xs text-foreground/80">
          {deal.title}
        </p>
      )}

      {/* Origem do lead */}
      {origem && (
        <div className="mt-2">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ backgroundColor: `${origem.color}22`, color: origem.color }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ backgroundColor: origem.color }}
            />
            {origem.label}
          </span>
        </div>
      )}

      {/* Rodapé: valor + data prevista / tempo relativo */}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        ) : (
          relative && (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              {relative}
            </span>
          )
        )}
      </div>

      {/* Responsável */}
      {assigneeLabel && (
        <div className="mt-2 flex items-center justify-end">
          <span
            title={assigneeLabel}
            className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
          >
            {initial(assigneeLabel)}
          </span>
        </div>
      )}
    </button>
  );
}
