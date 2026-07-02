/**
 * Traduz mensagens de erro de autenticação do Supabase (GoTrue) para
 * PT-BR. O SDK devolve `error.message` sempre em inglês; mapeamos as
 * mensagens mais comuns por correspondência de trecho (case-insensitive)
 * e, para qualquer mensagem desconhecida, caímos num texto genérico em
 * português em vez de expor o inglês cru ao usuário.
 */

interface Rule {
  match: RegExp;
  message: string;
}

const RULES: Rule[] = [
  { match: /invalid login credentials/i, message: "E-mail ou senha inválidos." },
  { match: /email not confirmed/i, message: "E-mail ainda não confirmado. Verifique sua caixa de entrada." },
  { match: /user already registered|already been registered/i, message: "Este e-mail já está cadastrado." },
  { match: /password should be at least (\d+)/i, message: "A senha deve ter no mínimo 6 caracteres." },
  { match: /new password should be different/i, message: "A nova senha deve ser diferente da anterior." },
  { match: /unable to validate email address|invalid format/i, message: "Endereço de e-mail inválido." },
  { match: /signups? (are )?not allowed/i, message: "Cadastros não estão habilitados no momento." },
  { match: /email rate limit exceeded|only request this after|too many requests|rate limit/i, message: "Muitas tentativas. Aguarde alguns instantes e tente novamente." },
  { match: /user not found/i, message: "Usuário não encontrado." },
  { match: /token has expired|expired or is invalid|invalid.*token/i, message: "O link expirou ou é inválido. Solicite um novo." },
  { match: /network|fetch failed|failed to fetch/i, message: "Falha de conexão. Verifique sua internet e tente novamente." },
  { match: /email link is invalid/i, message: "O link de e-mail é inválido ou expirou." },
];

export function translateAuthError(message: string | null | undefined): string {
  if (!message) return "Não foi possível concluir a operação. Tente novamente.";
  for (const rule of RULES) {
    if (rule.match.test(message)) return rule.message;
  }
  // Mensagem desconhecida — evita expor inglês cru.
  return "Não foi possível concluir a operação. Tente novamente.";
}
