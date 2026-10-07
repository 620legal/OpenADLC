import type { ModelAccount } from '@fleetadlc/shared';
import { query, queryOne } from '../client.js';

/**
 * A credential plus a provider, added once and referenced by many bots.
 *
 * The secret is not a column. A key lives in the secret store under
 * `model-account-<id>`, and so does the token a Claude subscription is given
 * by `claude setup-token`. An OpenAI or xAI subscription has no secret here at
 * all: its CLI keeps its own login, in a directory hostd holds for the account.
 */
export const MODEL_PROVIDERS = ['anthropic', 'openai', 'xai'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const ACCOUNT_KINDS = ['key', 'subscription'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export type { ModelAccount };

interface AccountRow {
  id: string;
  provider: ModelProvider;
  kind: AccountKind;
  label: string;
  created_at: Date;
  verified_at: Date | null;
  verify_error: string | null;
}

const COLUMNS = 'id, provider, kind, label, created_at, verified_at, verify_error';
const SELECT = `select ${COLUMNS} from model_accounts`;

function toAccount(row: AccountRow): ModelAccount {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    verifyError: row.verify_error ?? null,
  };
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function isAccountKind(value: string): value is AccountKind {
  return (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/** Names the bots in the refusal, in a stable order, and says what to do first. */
export function accountInUseMessage(bots: readonly string[]): string {
  const names = [...bots].filter((name) => name.trim().length > 0).sort();
  if (names.length === 0) return 'a bot still uses this account. Move it to another account under Crew first, then remove it.';
  const one = names.length === 1;
  return `${names.join(', ')} still ${one ? 'uses' : 'use'} this account. Move ${one ? 'it' : 'them'} to another account under Crew first, then remove it.`;
}

/**
 * Deleting an account a bot still points at would leave the assignment aimed
 * at nothing, and the task would start with no credential and no explanation.
 * The database also refuses (`on delete restrict`); this is the error that
 * says which bots.
 */
export class AccountInUse extends Error {
  readonly status = 409;
  readonly bots: string[];

  constructor(bots: readonly string[]) {
    super(accountInUseMessage(bots));
    this.name = 'AccountInUse';
    this.bots = [...bots];
  }
}

/** The longest failure message kept, which is what hostd sends at most. */
export const VERIFY_ERROR_MAX = 400;

export class ModelAccountNotFound extends Error {
  readonly status = 404;

  constructor(id: string) {
    super(`no model account ${id}`);
    this.name = 'ModelAccountNotFound';
  }
}

export async function list(): Promise<ModelAccount[]> {
  const rows = await query<AccountRow>(`${SELECT} order by created_at, label`);
  return rows.map(toAccount);
}

export async function get(id: string): Promise<ModelAccount | null> {
  const row = await queryOne<AccountRow>(`${SELECT} where id = $1`, [id]);
  return row ? toAccount(row) : null;
}

/**
 * The row only. The caller verifies a key and writes the secret store; this
 * function never sees a secret, so it cannot leak one into a row or a log.
 */
export async function create(input: {
  provider: ModelProvider;
  kind: AccountKind;
  label: string;
}): Promise<ModelAccount> {
  const label = input.label.trim();
  if (!isModelProvider(input.provider)) throw new Error(`provider must be one of ${MODEL_PROVIDERS.join(', ')}`);
  if (!isAccountKind(input.kind)) throw new Error(`kind must be one of ${ACCOUNT_KINDS.join(', ')}`);
  if (!label) throw new Error('an account needs a label');

  const row = await queryOne<AccountRow>(
    `insert into model_accounts (provider, kind, label) values ($1, $2, $3)
     returning ${COLUMNS}`,
    [input.provider, input.kind, label],
  );
  if (!row) throw new Error('failed to create model account');
  return toAccount(row);
}

/**
 * Records one check of the account's credential: when it ran, and what the
 * CLI said if it failed. A null error is a pass.
 *
 * The message arrives already scrubbed of the account's secret — hostd does
 * that before it answers — and it is bounded here as well, because this row is
 * listed to anyone who opens the accounts step.
 */
export async function recordVerification(
  id: string,
  check: { checkedAt: string; error: string | null },
): Promise<ModelAccount> {
  const error = check.error === null ? null : check.error.slice(0, VERIFY_ERROR_MAX);
  const row = await queryOne<AccountRow>(
    `update model_accounts set verified_at = $2, verify_error = $3 where id = $1 returning ${COLUMNS}`,
    [id, check.checkedAt, error],
  );
  if (!row) throw new ModelAccountNotFound(id);
  return toAccount(row);
}

/**
 * Forgets the last check, for when the credential it was about is replaced.
 * A tick earned by the old token says nothing about the new one.
 */
export async function clearVerification(id: string): Promise<void> {
  await query(`update model_accounts set verified_at = null, verify_error = null where id = $1`, [id]);
}

/** Bot names that still reference this account, sorted. */
export async function botsUsing(id: string): Promise<string[]> {
  const rows = await query<{ name: string }>(
    `select name from bots where model_account_id = $1 order by name`,
    [id],
  );
  return rows.map((row) => row.name);
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === '23503';
}

/**
 * Refuses while any bot still references the account, and names those bots.
 *
 * Checked before the delete so the message is ours, and again if a bot is
 * assigned in between: the foreign key is what actually holds, and a race
 * should still say which bots rather than surface a constraint name.
 */
export async function remove(id: string): Promise<void> {
  const using = await botsUsing(id);
  if (using.length > 0) throw new AccountInUse(using);

  try {
    const rows = await query<{ id: string }>(`delete from model_accounts where id = $1 returning id`, [id]);
    if (rows.length === 0) throw new ModelAccountNotFound(id);
  } catch (error) {
    if (error instanceof ModelAccountNotFound) throw error;
    if (!isForeignKeyViolation(error)) throw error;
    const raced = await botsUsing(id);
    throw new AccountInUse(raced);
  }
}
