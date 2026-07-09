// ============================================================
// GET /api/meta/oauth/start — manda o admin para o diálogo do Facebook.
//
// Admin+ apenas: conectar uma página é configuração de conta.
// O `state` assinado carrega o accountId até o callback.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { buildAuthUrl, signState } from '@/lib/meta/oauth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin');

    if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
      return NextResponse.json(
        { error: 'Integração com o Meta não configurada neste ambiente.' },
        { status: 503 },
      );
    }

    const state = signState(ctx.accountId, ctx.userId);
    return NextResponse.redirect(buildAuthUrl(request, state));
  } catch (err) {
    return toErrorResponse(err);
  }
}
