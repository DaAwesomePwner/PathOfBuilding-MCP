// Committed build edits beyond items, config and the passive tree:
// apply_changes (keep an evaluate_changes variant as one undoable step), the
// socket group edits create_socket_group, delete_socket_group and
// set_main_skill, the build's fundamentals set_character_level and
// set_ascendancy, and set_flask_active. Each pushes one undo entry and records one command for
// crash replay (BuildSession).

import { z } from 'zod';
import type {
  ApplyChangesResult,
  AscendancyChangeResult,
  ClassChoice,
  FlaskActiveResult,
  LevelChangeResult,
  SkillEditResult,
  StatDiffResult,
  TreeEditNode,
} from './build-session.js';
import { type EvaluateChangesVariant, gemLevel, gemQuality, MAX_LABEL, MAX_VARIANT_GEMS, variantSchema } from './evaluate-changes.js';
import type { ToolRegistrar } from './tool-registry.js';

/** server.ts's swap_item result shape (`diff` by category, `keyDeltas`). */
type SummarizeStatDiff = (result: StatDiffResult) => unknown;

/** The slots a socket group can be socketed in (PoB's "Socketed in" list). */
const GROUP_SLOTS = [
  'Weapon 1', 'Weapon 2', 'Weapon 1 Swap', 'Weapon 2 Swap', 'Helmet', 'Body Armour', 'Gloves', 'Boots',
  'Amulet', 'Ring 1', 'Ring 2', 'Ring 3', 'Belt',
] as const;

const UNDO = 'Call undo_last_change to revert this change (one step).';

function node(n: TreeEditNode): Record<string, unknown> {
  return { id: n.id, name: n.name, type: n.type, ...(n.ascendancyName ? { ascendancyName: n.ascendancyName } : {}) };
}

function points(nodes: TreeEditNode[], cost: 'passive' | 'ascendancy'): number {
  return nodes.filter((n) => n.pointCost === cost).length;
}

function applyResponse(result: ApplyChangesResult, label: string | undefined, summarize: SummarizeStatDiff): unknown {
  const s = result.summary;
  if (result.unchanged) {
    return {
      status: 'unchanged',
      ...(label !== undefined ? { label } : {}),
      masteries: result.masteries ?? [],
      message: result.flasksUnchanged
        ? 'Every mastery already has that effect and every flask slot is already in that state; nothing was changed or pushed to undo.'
        : 'Every mastery already has that effect; nothing was changed or pushed to undo.',
    };
  }
  return {
    status: 'applied',
    ...(label !== undefined ? { label } : {}),
    ...(result.added.length > 0 ? { added: result.added.map(node) } : {}),
    ...(result.removed.length > 0 ? { removed: result.removed.map(node) } : {}),
    ...(result.masteries && result.masteries.length > 0 ? { masteries: result.masteries } : {}),
    ...(result.mainSkill !== undefined ? { mainSkill: result.mainSkill } : {}),
    ...(s
      ? {
          pointsUsed: points(result.added, 'passive'),
          pointsRefunded: points(result.removed, 'passive'),
          ascendancyPointsUsed: points(result.added, 'ascendancy'),
          ascendancyPointsRefunded: points(result.removed, 'ascendancy'),
          points: {
            used: s.totalPoints,
            max: s.maxNormalPoints,
            remaining: s.maxNormalPoints - s.totalPoints,
            ascendancyUsed: s.ascendancyPoints,
            ascendancyMax: s.maxAscendancyPoints,
          },
        }
      : {}),
    ...(summarize(result) as object),
    undo: UNDO,
  };
}

function classChoice(c: ClassChoice): Record<string, unknown> {
  return { className: c.className, ascendancy: c.ascendancy, secondaryAscendancy: c.secondaryAscendancy };
}

function levelResponse(result: LevelChangeResult, summarize: SummarizeStatDiff): unknown {
  const previous = { previousLevel: result.previous.level, ...(result.previous.autoMode ? { previousLevelMode: 'auto' } : {}) };
  if (result.unchanged) {
    return { status: 'unchanged', level: result.level, ...previous, message: 'The level is already this (manual mode); nothing was changed or pushed to undo.' };
  }
  return { status: 'set', level: result.level, ...previous, ...(summarize(result) as object), undo: UNDO };
}

function flaskResponse(result: FlaskActiveResult, summarize: SummarizeStatDiff): unknown {
  const fields = { slot: result.slot, active: result.active, item: result.item, ...(result.itemType ? { itemType: result.itemType } : {}) };
  if (result.unchanged) {
    return { status: 'unchanged', ...fields, message: `${result.slot} is already ${result.active ? 'active' : 'inactive'}; nothing was changed or pushed to undo.` };
  }
  return { status: result.active ? 'activated' : 'deactivated', ...fields, ...(summarize(result) as object), undo: UNDO };
}

