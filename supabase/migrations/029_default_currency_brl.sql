-- 029_default_currency_brl
--
-- Torna BRL a moeda padrão (Super CRM é usado no Brasil). A migration
-- 021 criou a coluna `accounts.default_currency` com default 'USD'.
-- Aqui trocamos o default para 'BRL' e migramos as contas que ainda
-- estavam no default antigo 'USD'. Negócios já salvos mantêm sua
-- própria moeda (a coluna dos deals não é tocada).

ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'BRL';

UPDATE accounts
  SET default_currency = 'BRL'
  WHERE default_currency = 'USD';
