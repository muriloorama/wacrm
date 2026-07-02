-- 031_super_admin
--
-- Painel de Super Admin.
--
--   1. `profiles.is_super_admin` — quem enxerga o painel /admin e pode
--      chamar a API /api/admin/*. Fica FALSE para todo mundo; hoje só
--      muriloa@gmail.com recebe TRUE (abaixo).
--   2. `accounts.max_channels` / `accounts.max_users` — limites por
--      conta que o super admin edita no painel. Inteiros >= 0.
--
-- Contagens de "usados" (canais em whatsapp_config, membros em
-- profiles) NÃO viram coluna — são derivadas em tempo de leitura pela
-- API. Aqui só guardamos os limites.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS max_channels INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_users    INTEGER NOT NULL DEFAULT 5;

-- Limites nunca negativos. `NOT VALID` evita varrer linhas antigas na
-- aplicação; os defaults acima já satisfazem a checagem de qualquer
-- forma, então validamos em seguida.
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_max_channels_nonneg;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_max_channels_nonneg CHECK (max_channels >= 0);

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_max_users_nonneg;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_max_users_nonneg CHECK (max_users >= 0);

-- Semente do primeiro super admin. Idempotente: casa pelo e-mail do
-- perfil (001 preenche profiles.email a partir de auth.users no signup).
UPDATE profiles
  SET is_super_admin = TRUE
  WHERE lower(email) = 'muriloa@gmail.com';
