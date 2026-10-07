import { audit, bots, modelAccounts } from '@fleetadlc/db';
import { checkModelAssignment, ModelAssignmentError } from '@fleetadlc/engines';
import { resolveBotRef, type Bot, type BotRole } from '@fleetadlc/shared';
import { configuredFor } from './configured-crew.js';
import { HttpFailure, type Router } from './router.js';

/**
 * The console's write for which account a bot uses and which model it runs —
 * and so which engine it thinks with, because the account decides that: a bot
 * given an xAI account runs grok, one given an Anthropic account runs claude.
 *
 * The row is what the next task reads. hostd resolves an alias when that task
 * starts, so this does not restart anything and does not list models: a model
 * the account cannot call fails that task, naming what the account offers.
 * What can be known without listing is refused here, as a 400: a model the
 * account's provider does not serve, a family the engine does not have, and a
 * family on a subscription that cannot list.
 */
export interface AssignmentDeps {
  listBots: typeof bots.listBots;
  getAccount: typeof modelAccounts.get;
  setAssignment: typeof bots.setAssignment;
  recordAudit: typeof audit;
  /**
   * The engine and model `config/bots.yaml` gives a bot, or null when it
   * gives none. Asked by seat: the file is keyed by it, and a connected bot's
   * name is its handle, which the file has never heard of. A seat the file
   * does not name — one added from settings — has its role's first seat's.
   */
  configured: (bot: { slot: string; role: BotRole }) => { engine: string; model: string } | null;
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function defaultAssignmentDeps(configRoot?: string): AssignmentDeps {
  return {
    listBots: bots.listBots,
    getAccount: modelAccounts.get,
    setAssignment: bots.setAssignment,
    recordAudit: audit,
    configured: (bot) => {
      const entry = configuredFor(configRoot, bot);
      return entry ? { engine: entry.engine, model: entry.model } : null;
    },
  };
}

// A body is whatever was posted. A field of the wrong type is a 400 that
// names it, not a 500 from `.trim()` on a number.
function asModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ModelAssignmentError('model must be a string');
  return value;
}

function asAccountId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new ModelAssignmentError('modelAccountId must be an account id or null');
  const id = value.trim();
  if (!id) return null;
  if (!ACCOUNT_ID.test(id)) throw new ModelAssignmentError('modelAccountId must be an account id');
  return id;
}

export async function assignBotModel(
  input: { botName: string; model?: unknown; modelAccountId?: unknown; actor: string },
  deps: AssignmentDeps,
): Promise<{ bot: Bot }> {
  const name = input.botName.trim();
  // By name, then by seat: assigning a GitHub account renames a seat alone on
  // it to the account's handle, and the walkthrough saves each seat's model
  // right after, under the name it read before.
  const bot = resolveBotRef(await deps.listBots(), name, { persona: false });
  if (!bot) throw new HttpFailure(404, `no bot named ${name}`);

  const requestedModel = asModel(input.model);
  const requestedAccount = asAccountId(input.modelAccountId);
  if (requestedModel === undefined && requestedAccount === undefined) {
    throw new ModelAssignmentError('say which model, or which account');
  }

  const model = requestedModel ?? bot.model;
  const accountId = requestedAccount === undefined ? bot.modelAccountId : requestedAccount;
  // Read even when only the model changed: `newest:opus` on the subscription
  // a bot already has is as unresolvable as choosing both at once.
  const account = accountId ? await deps.getAccount(accountId) : null;
  if (accountId && !account) throw new HttpFailure(404, `no model account ${accountId}`);

  // No account puts a bot back on the engine the configuration gives it.
  // An account moves a bot to its provider's engine; without one, a moved bot
  // would keep that engine with nothing to call it with but its per-bot key —
  // stored for the engine it was configured with, so another provider's key.
  // A model sent with it has to be that engine's; none sent, the file's.
  const configured = account ? null : deps.configured({ slot: bot.slot, role: bot.role });
  const home = configured && configured.engine !== 'none' && configured.engine !== bot.engine ? configured : null;
  const chosen = home
    ? checkModelAssignment(home.engine as Bot['engine'], requestedModel ?? home.model, null)
    : checkModelAssignment(bot.engine, model, account);
  const updated = await deps.setAssignment(bot.id, chosen);

  await deps.recordAudit({
    actor: input.actor,
    action: 'bot.model_assigned',
    target: bot.name,
    // The choice, never a credential. An account id is a reference. When
    // the account moved the bot to another engine, the one it left is kept
    // too, so the trail says who moved it and from what.
    payload: {
      model: chosen.model,
      modelAccountId: chosen.modelAccountId,
      engine: chosen.engine,
      ...(chosen.engine !== bot.engine ? { previousEngine: bot.engine } : {}),
    },
  });

  return { bot: updated };
}

export function registerAssignmentRoutes(router: Router, deps: AssignmentDeps = defaultAssignmentDeps()): void {
  router.patch('/v1/bots/:name/assignment', async ({ params, body, identity }) => {
    const input = await body<unknown>();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new ModelAssignmentError('send an object with a model, an account, or both');
    }
    const fields = input as { model?: unknown; modelAccountId?: unknown };
    return assignBotModel(
      {
        botName: params.name ?? '',
        model: fields.model,
        modelAccountId: fields.modelAccountId,
        actor: identity,
      },
      deps,
    );
  });
}
