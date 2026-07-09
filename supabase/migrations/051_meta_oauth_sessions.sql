-- ============================================================
-- 051 — Sessão intermediária do OAuth do Meta.
--
-- Quem conecta a página é o gestor de tráfego, e ele administra as
-- páginas de VÁRIOS clientes. O callback não pode mais gravar tudo o
-- que o Facebook devolve: precisa mostrar a lista e deixar escolher.
--
-- Entre o callback e a escolha existe um estado: o user token longo.
-- Fica aqui, cifrado, por 15 minutos, amarrado a quem iniciou o fluxo.
-- Nunca é devolvido ao navegador.
--
-- Sem RLS de leitura para ninguém: só o service-role (as rotas) toca
-- nesta tabela. A checagem de dono é feita em código, comparando
-- user_id e account_id com a sessão do chamador.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_oauth_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Cifrado com ENCRYPTION_KEY (AES-256-GCM).
  user_token  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes'
);

CREATE INDEX IF NOT EXISTS idx_meta_oauth_sessions_expires
  ON meta_oauth_sessions(expires_at);

ALTER TABLE meta_oauth_sessions ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy: RLS ligada sem policy = ninguém lê pelo cliente do
-- usuário. As rotas usam service-role e validam o dono em código.

COMMENT ON TABLE meta_oauth_sessions IS
  'Estado efêmero entre o callback do OAuth e a escolha das páginas. Expira em 15 min.';
