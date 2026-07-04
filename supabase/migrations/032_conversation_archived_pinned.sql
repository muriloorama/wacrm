-- 032_conversation_archived_pinned
--
-- Duas colunas que faltavam em `conversations`:
--
-- 1) `archived` — o menu de contexto (botão direito) da lista já chamava
--    UPDATE conversations SET archived = ... , mas a coluna nunca foi criada
--    por migration, então o arquivar SEMPRE falhava (erro 42703/PGRST204,
--    engolido pelo try/catch e revertido na UI). Aqui a coluna passa a
--    existir de fato. Conversas arquivadas somem da lista principal, mesmo
--    ao receber mensagem nova — a filtragem já é feita no cliente.
--
-- 2) `pinned_at` — conversas fixadas (estilo WhatsApp): sobem para o topo
--    da lista. NULL = não fixada; o timestamp permite ordenar as fixadas
--    entre si por ordem de fixação, se desejado. Pin é POR CONTA (igual a
--    `archived`): a RLS de UPDATE em conversations já permite qualquer
--    membro 'agent+' da conta (migration 017), então não há política nova.
--
-- `conversations` já está publicada em supabase_realtime (migration 001),
-- então o UPDATE dessas colunas dispara evento realtime automaticamente.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

-- Índice parcial: a lista escopa por conta e só as fixadas precisam ser
-- levantadas ao topo. Mantém o índice pequeno (só linhas fixadas).
CREATE INDEX IF NOT EXISTS idx_conversations_pinned
  ON conversations(account_id)
  WHERE pinned_at IS NOT NULL;
