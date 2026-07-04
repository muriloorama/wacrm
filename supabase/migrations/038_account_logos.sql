-- 038_account_logos
--
-- White-label: cada conta pode ter seu próprio logo (2 variantes — uma para
-- fundo claro, outra para fundo escuro). Quando vazio, a app usa o logo
-- padrão do Super CRM. URLs apontam para o storage (Backblaze B2), como os
-- avatares. Nullable — a maioria das contas herda o padrão.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS logo_light_url TEXT;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS logo_dark_url TEXT;
