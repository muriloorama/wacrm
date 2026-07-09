// ============================================================
// Webhook do formulário instantâneo do Meta (Lead Ads).
//
//   GET  — verificação. O Meta chama uma vez, ao assinar, e espera o
//          `hub.challenge` de volta em texto puro se o `hub.verify_token`
//          bater. Errar isso = o Facebook recusa salvar o webhook.
//   POST — evento de lead. O corpo NÃO traz nome nem telefone: traz um
//          `leadgen_id`. Os campos só saem de uma segunda chamada à
//          Graph API, autenticada com o token da página.
//
// Autenticação: não existe API key aqui. O Meta assina o corpo com
// HMAC-SHA256 usando o app secret (`X-Hub-Signature-256`). A assinatura
// é sobre os BYTES CRUS — por isso lemos `request.text()` e só depois
// fazemos o parse. Reserializar o JSON quebraria a comparação.
//
// Multi-tenant: a conta vem do `page_id` do payload, via `meta_pages`.
//
// Idempotência: o Meta reentrega o evento se não receber 200 rápido.
// `meta_lead_events` (PK = leadgen_id) impede card duplicado.
//
// Env: META_APP_SECRET, META_VERIFY_TOKEN.
// ============================================================

import crypto from 'crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { ingestLead } from '@/lib/api/v1/leads';

export const dynamic = 'force-dynamic';

const GRAPH_VERSION = 'v21.0';

// Nomes de campo que o Meta usa nos formulários instantâneos. `full_name`
// é o padrão; os demais aparecem em formulários customizados/traduzidos.
const PHONE_FIELDS = ['phone_number', 'telefone', 'whatsapp', 'celular'];
const NAME_FIELDS = ['full_name', 'nome', 'name', 'nome_completo'];
const EMAIL_FIELDS = ['email', 'e-mail'];

interface LeadgenValue {
  leadgen_id?: string;
  form_id?: string;
  page_id?: string;
}

// ------------------------------------------------------------
// GET — handshake de verificação.
// ------------------------------------------------------------
export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    console.error('[meta-leadgen] META_VERIFY_TOKEN não configurado');
    return new NextResponse('not configured', { status: 503 });
  }

  if (mode === 'subscribe' && token === expected && challenge) {
    // Texto puro, não JSON. O Meta compara byte a byte.
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new NextResponse('forbidden', { status: 403 });
}

