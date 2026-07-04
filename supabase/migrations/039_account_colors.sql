-- 039_account_colors
--
-- Cores de marca POR CONTA (não por dispositivo). Cada conta pode definir:
--   • accent_color  — cor de destaque (--primary) da app inteira
--   • bubble_color  — cor dos balões de mensagem enviados (agente)
-- Ambas em hex (#rrggbb) ou NULL (usa o padrão do tema). Aplicadas para
-- TODA a equipe da conta (branding compartilhado), diferente do modo
-- claro/escuro que continua por dispositivo.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS accent_color TEXT;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS bubble_color TEXT;
