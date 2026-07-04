-- 040_contact_origem
--
-- Feature "Origem" (de onde veio o lead) — trazida do sistema antigo.
--   • accounts.origens  — lista configurável por conta: [{id,label,color}]
--   • contacts.origem   — id da origem escolhida para o contato (ou NULL)
--
-- Espelha o modelo antigo (user_settings.origens + leads.origem), agora
-- por conta. O seletor no contato mostra o rótulo + cor; a lista é editável
-- em Configurações.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS origens JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS origem TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_account_origem
  ON contacts(account_id, origem)
  WHERE origem IS NOT NULL;

-- Semeia a lista padrão de origens (BR) para contas que ainda não têm
-- nenhuma configurada. Idempotente: só preenche quando origens = '[]'.
UPDATE accounts
SET origens = '[
  {"id":"instagram","label":"Instagram","color":"#E1306C"},
  {"id":"google","label":"Google","color":"#4285F4"},
  {"id":"indicacao","label":"Indicação","color":"#10b981"},
  {"id":"passou_frente","label":"Passou em frente","color":"#f59e0b"},
  {"id":"ja_conhecia","label":"Já conhecia","color":"#8b5cf6"},
  {"id":"formulario","label":"Formulário","color":"#ec4899"},
  {"id":"outro","label":"Outro","color":"#64748b"}
]'::jsonb
WHERE origens = '[]'::jsonb OR origens IS NULL;
