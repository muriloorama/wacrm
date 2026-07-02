import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";
import {
  isUazapiConfigured,
  createInstance,
  connectInstance,
  getInstanceStatus,
  setInstanceWebhook,
} from "@/lib/whatsapp/uazapi-api";

export const runtime = "nodejs";

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
 * Provisiona (se necessário) a instância uazapi da conta, registra o
 * webhook e inicia a conexão — retornando o QR code (base64) para o
 * cliente escanear. Admin-only via RLS (insert/update em whatsapp_config).
 */
export async function POST(request: Request) {
  if (!isUazapiConfigured()) {
    return NextResponse.json(
      { error: "Provedor uazapi não configurado no servidor." },
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

  const { data: cfg } = await supabase
    .from("whatsapp_config")
    .select("id, uazapi_instance_id, uazapi_instance_token")
    .eq("account_id", accountId)
    .maybeSingle();

  let instanceToken: string;
  try {
    if (cfg?.uazapi_instance_token) {
      instanceToken = decrypt(cfg.uazapi_instance_token as string);
    } else {
      const { token, instance } = await createInstance(`account-${accountId}`);
      instanceToken = token;
      const row = {
        account_id: accountId,
        user_id: user.id,
        provider: "uazapi",
        uazapi_instance_id: instance.id,
        uazapi_instance_token: encrypt(token),
        status: "disconnected",
      };
      const write = cfg?.id
        ? await supabase.from("whatsapp_config").update(row).eq("id", cfg.id)
        : await supabase.from("whatsapp_config").insert(row);
      if (write.error) {
        return NextResponse.json(
          { error: "Sem permissão para configurar o WhatsApp (apenas admin)." },
          { status: 403 },
        );
      }
    }

    // Registra o webhook (best-effort) e inicia a conexão.
    try {
      await setInstanceWebhook(instanceToken, webhookUrl(request));
    } catch {
      // não bloqueia o QR se o registro do webhook falhar
    }
    const status = await connectInstance(instanceToken, { systemName: "Super CRM" });

    return NextResponse.json({
      qrcode: status.instance?.qrcode ?? "",
      paircode: status.instance?.paircode ?? "",
      connected: status.status?.connected ?? false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Falha ao conectar ao uazapi.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

/** Status atual da instância uazapi da conta (conectado? QR atualizado?). */
export async function GET(request: Request) {
  if (!isUazapiConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 });
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

  const { data: cfg } = await supabase
    .from("whatsapp_config")
    .select("uazapi_instance_token")
    .eq("account_id", accountId)
    .maybeSingle();

  if (!cfg?.uazapi_instance_token) {
    return NextResponse.json({ configured: true, connected: false, hasInstance: false });
  }

  try {
    const status = await getInstanceStatus(decrypt(cfg.uazapi_instance_token as string));
    return NextResponse.json({
      configured: true,
      hasInstance: true,
      connected: status.status?.connected ?? false,
      instanceStatus: status.instance?.status ?? "unknown",
      qrcode: status.instance?.qrcode ?? "",
      paircode: status.instance?.paircode ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Falha ao consultar o uazapi.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
