"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Send, Loader2 } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { SettingsPanelHead } from "./settings-panel-head";

const DEFAULT_MSG =
  "Olá! Vi que conversamos por aqui e queria saber se você ainda tem interesse. Posso te ajudar em algo? 😊";

/**
 * Configuração do follow-up automático (por conta). Grava direto em
 * `accounts` — a RLS `accounts_update` (017) já restringe a admins+, então
 * não-admins veem os controles desabilitados. O agendamento em si é feito
 * pelo pg_cron do Supabase batendo em /api/cron/followups.
 */
export function FollowupPanel() {
  const supabase = createClient();
  const { accountId, canEditSettings } = useAuth();

  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [hours, setHours] = useState("24");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      if (!accountId) return;
      const { data } = await supabase
        .from("accounts")
        .select("followup_enabled, followup_message, followup_hours")
        .eq("id", accountId)
        .maybeSingle();
      if (cancel || !data) {
        if (!cancel) setLoading(false);
        return;
      }
      setEnabled(data.followup_enabled === true);
      setMessage((data.followup_message as string | null) ?? "");
      setHours(String(data.followup_hours ?? 24));
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [accountId, supabase]);

  async function handleSave() {
    if (!accountId) return;
    const h = Number(hours);
    if (!Number.isInteger(h) || h < 1 || h > 168) {
      toast.error("Horas deve ser um número entre 1 e 168.");
      return;
    }
    setSaving(true);
    const { error } = await supabase
      .from("accounts")
      .update({
        followup_enabled: enabled,
        followup_message: message.trim() || null,
        followup_hours: h,
      })
      .eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error("Falha ao salvar o follow-up");
      return;
    }
    toast.success("Follow-up atualizado");
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Follow-up automático"
        description="Cutuca sozinho quem recebeu um orçamento e ficou sem responder."
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <Send className="size-4 text-primary" />
            Como funciona
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            Em horário comercial (seg–sex, 9h–17h), um negócio parado em{" "}
            <strong>&quot;Orçamento Enviado&quot;</strong> cuja última mensagem
            foi sua e que ficou{" "}
            <strong>{hours || "24"}h sem resposta do cliente</strong> recebe a
            mensagem abaixo e vai para{" "}
            <strong>&quot;Follow-up Automático&quot;</strong>. Se o cliente
            responder, vai para <strong>&quot;Respondeu Follow-up&quot;</strong>;
            se continuar sem resposta, vai para{" "}
            <strong>&quot;Follow-up Manual&quot;</strong> para um toque humano.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Liga/desliga */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium text-foreground">
                Ativar follow-up automático
              </p>
              <p className="text-xs text-muted-foreground">
                Quando desligado, nenhuma mensagem automática é enviada.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEditSettings || loading}
            />
          </div>

          {/* Mensagem */}
          <div className="grid gap-2">
            <Label className="text-muted-foreground">Mensagem do follow-up</Label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={!canEditSettings || loading}
              rows={4}
              placeholder={DEFAULT_MSG}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-xs text-muted-foreground">
              Dica: no WhatsApp, <code>*texto*</code> vira{" "}
              <strong>negrito</strong>. Se deixar vazio, usamos uma mensagem
              padrão.
            </p>
          </div>

          {/* Horas */}
          <div className="grid gap-2 sm:max-w-[12rem]">
            <Label className="text-muted-foreground">
              Horas sem resposta antes de enviar
            </Label>
            <Input
              type="number"
              min={1}
              max={168}
              step={1}
              inputMode="numeric"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              disabled={!canEditSettings || loading}
              className="h-9"
            />
          </div>

          {!canEditSettings && (
            <p className="text-xs text-muted-foreground">
              Somente administradores da conta podem alterar o follow-up.
            </p>
          )}

          {canEditSettings && (
            <Button
              onClick={handleSave}
              disabled={saving || loading}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                "Salvar"
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
