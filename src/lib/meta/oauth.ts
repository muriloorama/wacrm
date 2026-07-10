// ============================================================
// OAuth do Facebook para Lead Ads.
//
// Objetivo: o cliente clica "Conectar", autoriza, e o CRM grava sozinho
// `page_id` + page access token e assina o campo `leadgen` da página.
// Nada de INSERT manual por cliente.
//
// O que é do APP (uma vez, na Vercel): META_APP_ID, META_APP_SECRET,
// META_VERIFY_TOKEN. O que é do CLIENTE: a página e o token dela, que
// saem deste fluxo.
//
// Tokens: o code vira um user token curto (~1h); trocamos por um LONGO
// (~60 dias); os page tokens derivados de um user token longo **não
// expiram** enquanto o usuário não revogar. Por isso guardamos o page
// token, não o do usuário.
// ============================================================

import crypto from 'crypto';

export const GRAPH_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// `leads_retrieval` é o que permite ler o lead pelo leadgen_id.
// `pages_manage_metadata` é o que permite assinar o webhook da página.
export const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_metadata',
  'leads_retrieval',
].join(',');

export function appId(): string {
  const v = process.env.META_APP_ID;
  if (!v) throw new Error('META_APP_ID não configurado');
  return v;
}

export function appSecret(): string {
  const v = process.env.META_APP_SECRET;
  if (!v) throw new Error('META_APP_SECRET não configurado');
  return v;
}

export function redirectUri(request: Request): string {
  const base = (
    process.env.NEXT_PUBLIC_SITE_URL || new URL(request.url).origin
  ).replace(/\/+$/, '');
  return `${base}/api/meta/oauth/callback`;
}

// ------------------------------------------------------------
// `state`: carrega o accountId e prova que o fluxo saiu daqui.
// Sem assinatura, um atacante chamaria o callback com o accountId de
// outra conta e plantaria a própria página lá dentro.
// ------------------------------------------------------------
export function signState(accountId: string, userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ a: accountId, u: userId, t: Date.now() }),
  ).toString('base64url');
  const mac = crypto
    .createHmac('sha256', appSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${mac}`;
}

const STATE_TTL_MS = 15 * 60 * 1000;

export function verifyState(
  state: string | null,
): { accountId: string; userId: string } | null {
  if (!state?.includes('.')) return null;
  const [payload, mac] = state.split('.');

  const expected = crypto
    .createHmac('sha256', appSecret())
    .update(payload)
    .digest('base64url');

  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const { a: accountId, u: userId, t } = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { a: string; u: string; t: number };

    // Janela curta: o state é de uso imediato, não um token de sessão.
    if (!accountId || !userId || Date.now() - t > STATE_TTL_MS) return null;
    return { accountId, userId };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
export function buildAuthUrl(request: Request, state: string): string {
  const params = new URLSearchParams({
    client_id: appId(),
    redirect_uri: redirectUri(request),
    scope: OAUTH_SCOPES,
    response_type: 'code',
    state,
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`;
}

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${GRAPH}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Graph ${res.status} em ${path}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

/** code → user token curto. */
export async function exchangeCode(
  code: string,
  request: Request,
): Promise<string> {
  const data = await graph<{ access_token: string }>('/oauth/access_token', {
    client_id: appId(),
    client_secret: appSecret(),
    redirect_uri: redirectUri(request),
    code,
  });
  return data.access_token;
}

/** user token curto → user token longo (~60 dias). */
export async function toLongLivedToken(shortToken: string): Promise<string> {
  const data = await graph<{ access_token: string }>('/oauth/access_token', {
    grant_type: 'fb_exchange_token',
    client_id: appId(),
    client_secret: appSecret(),
    fb_exchange_token: shortToken,
  });
  return data.access_token;
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
}

/** Páginas que o usuário administra, já com o page token de cada uma. */
export async function listPages(userToken: string): Promise<MetaPage[]> {
  // O /me/accounts pagina (default ~25 por página). Sem seguir o cursor,
  // um gestor com muitas páginas não via as que caíam fora da 1ª página —
  // elas nem apareciam na tela de escolha nem podiam ser conectadas.
  const pages: MetaPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < 50; i++) {
    const params: Record<string, string> = {
      access_token: userToken,
      fields: 'id,name,access_token',
      limit: '100',
    };
    if (after) params.after = after;
    const data = await graph<{
      data?: MetaPage[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>('/me/accounts', params);
    if (data.data?.length) pages.push(...data.data);
    after = data.paging?.cursors?.after;
    if (!data.paging?.next || !after || !data.data?.length) break;
  }
  return pages;
}

/**
 * Assina o app no campo `leadgen` da página. Sem isto o Meta não entrega
 * webhook nenhum, por mais correta que a rota esteja.
 */
export async function subscribePageToLeadgen(
  pageId: string,
  pageToken: string,
): Promise<void> {
  const res = await fetch(`${GRAPH}/${pageId}/subscribed_apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscribed_fields: 'leadgen',
      access_token: pageToken,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Falha ao assinar leadgen em ${pageId}: ${text.slice(0, 200)}`);
  }
}
