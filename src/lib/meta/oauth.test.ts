// O `state` é a única coisa que impede alguém de apontar o callback do
// OAuth para a conta de outro. Estes testes existem para que uma futura
// "simplificação" desse HMAC quebre a suíte, não a produção.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { signState, verifyState } from './oauth';

const ACCOUNT = '78ae639c-3218-48ed-9a24-f526058db184';
const USER = 'c09f5d10-7530-493b-ad6a-bf6dda927319';

beforeEach(() => {
  process.env.META_APP_SECRET = 'segredo-de-teste';
  vi.useRealTimers();
});

describe('state do OAuth do Meta', () => {
  it('ida e volta preserva conta e usuário', () => {
    const parsed = verifyState(signState(ACCOUNT, USER));
    expect(parsed).toEqual({ accountId: ACCOUNT, userId: USER });
  });

  it('rejeita payload adulterado (troca de conta)', () => {
    const state = signState(ACCOUNT, USER);
    const [, mac] = state.split('.');

    // Um atacante reescreve o payload para a própria conta e reusa o MAC.
    const forjado = Buffer.from(
      JSON.stringify({ a: 'conta-do-atacante', u: USER, t: Date.now() }),
    ).toString('base64url');

    expect(verifyState(`${forjado}.${mac}`)).toBeNull();
  });

  it('rejeita MAC de outro segredo', () => {
    const state = signState(ACCOUNT, USER);
    process.env.META_APP_SECRET = 'outro-segredo';
    expect(verifyState(state)).toBeNull();
  });

  it('rejeita state expirado (> 15 min)', () => {
    vi.useFakeTimers();
    const state = signState(ACCOUNT, USER);
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(verifyState(state)).toBeNull();
  });

  it('aceita state dentro da janela', () => {
    vi.useFakeTimers();
    const state = signState(ACCOUNT, USER);
    vi.advanceTimersByTime(14 * 60 * 1000);
    expect(verifyState(state)?.accountId).toBe(ACCOUNT);
  });

  it('rejeita entradas malformadas sem lançar', () => {
    for (const bad of [null, '', 'sem-ponto', 'a.b', '.', 'a.']) {
      expect(verifyState(bad)).toBeNull();
    }
  });
});
