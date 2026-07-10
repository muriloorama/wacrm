"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Mic, CheckCircle2 } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

/**
 * Painel de Transcrição de áudio — chave OpenAI DO CLIENTE (por conta).
 *
 * A chave é guardada cifrada em accounts.openai_api_key (via
 * /api/account/openai) e usada no servidor para transcrever os áudios
 * recebidos no inbox. Só admins editam; o valor nunca é devolvido — o
 * painel só sabe se está configurada ou não.
 */
export function OpenAiPanel() {
  const { canEditSettings } = useAuth();

  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/openai", { cache: "no-store" });
        const data = (await res.json()) as { configured?: boolean };
        if (!cancelled) setConfigured(Boolean(data?.configured));
      } catch {
        if (!cancelled) setConfigured(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: string | null) {
    setSaving(true);
    try {
      const res = await fetch("/api/account/openai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: next }),
      });
      const data = (await res.json()) as {
        configured?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data?.error ?? "Falha ao salvar");
        return;
      }
      setConfigured(Boolean(data?.configured));
      setApiKey("");
      toast.success(
        next ? "Chave OpenAI salva" : "Chave removida",
      );
    } catch {
      toast.error("Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SettingsPanelHead
        title="Transcrição de áudio"
        description="Transcreve automaticamente os áudios recebidos no inbox usando a OpenAI (Whisper). Informe a chave da OpenAI da sua conta — ela é usada só para transcrever e fica guardada de forma cifrada."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Chave da OpenAI
          </CardTitle>
          <CardDescription>
            {configured === null
              ? "Carregando…"
              : configured
                ? "Transcrição ativa. Novos áudios recebidos serão transcritos."
                : "Sem chave configurada — os áudios não são transcritos."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {configured ? (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Chave configurada.
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="openai-key">
              {configured ? "Substituir chave" : "Chave da OpenAI"}
            </Label>
            <Input
              id="openai-key"
              type="password"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={!canEditSettings || saving}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Crie em platform.openai.com → API keys. Começa com{" "}
              <code>sk-</code>.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => save(apiKey.trim())}
              disabled={!canEditSettings || saving || apiKey.trim().length < 20}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Salvar chave"
              )}
            </Button>
            {configured ? (
              <Button
                variant="outline"
                onClick={() => save(null)}
                disabled={!canEditSettings || saving}
              >
                Remover
              </Button>
            ) : null}
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
