-- 042_deals_currency_brl
-- Torna BRL o default de deals.currency (o produto é usado no Brasil; antes
-- era 'USD'). Negócios existentes em USD que não foram escolhidos
-- explicitamente ficam a critério de cada conta — aqui só mudamos o default.
ALTER TABLE deals ALTER COLUMN currency SET DEFAULT 'BRL';
