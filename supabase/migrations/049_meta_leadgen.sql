-- ============================================================
-- 049 — Formulário instantâneo do Meta (Lead Ads).
--
-- O webhook do Meta não manda API key: ele identifica o destino pelo
-- `page_id` do payload. `meta_pages` faz page_id → conta e guarda o
-- token de página (cifrado, mesmo esquema dos tokens do uazapi).
--
-- `meta_lead_events` existe porque o Meta REENTREGA o mesmo evento
-- quando não recebe 200 rápido. Sem dedupe por leadgen_id, cada
-- retentativa criaria outro card.
-- ============================================================

CREATE TABLE IF NOT EXISTS meta_pages (
  page_id            TEXT PRIMARY KEY,
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_name          TEXT,
  -- Cifrado com ENCRYPTION_KEY (AES-256-GCM), como whatsapp_channels.
  page_access_token  TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         UUID
);

CREATE INDEX IF NOT EXISTS idx_meta_pages_account ON meta_pages(account_id);

CREATE TABLE IF NOT EXISTS meta_lead_events (
  leadgen_id   TEXT PRIMARY KEY,
  account_id   UUID REFERENCES accounts(id) ON DELETE CASCADE,
  page_id      TEXT,
  form_id      TEXT,
  contact_id   UUID,
  deal_id      UUID,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_lead_events_account
  ON meta_lead_events(account_id, received_at DESC);

-- Ambas são escritas só pelo webhook (service-role, que ignora RLS).
-- A leitura é de admin da conta, para diagnóstico.
ALTER TABLE meta_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_lead_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_pages_select ON meta_pages;
CREATE POLICY meta_pages_select ON meta_pages
  FOR SELECT USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS meta_lead_events_select ON meta_lead_events;
CREATE POLICY meta_lead_events_select ON meta_lead_events
  FOR SELECT USING (is_account_member(account_id, 'admin'));

COMMENT ON TABLE meta_pages IS
  'page_id do Facebook → conta. Token de página cifrado com ENCRYPTION_KEY.';
COMMENT ON TABLE meta_lead_events IS
  'Dedupe do webhook de Lead Ads: o Meta reentrega o mesmo leadgen_id.';