function ascendancyResponse(result: AscendancyChangeResult, summarize: SummarizeStatDiff): unknown {
  if (result.unchanged) {
    return { status: 'unchanged', ...classChoice(result.to), message: 'The build already has that class and ascendancy; nothing was changed or pushed to undo.' };
  }
  const s = result.summary;
  return {
    status: 'changed',
    from: classChoice(result.from),
    to: classChoice(result.to),
    ...(result.removed.length > 0 ? { removed: result.removed.map(node) } : {}),
    pointsRefunded: points(result.removed, 'passive'),
    ascendancyPointsRefunded: points(result.removed, 'ascendancy'),
    points: {
      used: s.totalPoints,
      max: s.maxNormalPoints,
      remaining: s.maxNormalPoints - s.totalPoints,
      ascendancyUsed: s.ascendancyPoints,
      ascendancyMax: s.maxAscendancyPoints,
    },
    ...(summarize(result) as object),
    undo: UNDO,
  };
}

function skillEditResponse(status: string, fields: Record<string, unknown>, result: SkillEditResult, summarize: SummarizeStatDiff): unknown {
  return { status, ...fields, mainSkill: result.mainSkill, ...(summarize(result) as object), undo: UNDO };
}

export function registerBuildEditTools(tools: ToolRegistrar, summarize: SummarizeStatDiff): void {
  tools.engine<{ variant: EvaluateChangesVariant }>(
    'apply_changes',
    {
      description:
        'Apply one what-if variant to the build and keep it: exactly the variant format evaluate_changes takes (passive nodes to allocate / deallocate by name or id, `masteries` [{node, effect}], items to equip or unequip, flask slots to turn on or off (`flasks` [{slot, active}]), gem changes, config options, `mainSkill` {group, activeSkill?}; `label` is optional and echoed back), ' +
        'applied in the same order (config, gems, items, flasks, nodes and masteries, main skill) and as ONE undo step, so a winning evaluate_changes variant can be committed as-is with the stats evaluate_changes reported for it. PERMANENTLY mutates the build (undo_last_change reverts the whole variant; export_build includes it). ' +
        'The whole variant is checked first and refused with an error (nothing changes) if any node is unknown, ambiguous, already allocated, unreachable or a mastery listed in `allocate` (masteries go in `masteries`), a mastery effect is not offered by that mastery or already chosen on another one, an item does not fit its slot or cannot be parsed, an item would go in a flask slot left inactive or a `flasks` slot is empty or not a flask slot, a gem name or group / gem index is wrong (indices refer to the group as it is when that change applies), a gem change targets a group granted by an item or the passive tree, a config key is unknown, or the main skill group has no such active skill. ' +
        "Returns the nodes `added` (each allocation with its path, tree side first) and `removed`, the `masteries` given an effect, the `mainSkill` when set, the points used / refunded and the tree's point totals when nodes changed, and the before/after stat diff (as swap_item).",
      inputSchema: {
        variant: variantSchema.describe('One variant, as in evaluate_changes `variants`.'),
      },
    },
    async ({ variant }, session) => {
      const { label, ...rest } = variant;
      return applyResponse(await session.applyChanges(rest), label, summarize);
    },
  );

  tools.engine<{
    gems: Array<{ name: string; level?: number; quality?: number; enabled?: boolean }>;
    slot?: (typeof GROUP_SLOTS)[number];
    label?: string;
    enabled?: boolean;
    setAsMain?: boolean;
  }>(
    'create_socket_group',
    {
      description:
        'Add a new socket group (skill setup) to the build, after the existing groups, and return its index, its gems and the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert; export_build includes it). ' +
        'Gems are given by name (abbreviations as lookup_gem takes them), level defaults to 20 and quality to 0 (PoB caps a level the gem cannot have). `setAsMain: true` also makes it the main skill group. ' +
        'Refused without changing anything when a gem is unknown. Edit its gems afterwards with apply_changes (gem ops on the returned group index).',
      inputSchema: {
        gems: z
          .array(
            z.object({
              name: z.string().min(1),
              level: gemLevel.optional(),
              quality: gemQuality.optional(),
              enabled: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(MAX_VARIANT_GEMS)
          .describe('The gems, in order (active skill gems and supports).'),
        slot: z.enum(GROUP_SLOTS).optional().describe('Item slot the gems are socketed in (default none).'),
        label: z.string().max(MAX_LABEL).optional().describe('Group label (default none: PoB names it after its active skills).'),
        enabled: z.boolean().optional().describe('Whether the group is enabled (default true).'),
        setAsMain: z.boolean().optional().describe('Make it the main skill group (default false).'),
      },
    },
    async (args, session) => {
      const result = await session.createSocketGroup(args);
      const group = result.details.group as { index?: number; gems?: unknown } | undefined;
      return skillEditResponse('created', { group: result.details.index, gems: group?.gems ?? [] }, result, summarize);
    },
  );

  tools.engine<{ group: number }>(
    'delete_socket_group',
    {
      description:
        'Delete a socket group from the build and return the deleted group, the main skill group after the change and the before/after stat diff. PERMANENTLY mutates the build (use undo_last_change to revert). ' +
        'Every group after it moves up by one index (re-read indices with list_skill_groups before using them again). Deleting the main skill group makes the group that takes its place (the last group, if it was last) the main one. ' +
        'A group granted by an item or the passive tree is refused (remove the item or node instead), as is an index with no group.',
      inputSchema: {
        group: z.number().int().positive().describe('1-based socket group index from list_skill_groups.'),
      },
    },
    async ({ group }, session) => {
      const result = await session.deleteSocketGroup(group);
      return skillEditResponse('deleted', { deleted: result.details.deleted, mainGroup: result.details.mainSocketGroup }, result, summarize);
    },
  );

  tools.engine<{ group: number; activeSkill?: number }>(
    'set_main_skill',
    {
      description:
        "Make a socket group the build's main skill group (the skill get_stats and the DPS numbers describe) and, with `activeSkill`, pick which of its active skills is the main one when it has several (1-based, in the group's order). Returns the main group, the main skill and the before/after stat diff. " +
        'PERMANENTLY mutates the build (use undo_last_change to revert). A group with no enabled active skill gem, or an out-of-range index, is refused without changing anything.',
      inputSchema: {
        group: z.number().int().positive().describe('1-based socket group index from list_skill_groups.'),
        activeSkill: z.number().int().positive().optional().describe('1-based active skill within the group (default: keep its current choice).'),
      },
    },
    async ({ group, activeSkill }, session) => {
      const result = await session.setMainSkill(group, activeSkill);
      return skillEditResponse('set', { mainGroup: result.details.mainSocketGroup, activeSkill: result.details.activeSkill }, result, summarize);
    },
  );

  tools.engine<{ level: number }>(
    'set_character_level',
    {
      description:
        "Set the character level (1-100), as Path of Building's level box does, and return the before/after stat diff (life, mana, energy shield, accuracy, evasion and the enemy level used by the calculations follow the level). " +
        "The level is in manual mode afterwards (PoB's automatic level-from-passive-points mode is turned off, so the level stays put as passives change). PERMANENTLY mutates the build (use undo_last_change to revert; export_build includes it). " +
        'The same level already set manually is reported `unchanged` (nothing pushed to undo).',
      inputSchema: {
        level: z.number().int().min(1).max(100).describe('Character level, 1-100.'),
      },
    },
    async ({ level }, session) => levelResponse(await session.setCharacterLevel(level), summarize),
  );

  tools.engine<{ slot: string; active: boolean }>(
    'set_flask_active',
    {
      description:
        "Turn a flask slot (Flask 1-5) on or off, as the \"Activate this flask\" check box beside it in Path of Building's Items tab does, and return the before/after stat diff. " +
        'Path of Building applies a flask or tincture (its effect, and modifiers that need it in use) only while its slot is active; list_equipped_items / list_valid_slots show each flask slot\'s `active` state. ' +
        'PERMANENTLY mutates the build (use undo_last_change to revert; export_build includes it). A slot already in that state is reported `unchanged` (nothing pushed to undo). ' +
        'A slot that is not a flask slot, or an empty flask slot (PoB disables the box there), is refused without changing anything. ' +
        'This is not set_config\'s `flasks` alias (conditionUsingFlask), which only sets the "while using a flask" condition; to try it without committing, use evaluate_changes `flasks` [{slot, active}] or compare_items `activate: true`.',
      inputSchema: {
        slot: z.string().min(1).describe('"Flask 1" to "Flask 5".'),
        active: z.boolean().describe('true to turn the flask or tincture in the slot on, false to turn it off.'),
      },
    },
    async ({ slot, active }, session) => flaskResponse(await session.setFlaskActive(slot, active), summarize),
  );

  tools.engine<{ ascendancy?: string; secondaryAscendancy?: string; className?: string; allowTreeReset?: boolean }>(
    'set_ascendancy',
    {
      description:
        "Change the build's ascendancy, secondary ascendancy (bloodline, on 3.25+ trees) or class, as Path of Building's class / ascendancy dropdowns do, and return what changed, the passives removed, the point totals and the before/after stat diff. " +
        "Switching ascendancy removes the old ascendancy's passives (PoB keeps only passives that still connect to a start); `None` removes the ascendancy. PERMANENTLY mutates the build (undo_last_change restores the class, ascendancies and every removed passive; export_build includes it). " +
        "An ascendancy of another class needs `className` too. A class change keeps the allocated passives only when they connect to the new class's start (PoB changes class without asking then); otherwise it is refused unless `allowTreeReset: true` (PoB's Continue: every passive that no longer connects is removed). " +
        'Unknown names are refused without changing anything, with the choices listed (names ignore case).',
      inputSchema: {
        ascendancy: z.string().min(1).max(60).optional().describe('Ascendancy name, e.g. "Elementalist", or "None".'),
        secondaryAscendancy: z.string().min(1).max(60).optional().describe('Secondary ascendancy (bloodline), e.g. "Aul Bloodline", or "None".'),
        className: z.string().min(1).max(30).optional().describe('Class name, e.g. "Witch" (only to change class).'),
        allowTreeReset: z.boolean().optional().describe('Allow a class change that removes the passive tree (default false).'),
      },
    },
    async (args, session) => ascendancyResponse(await session.setAscendancy(args), summarize),
  );
}
