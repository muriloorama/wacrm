// Stub de `server-only` para o vitest. O pacote real lança erro fora de um
// React Server Component (é esse o propósito dele). Nos testes Node, os
// módulos que fazem `import "server-only"` precisam de um no-op.
export {};
