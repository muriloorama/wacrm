import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { deleteObject, isB2Configured } from "@/lib/storage/b2";

export const runtime = "nodejs";

/**
 * Remove um objeto do Backblaze B2. Só permite remover objetos sob a
 * pasta da própria conta do usuário (`account-<id>/`), evitando que um
 * chamador apague mídia de outra conta.
 */
export async function POST(request: Request) {
  if (!isB2Configured()) {
    return NextResponse.json(
      { error: "Armazenamento não configurado no servidor." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  }

  const { path } = (body ?? {}) as { path?: unknown };
  if (typeof path !== "string" || path.length === 0) {
    return NextResponse.json({ error: "Caminho inválido." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Você não está autenticado." }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.account_id) {
    return NextResponse.json(
      { error: "Não foi possível identificar sua conta." },
      { status: 403 },
    );
  }

  // Só pode remover dentro da própria conta.
  if (!path.includes(`account-${profile.account_id}/`)) {
    return NextResponse.json({ error: "Não autorizado." }, { status: 403 });
  }

  try {
    await deleteObject(path);
  } catch {
    // Best-effort: um objeto já ausente não é erro para o usuário.
  }

  return NextResponse.json({ ok: true });
}
