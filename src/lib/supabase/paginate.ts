// Helpers para contornar o teto de 1000 linhas do PostgREST/Supabase.
//
// `select()` sem `.range()` devolve no MÁXIMO 1000 linhas, sem erro — o
// que fazia broadcasts, dashboards e dropdowns truncarem silenciosamente
// em contas grandes. Estes helpers paginam via `.range()` até esgotar.

type QueryResult<T> = { data: T[] | null; error: { message: string } | null };

const PAGE_SIZE = 1000;

/**
 * Executa a query em páginas de `.range()` até vir uma página incompleta.
 * `makeQuery` deve produzir uma NOVA query a cada chamada, já com o
 * `.range(from, to)` aplicado (o builder do Supabase não é reutilizável
 * depois de aguardado).
 *
 *   const rows = await fetchAllRange((from, to) =>
 *     supabase.from('contacts').select('*').eq('account_id', id).range(from, to),
 *   )
 */
export async function fetchAllRange<T>(
  makeQuery: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  pageSize = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

/**
 * Busca linhas cujo `column` está em `ids`, em lotes — evita tanto o teto
 * de 1000 quanto o limite de tamanho de URL de um `.in()` com milhares de
 * valores. `makeQuery` recebe um subconjunto dos ids por vez.
 */
export async function fetchByIdsChunked<T>(
  ids: string[],
  makeQuery: (chunk: string[]) => PromiseLike<QueryResult<T>>,
  chunkSize = 300,
): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await makeQuery(chunk);
    if (error) throw new Error(error.message);
    if (data) rows.push(...data);
  }
  return rows;
}
