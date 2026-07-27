"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

/**
 * Faixa vermelha no topo de TODAS as telas quando um número de WhatsApp cai.
 *
 * Sem isso, o número caído só aparecia dentro de Configurações: o agente
 * seguia respondendo cliente o dia inteiro sem nada sair, e ninguém percebia
 * até alguém reclamar. Aqui é impossível não ver.
 *
 * Quem vê: qualquer pessoa da conta — o RLS de `whatsapp_channels` já mostra
 * a cada agente só as caixas dele, então cada um vê os números que o afetam.
 * O botão de reconectar é só de admin/owner, que é quem consegue ler o QR.
 *
 * A leitura é do `status` gravado no banco, que o cron `channel-health`
 * mantém de pé (a cada 10 min) além dos eventos do provedor. Este componente
 * relê a cada minuto para pegar a mudança sem depender de refresh da página.
 */

const RELOAD_MS = 60_000;

type CanalCaido = { id: string; name: string };

export function ChannelStatusBanner() {
  const { accountId, isOwner, isAdmin } = useAuth();
  const [caidos, setCaidos] = useState<CanalCaido[]>([]);

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    const ler = async () => {
      const { data } = await supabase
        .from("whatsapp_channels")
        .select("id, name")
        .eq("status", "disconnected")
        .order("name");
      if (cancelled) return;
      setCaidos(
        (data ?? []).map((c) => ({
          id: c.id as string,
          name: (c.name as string) ?? "Número sem nome",
        })),
      );
    };

    void ler();
    const timer = setInterval(ler, RELOAD_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [accountId]);

  if (caidos.length === 0) return null;

  const podeReconectar = isOwner || isAdmin;
  const um = caidos.length === 1;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-2 border-red-700 bg-red-600 px-4 py-3 text-white sm:px-6"
    >
      <AlertTriangle className="size-7 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold leading-tight sm:text-lg">
          {um
            ? `O número ${caidos[0].name} está DESCONECTADO`
            : `${caidos.length} números estão DESCONECTADOS`}
        </p>
        <p className="text-sm leading-tight text-red-50">
          {um
            ? "Nenhuma mensagem entra nem sai por ele até reconectar."
            : `Nenhuma mensagem entra nem sai por eles até reconectar: ${caidos
                .map((c) => c.name)
                .join(", ")}.`}
        </p>
      </div>
      {podeReconectar && (
        <Link
          href="/settings?tab=whatsapp"
          className="shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-red-700 transition-colors hover:bg-red-50"
        >
          Reconectar
        </Link>
      )}
    </div>
  );
}
