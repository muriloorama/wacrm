"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Bot, AlertTriangle } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Painel do Atendimento IA (Fase 1). A IA responde o cliente sozinha no
 * WhatsApp e passa para um humano quando não sabe. Usa a MESMA chave OpenAI
 * da conta (configurada em "Transcrição de áudio"). Config não secreta fica
 * em accounts.ai_* (via /api/account/ai). Só admins editam.
 */

const MODELS: { value: string; label: string }[] = [
  { value: "gpt-4o-mini", label: "GPT-4o mini (rápido e barato — recomendado)" },
  { value: "gpt-4o", label: "GPT-4o (mais capaz, mais caro)" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
];

interface AiConfig {
  enabled: boolean;
  systemPrompt: string;
  model: string;
  hasOpenAiKey: boolean;
}

export function AiPanel({
  onGoToTranscription,
}: {
  onGoToTranscription?: () => void;
}) {
  const { canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/ai", { cache: "no-store" });
        const data = (await res.json()) as Partial<AiConfig>;
        if (cancelled) return;
        setEnabled(Boolean(data.enabled));
        setSystemPrompt(data.systemPrompt ?? "");
        setModel(data.model ?? "gpt-4o-mini");
        setHasOpenAiKey(Boolean(data.hasOpenAiKey));
      } catch {
        /* mantém defaults */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/account/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, systemPrompt, model }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data?.error ?? "Falha ao salvar");
        return;
      }
      toast.success("Atendimento IA salvo");
    } catch {
      toast.error("Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title="Atendimento IA"
        description="A IA responde os clientes automaticamente no WhatsApp e encaminha para um atendente humano quando não sabe responder ou o cliente pede. Usa a chave da OpenAI da sua conta."
      />

      {!loading && !hasOpenAiKey ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            É preciso configurar a chave da OpenAI para a IA funcionar.{" "}
            {onGoToTranscription ? (
              <button
                type="button"
                onClick={onGoToTranscription}
                className="font-medium underline underline-offset-2"
              >
                Configurar em Transcrição de áudio
              </button>
            ) : (
              "Configure em Configurações → Transcrição de áudio."
            )}
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Atendente virtual
          </CardTitle>
          <CardDescription>
            {loading
              ? "Carregando…"
              : enabled
                ? "Ativo. Novas mensagens de clientes serão respondidas pela IA (quando nenhum fluxo estiver cuidando da conversa)."
                : "Desligado. A IA não responde ninguém."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Liga/desliga */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                Ativar atendimento IA
              </p>
              <p className="text-xs text-muted-foreground">
                Quando um humano responde numa conversa, a IA é pausada
                automaticamente ali até ser reativada no inbox.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEditSettings || loading || saving}
            />
          </div>

          {/* Modelo */}
          <div className="grid gap-2">
            <Label htmlFor="ai-model">Modelo</Label>
            <select
              id="ai-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={!canEditSettings || loading || saving}
              className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Prompt de sistema */}
          <div className="grid gap-2">
            <Label htmlFor="ai-prompt">Instruções (prompt de sistema)</Label>
            <textarea
              id="ai-prompt"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              disabled={!canEditSettings || loading || saving}
              placeholder="Ex.: Você é o atendente virtual da Loja X. Fale de forma simpática e objetiva. Horário de atendimento: seg-sex 9h-18h. Não prometa descontos. Se perguntarem sobre o pedido, peça o número do pedido e transfira para um humano."
              rows={10}
              className="w-full resize-y rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50 disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">
              Descreva a persona, o que a IA pode dizer, horários e quando ela
              deve passar para um humano. Deixe em branco para usar um padrão
              genérico.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={save}
              disabled={!canEditSettings || loading || saving}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Salvar"
              )}
            </Button>
          </div>

          {!canEditSettings ? (
            <p className="text-xs text-muted-foreground">
              Apenas administradores podem alterar esta configuração.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
