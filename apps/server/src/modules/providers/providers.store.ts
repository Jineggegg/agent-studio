import { type ProviderBalanceKind, type ProviderKind, type ProviderModel, providerModelSchema } from '@agent-studio/protocol';
import { type Database, type Migration, toSql } from '../../kernel/database.js';

export const PROVIDERS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'provider records',
    sql: `
      -- One model provider the owner configured. The API key is not here: it is in the
      -- encrypted secret store under "provider:<id>:api-key".
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        -- The wire protocol: 'openai-compatible'.
        kind TEXT NOT NULL,
        base_url TEXT NOT NULL,
        -- 1: loopback and private addresses (and plain http to them) may be contacted for this provider.
        allow_private_network INTEGER NOT NULL DEFAULT 0,
        -- 0: the server takes no key (a model server on the owner's machine).
        key_required INTEGER NOT NULL DEFAULT 1,
        -- How the account balance can be read: 'none' or 'deepseek'.
        balance_kind TEXT NOT NULL DEFAULT 'none',
        -- JSON array of catalogue entries: id, name, contextWindow, images, tools, prices, hidden.
        models TEXT NOT NULL DEFAULT '[]',
        default_model TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        -- The preset the record was created from, for information only.
        preset TEXT,
        -- No foreign key: the record outlives the account that created it.
        created_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

/** A provider as the server holds it. */
export interface ProviderRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  readonly allowPrivateNetwork: boolean;
  readonly keyRequired: boolean;
  readonly balance: ProviderBalanceKind;
  readonly models: readonly ProviderModel[];
  readonly defaultModel: string | null;
  readonly enabled: boolean;
  readonly preset: string | null;
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  allow_private_network: number;
  key_required: number;
  balance_kind: string;
  models: string;
  default_model: string | null;
  enabled: number;
  preset: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** A catalogue read back from storage: entries that no longer pass validation are dropped rather than trusted. */
function readModels(json: string): ProviderModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const model = providerModelSchema.safeParse(entry);
    if (!model.success || seen.has(model.data.id)) continue;
    seen.add(model.data.id);
    models.push(model.data);
  }
  return models;
}

function toRecord(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'openai-compatible' ? row.kind : 'openai-compatible',
    baseUrl: row.base_url,
    allowPrivateNetwork: row.allow_private_network === 1,
    keyRequired: row.key_required === 1,
    balance: row.balance_kind === 'deepseek' ? 'deepseek' : 'none',
    models: readModels(row.models),
    defaultModel: row.default_model,
    enabled: row.enabled === 1,
    preset: row.preset,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SpendTotals {
  readonly runs: number;
  readonly unpricedRuns: number;
  readonly totalUsd: number | null;
  readonly recentUsd: number | null;
  readonly since: number | null;
}

/** All SQL of the providers module. */
export class ProviderStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): ProviderRecord[] {
    return this.#db.all<ProviderRow>('SELECT * FROM providers ORDER BY created_at, rowid').map(toRecord);
  }

  find(id: string): ProviderRecord | null {
    const row = this.#db.get<ProviderRow>('SELECT * FROM providers WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  count(): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM providers')?.n ?? 0;
  }

  insert(record: ProviderRecord): void {
    this.#db.run(
      `INSERT INTO providers (id, name, kind, base_url, allow_private_network, key_required, balance_kind, models, default_model,
                              enabled, preset, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.name,
      record.kind,
      record.baseUrl,
      toSql(record.allowPrivateNetwork),
      toSql(record.keyRequired),
      record.balance,
      JSON.stringify(record.models),
      record.defaultModel,
      toSql(record.enabled),
      record.preset,
      record.createdBy,
      record.createdAt,
      record.updatedAt,
    );
  }

  update(record: ProviderRecord): void {
    this.#db.run(
      `UPDATE providers
          SET name = ?, base_url = ?, allow_private_network = ?, key_required = ?, balance_kind = ?, models = ?,
              default_model = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
      record.name,
      record.baseUrl,
      toSql(record.allowPrivateNetwork),
      toSql(record.keyRequired),
      record.balance,
      JSON.stringify(record.models),
      record.defaultModel,
      toSql(record.enabled),
      record.updatedAt,
      record.id,
    );
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM providers WHERE id = ?', id).changes > 0;
  }

  /**
   * What the agent runtime's usage records say was spent through one agent.
   * This only *reads* `agent_usage`, the table the runtime documents as the
   * one usage reports aggregate; nothing here writes to it.
   */
  spend(agentId: string, recentSince: number): SpendTotals {
    const row = this.#db.get<{ runs: number; unpriced: number; total: number | null; recent: number | null; since: number | null }>(
      `SELECT COUNT(DISTINCT run_id) AS runs,
              COUNT(DISTINCT CASE WHEN cost_usd IS NULL THEN run_id END) AS unpriced,
              SUM(cost_usd) AS total,
              SUM(CASE WHEN at >= ? THEN cost_usd END) AS recent,
              MIN(at) AS since
         FROM agent_usage WHERE agent_id = ?`,
      recentSince,
      agentId,
    );
    return {
      runs: row?.runs ?? 0,
      unpricedRuns: row?.unpriced ?? 0,
      totalUsd: row?.total ?? null,
      recentUsd: row?.recent ?? null,
      since: row?.since ?? null,
    };
  }
}
