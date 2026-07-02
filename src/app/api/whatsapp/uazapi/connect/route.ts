import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";
import {
  isUazapiConfigured,
  createInstance,
  connectInstance,
  getInstanceStatus,
  setInstanceWebhook,
  deleteInstance,
} from "@/lib/whatsapp/uazapi-api";

export const runtime = "nodejs";

// ============================================================
// Canais de WhatsApp por QR Code (whatsapp_channels).
//
// Uma conta pode ter VÁRIOS canais nomeados (base para várias caixas
// de entrada). Cada canal é uma instância própria no provedor, com nome
// "channel-<id-da-linha>". Admin-only: as políticas RLS de
// whatsapp_channels só permitem INSERT/UPDATE/DELETE para admin — um
// erro de escrita é tratado como 403.
// ============================================================

type ChannelRow = {
  id: string;
  name: string | null;
  status: string | null;
  phone: string | null;
  uazapi_instance_id: string | null;
  uazapi_instance_token: string | null;
};

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", userId)
    .maybeSingle();
  return (data?.account_id as string) ?? null;
}

function webhookUrl(request: Request): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  ).replace(/\/+$/, "");
  return `${base}/api/whatsapp/webhook/uazapi`;
}

/**
 * POST — reconecta um canal existente (regenera QR) ou cria um canal novo.
 *   body: { name?: string, channelId?: string }
 *   - channelId presente → reconecta aquele canal.
 *   - senão → cria um novo canal (respeitando accounts.max_channels).
 */