// ------------------------------------------------------------
// POST — evento de lead.
// ------------------------------------------------------------
export async function POST(request: Request) {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    console.error('[meta-leadgen] META_APP_SECRET não configurado');
    return new NextResponse('not configured', { status: 503 });
  }

  // Bytes crus: a assinatura é calculada sobre eles.
  const raw = await request.text();

  if (!isSignatureValid(raw, request.headers.get('x-hub-signature-256'), appSecret)) {
    console.warn('[meta-leadgen] assinatura inválida');
    return new NextResponse('invalid signature', { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new NextResponse('bad json', { status: 400 });
  }

  // Falha inesperada (Graph fora do ar, banco indisponível) → 500 de
  // propósito, para o Meta reentregar. Perder um lead pago é pior que
  // uma retentativa, e o dedupe por `leadgen_id` torna a reentrega
  // inofensiva.
  //
  // Os casos PERMANENTES (página não mapeada, lead sem telefone, evento
  // que não é leadgen) não lançam: seguem com `continue` e devolvem 200,
  // porque reentregar não mudaria o resultado.
  try {
    await processLeadgen(body);
  } catch (err) {
    console.error('[meta-leadgen] erro ao processar:', err);
    return NextResponse.json({ error: 'retry' }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}

// ------------------------------------------------------------
// Assinatura. `timingSafeEqual` para não vazar por tempo de comparação.
// ------------------------------------------------------------
function isSignatureValid(
  raw: string,
  header: string | null,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;

  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(raw, 'utf8')
    .digest('hex');

  const received = header.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(received, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------
async function processLeadgen(body: unknown) {
  const entries =
    (body as { entry?: Array<{ changes?: Array<{ field?: string; value?: LeadgenValue }> }> })
      ?.entry ?? [];

  const db = supabaseAdmin();

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'leadgen') continue;

      const { leadgen_id: leadgenId, form_id: formId, page_id: pageId } =
        change.value ?? {};
      if (!leadgenId || !pageId) {
        console.warn('[meta-leadgen] evento sem leadgen_id/page_id');
        continue;
      }

      // Dedupe antes de qualquer trabalho: o Meta reentrega.
      // Ler `error` além de `data`: sem isso uma falha de banco (tabela
      // ausente, RLS) fica indistinguível de "nunca vi este lead", e o
      // webhook processa duas vezes ou mente sobre o motivo.
      const { data: seen, error: seenErr } = await db
        .from('meta_lead_events')
        .select('leadgen_id')
        .eq('leadgen_id', leadgenId)
        .maybeSingle();

      if (seenErr) {
        throw new Error(`dedupe falhou para ${leadgenId}: ${seenErr.message}`);
      }
      if (seen) {
        console.log('[meta-leadgen] leadgen_id já processado:', leadgenId);
        continue;
      }

      const { data: page, error: pageErr } = await db
        .from('meta_pages')
        .select('account_id, page_access_token')
        .eq('page_id', pageId)
        .maybeSingle();

      if (pageErr) {
        throw new Error(`lookup de page_id ${pageId} falhou: ${pageErr.message}`);
      }
      if (!page) {
        console.error('[meta-leadgen] page_id sem conta mapeada:', pageId);
        continue;
      }

      const fields = await fetchLeadFields(
        leadgenId,
        decrypt(page.page_access_token as string),
      );

      const phone = pick(fields, PHONE_FIELDS);
      if (!phone) {
        console.error('[meta-leadgen] lead sem telefone:', leadgenId, Object.keys(fields));
        continue;
      }

      const { contact, deal } = await ingestLead(
        db,
        page.account_id as string,
        {
          phone,
          name: pick(fields, NAME_FIELDS),
          email: pick(fields, EMAIL_FIELDS),
          notes: buildNote(fields),
        },
      );

      await db.from('meta_lead_events').insert({
        leadgen_id: leadgenId,
        account_id: page.account_id,
        page_id: pageId,
        form_id: formId ?? null,
        contact_id: contact?.id ?? null,
        deal_id: deal?.id ?? null,
      });

      console.log('[meta-leadgen] lead criado:', leadgenId, '→ deal', deal?.id);
    }
  }
}

// ------------------------------------------------------------
// O payload do webhook não traz os campos. Só o id.
// ------------------------------------------------------------
async function fetchLeadFields(
  leadgenId: string,
  pageAccessToken: string,
): Promise<Record<string, string>> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${leadgenId}?access_token=${encodeURIComponent(pageAccessToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Graph API ${res.status} ao buscar ${leadgenId}: ${(await res.text()).slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as {
    field_data?: Array<{ name?: string; values?: string[] }>;
  };

  const out: Record<string, string> = {};
  for (const f of data.field_data ?? []) {
    const value = f.values?.[0];
    if (f.name && typeof value === 'string' && value.trim()) {
      out[f.name.toLowerCase()] = value.trim();
    }
  }
  return out;
}

function pick(
  fields: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const k of keys) if (fields[k]) return fields[k];
  return undefined;
}

// Tudo que não virou coluna do contato entra na nota — as perguntas do
// formulário mudam e nada deve ser descartado.
function buildNote(fields: Record<string, string>): string | null {
  const known = new Set([...PHONE_FIELDS, ...NAME_FIELDS, ...EMAIL_FIELDS]);
  const lines = Object.entries(fields)
    .filter(([k]) => !known.has(k))
    .map(([k, v]) => `${k}: ${v}`);
  return lines.length > 0 ? lines.join('\n') : null;
}