export async function POST(request: Request) {
  if (!isUazapiConfigured()) {
    return NextResponse.json(
      { error: "Conexão por QR Code indisponível no servidor." },
      { status: 500 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Você não está autenticado." }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) {
    return NextResponse.json(
      { error: "Não foi possível identificar sua conta." },
      { status: 403 },
    );
  }

  let body: { name?: string; channelId?: string } = {};
  try {
    body = (await request.json()) as { name?: string; channelId?: string };
  } catch {
    // corpo vazio/ inválido → tratado como criação de canal sem nome.
  }

  try {
    // ---- Reconectar um canal existente (regenera QR) ----
    if (body.channelId) {
      const { data: channel } = await supabase
        .from("whatsapp_channels")
        .select("id, name, status, phone, uazapi_instance_id, uazapi_instance_token")
        .eq("id", body.channelId)
        .maybeSingle();

      if (!channel || !channel.uazapi_instance_token) {
        return NextResponse.json(
          { error: "Canal não encontrado." },
          { status: 404 },
        );
      }

      const token = decrypt(channel.uazapi_instance_token as string);
      try {
        await setInstanceWebhook(token, webhookUrl(request));
      } catch {
        // não bloqueia o QR se o registro do webhook falhar
      }
      const status = await connectInstance(token, { systemName: "Super CRM" });

      return NextResponse.json({
        channelId: channel.id,
        qrcode: status.instance?.qrcode ?? "",
        paircode: status.instance?.paircode ?? "",
        connected: status.status?.connected ?? false,
      });
    }

    // ---- Criar um canal novo ----
    // Valida o limite de canais da conta.
    const { count } = await supabase
      .from("whatsapp_channels")
      .select("id", { count: "exact", head: true })
      .eq("account_id", accountId);

    const { data: account } = await supabase
      .from("accounts")
      .select("max_channels")
      .eq("id", accountId)
      .maybeSingle();
    const maxChannels = (account?.max_channels as number | null) ?? 1;

    if ((count ?? 0) >= maxChannels) {
      return NextResponse.json(
        { error: "Limite de canais atingido." },
        { status: 403 },
      );
    }

    // Cria a linha primeiro (o id dela nomeia a instância no provedor).
    const { data: created, error: insertErr } = await supabase
      .from("whatsapp_channels")
      .insert({
        account_id: accountId,
        name: body.name || "Canal",
        provider: "uazapi",
        status: "disconnected",
        created_by: user.id,
      })
      .select("id")
      .single();

    if (insertErr || !created) {
      return NextResponse.json(
        { error: "Sem permissão para criar canais (apenas admin)." },
        { status: 403 },
      );
    }

    const channelId = created.id as string;

    // Provisiona a instância no provedor e grava id + token (encriptado).
    const { token, instance } = await createInstance(`channel-${channelId}`);
    const { error: updateErr } = await supabase
      .from("whatsapp_channels")
      .update({
        uazapi_instance_id: instance.id,
        uazapi_instance_token: encrypt(token),
      })
      .eq("id", channelId);

    if (updateErr) {
      // Não conseguimos persistir o token — desfaz a instância órfã.
      try {
        await deleteInstance(token);
      } catch {
        // best-effort
      }
      await supabase.from("whatsapp_channels").delete().eq("id", channelId);
      return NextResponse.json(
        { error: "Sem permissão para configurar canais (apenas admin)." },
        { status: 403 },
      );
    }

    try {
      await setInstanceWebhook(token, webhookUrl(request));
    } catch {
      // não bloqueia o QR se o registro do webhook falhar
    }
    const status = await connectInstance(token, { systemName: "Super CRM" });

    return NextResponse.json({
      channelId,
      qrcode: status.instance?.qrcode ?? "",
      paircode: status.instance?.paircode ?? "",
      connected: status.status?.connected ?? false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Falha ao conectar por QR Code.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/**
 * GET — lista os canais da conta. Para cada um, consulta o status atual no
 * provedor (best-effort) e sincroniza whatsapp_channels.status.
 */
export async function GET(request: Request) {
  void request;
  if (!isUazapiConfigured()) {
    return NextResponse.json({ configured: false, channels: [] }, { status: 200 });
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Você não está autenticado." }, { status: 401 });
  }
  const accountId = await resolveAccountId(supabase, user.id);
  if (!accountId) {
    return NextResponse.json({ error: "Conta não encontrada." }, { status: 403 });
  }

  const { data: rows } = await supabase
    .from("whatsapp_channels")
    .select("id, name, status, phone, uazapi_instance_id, uazapi_instance_token")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });

  const channels = await Promise.all(
    ((rows as ChannelRow[]) ?? []).map(async (row) => {
      let connected = row.status === "connected";
      let phone = row.phone;
      let qrcode: string | undefined;
      let paircode: string | undefined;

      if (row.uazapi_instance_token) {
        try {
          const status = await getInstanceStatus(
            decrypt(row.uazapi_instance_token),
          );
          connected = status.status?.connected ?? false;
          qrcode = status.instance?.qrcode || undefined;
          paircode = status.instance?.paircode || undefined;
          if (connected && status.status?.jid?.user) {
            phone = status.status.jid.user;
          }

          const nextStatus = connected ? "connected" : "disconnected";
          if (nextStatus !== row.status || (phone && phone !== row.phone)) {
            void supabase
              .from("whatsapp_channels")
              .update({
                status: nextStatus,
                ...(phone ? { phone } : {}),
                updated_at: new Date().toISOString(),
              })
              .eq("id", row.id);
          }
        } catch {
          // best-effort: mantém o último status conhecido do banco.
        }
      }

      return {
        id: row.id,
        name: row.name ?? "Canal",
        status: connected ? "connected" : "disconnected",
        connected,
        phone,
        qrcode,
        paircode,
      };
    }),
  );

  return NextResponse.json({ configured: true, channels });
}

/**
 * DELETE — remove um canal: apaga a instância no provedor (best-effort)
 * e a linha em whatsapp_channels. Admin-only (RLS).
 *   body: { channelId }
 */
export async function DELETE(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Você não está autenticado." }, { status: 401 });
  }

  let channelId: string | undefined;
  try {
    ({ channelId } = (await request.json()) as { channelId?: string });
  } catch {
    channelId = undefined;
  }
  if (!channelId) {
    return NextResponse.json({ error: "Canal não informado." }, { status: 400 });
  }

  const { data: channel } = await supabase
    .from("whatsapp_channels")
    .select("id, uazapi_instance_token")
    .eq("id", channelId)
    .maybeSingle();

  if (channel?.uazapi_instance_token) {
    try {
      await deleteInstance(decrypt(channel.uazapi_instance_token as string));
    } catch {
      // best-effort: segue removendo a linha mesmo se o provedor falhar.
    }
  }

  const { error: deleteErr } = await supabase
    .from("whatsapp_channels")
    .delete()
    .eq("id", channelId);

  if (deleteErr) {
    return NextResponse.json(
      { error: "Sem permissão para remover canais (apenas admin)." },
      { status: 403 },
    );
  }

  return NextResponse.json({ ok: true });
}
