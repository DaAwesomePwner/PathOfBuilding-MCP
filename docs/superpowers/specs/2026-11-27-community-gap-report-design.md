# Community build comparison: samples and the gap report

Date: 2026-11-27. Goal slug: `community-gap-report`.

## Why and what

Theorycrafting against "what the community plays" instead of one guide. The
user collects a **sample** of community builds (PoB codes copied from
poe.ninja's "Path of Building" button, pobb.in / pastebin links, guides) and
the server reports what most of the sample has that the loaded build lacks,
measured with Path of Building's own numbers on the loaded build.

### Decisions taken with the user (binding)

- **poe.ninja is never contacted.** Its API page (poe.ninja/docs/api) says the
  builds / profiles, character and Path of Building endpoints are internal and
  "not available for third-party use", and that misbehaving clients are
  blocked. The server never fetches build data or PoB codes from poe.ninja;
  `load_build` keeps refusing poe.ninja links. Builds come only from what the
  user supplies (code, XML, pobb.in, pastebin: everything `load_build`
  accepts).
- **Named samples, saved on disk** in the server's config dir, so builds are
  added once and survive restarts.
- **One analysis: the gap report.** No separate usage-frequency, stat-spread or
  nearest-build tools. Shares (how much of the sample uses a thing) appear only
  as part of the gap report.
- **Gap scope:** gear, gems, passive tree, build settings.
- **Ranking by PoB gain** on the loaded build (one stat or a weighted objective,
  as `evaluate_changes`), among gaps at or above a minimum share (default 30%).

## Tools (4 new; 58 → 62)

### `add_sample_builds` (writes the sample store; never touches the loaded build)

Input: `sample` (name), `builds`: 1–20 × `{ source, label? }`. `source` is
anything `load_build` accepts (validated with `validateBuildSource`, resolved
with `resolveBuildSource`: downloads happen before any engine work). `label`
≤ 100 chars (e.g. "poe.ninja #3 RF Chieftain").

Creates the sample if missing. Each build is decoded, deduplicated (id = first
12 hex chars of sha256 of the decoded XML; a duplicate is reported, not
added), then all new builds are loaded one after another in **one temporary
engine** (`EngineManager.withTemporaryEngine`, exactly the `compare_builds`
rules: refused while the live breaker is open, install checks before spawn,
never respawned, its failures never strike the live engine) and read with the
bridge's `compareSnapshot` with `itemText: true`. A build PoB refuses to load
is listed under `failed` with its reason; the others are still added. A
temporary-engine crash or timeout fails the call and saves nothing from it.

Returns `{ sample, count, added: [{ id, label?, class, ascendancy, mainSkill, level }], duplicates: [{ id, label? }], failed: [{ index, label?, error }] }`.

Annotations: `readOnlyHint: false`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: true`.

### `list_samples` (read-only)

- No argument: every sample `{ name, count, updatedAt, ascendancies: top 3 with counts, mainSkills: top 3 with counts }`.
- `sample`: its builds `{ id, label?, class, ascendancy, mainSkill, level, addedAt, stale? }` (stale = snapshot from another PoB version; refreshed by the next gap report).
- `sample` + `build` (id): that build's summary plus its items by slot
  (`{ slot, name, base, rarity }`); with `slot` also that item's full text
  (the PoB "Copy item" text, for `swap_item` / `apply_changes`).

Annotations: read-only.

### `remove_sample_builds`

`sample` plus either `ids` (1–50) or `deleteSample: true` (removes the file).
Unknown ids are a `UserError` before any change. Annotations:
`destructiveHint: true`, `idempotentHint: true`.

### `community_gap_report` (read-only; runs on the probe engine)

Input:
- `sample` (required).
- `categories`: subset of `gear`, `gems`, `tree`, `settings` (default all).
- `minShare`: 0.05–1, default 0.3.
- `rankBy` (a stat key, default `CombinedDPS`) **or** `objective` (as
  `evaluate_changes`: validated with `validateObjectiveInput`, scored with
  `makeScorer`); not both.
- `filter`: `{ ascendancy?, mainSkill?, minLevel? }` (case-insensitive exact
  names) narrows the sample first; an empty result is a `UserError` naming the
  sample's ascendancies / main skills.
- `maxPerCategory`: 1–30, default 10.

Needs a loaded build (`UserError` naming `load_build` otherwise). Stale sample
snapshots (other PoB version or snapshot format) are refreshed first in one
temporary engine and saved; a failed refresh of one build drops that build
from this report with a note (never a silent skip), a temporary-engine failure
fails the call.

Output (compact JSON, lists capped with `more`):

```
{
  sample: { name, size, used, filter?, mainSkillMatched, ascendancies: [{name, share}], mainSkills: [{name, share}], levelMedian },
  rankBy | objective,
  base: { <rank stat(s)>, CombinedDPS, TotalEHP, Life, EnergyShield },
  gear:     [GapRow], tree: [GapRow], gems: [GapRow], settings: [GapRow],
  uncommon: { gear: [...], tree: [...], gems: [...] },   // yours, used by < 10% of the sample: { name, slot?, share }
  notes: [string]
}
GapRow = { kind, name, slot?, share, count, measured: boolean,
           delta?, pct?, perPoint? (tree), deltas?: {CombinedDPS, TotalEHP, Life},
           best?: { delta, from: {build, label?}, replaces? }, median? (gear),
           points? (tree), apply?: <apply_changes variant>, note? }
```

Every category list is ranked by the rank score (tree: by score per passive
point, like `find_best_next_nodes`, with the total also shown); unmeasured rows
(`measured: false`, `note` says why) come after the measured ones, by share.
A variant the probe refuses carries its error as `note` and is unmeasured.

#### Sample shares

`share` = builds of the (filtered) sample that have the thing / sample size.
Only the weapon set in use counts (`swap` and `inactive` items ignored).

- **gear** — per gear slot (Helmet, Body Armour, Gloves, Boots, Amulet, Ring
  1/2 (pooled as "Ring"), Belt, Weapon 1, Weapon 2): key = unique name for
  unique/relic items, else base type. **Flasks**: key by unique name or base,
  slot-agnostic. **Jewels** (tree and abyssal sockets): key by unique name,
  else base (cluster jewels: base + their "Added Small Passive Skills grant"
  line), slot-agnostic. A gap = a key at or above `minShare` that the loaded
  build does not have there.
- **gems** — *main skill supports*: only builds whose main skill (active gem of
  the main group) matches the loaded build's count (`mainSkillMatched`; none →
  a note, no support rows); key = support name. *Other skills*: active gem
  names anywhere outside the main group (auras, heralds, curses, guards,
  movement), key = gem name; gap = absent anywhere in the loaded build.
- **tree** — keystones and notables by name (id used for the what-if is the
  loaded build's tree node of that name; a name that resolves ambiguously is
  measured by the sample's id when the loaded tree has it, else unmeasured),
  masteries by mastery name + effect text, ascendancy notables only when the
  build's ascendancy equals the loaded build's (otherwise a note).
- **settings** — bandit, pantheon major / minor and every other config key:
  the most common value per key; a gap = a value used by ≥ `minShare` that
  differs from the loaded build's. `customMods` is never compared. Rows for
  enemy / condition / buff keys carry `assumption: true` (they change what PoB
  assumes, not the character).

#### What-ifs (all through `BuildSession.probe` / `probeNamed`; nothing applied)

- **gear slot**: up to 5 distinct sample copies (item text) of the key, each a
  variant `items: [{slot, itemText}]`; row `median` and `best` (with source
  build). A Weapon 1 candidate also sets Weapon 2 to that sample build's
  Weapon 2 (or unequips it) so two-handers and their off-hands stay coherent.
- **flask**: up to 3 copies × each of the loaded build's flask slots (an
  inactive slot is also turned on in the variant: `flasks`); best = the slot it
  replaces best.
- **jewel**: measured only in an allocated empty tree socket of the loaded
  build (first one, by id) or, for abyss jewels, an empty abyssal socket the
  loaded build's items have; otherwise unmeasured with a note.
- **support**: for each support in the loaded build's main group, a variant
  `gems: [{op: 'set', group, index, name, level, quality}]` (level / quality =
  the sample's most common for that support, level capped at 20 unless it is
  an awakened / exceptional gem's natural maximum, as `find_optimal_links`);
  plus `op: 'add'` when the group has fewer than 6 gems. `best.replaces` names
  the support it replaces.
- **other skill**: unmeasured (the probe cannot add a socket group); `note`
  says so and suggests `create_socket_group`.
- **tree**: `allocate: [id]` (path included) → `points`, `perPoint`;
  masteries `masteries: [{node, effect}]`.
- **settings**: `config: { key: value }`.

Each measured row with a small variant (tree, gems, settings) has `apply`, the
exact `apply_changes` variant; gear rows have `best.from` + `slot` and the item
text comes from `list_samples` (`sample`, `build`, `slot`), so replies stay
small. Variant budget per call: at most 400 probe variants and 40 fallback
variants; past that, remaining candidates are unmeasured with
`note: "not measured: budget"`.

## Sample store (`src/sample-store.ts`)

- Directory `<configDir()>/samples/` (honours `POB_MCP_CONFIG_DIR`; tests
  always set it). Never inside the PoB install.
- One file per sample: `<slug>.json`, slug = lower-case name, runs of
  characters outside `[a-z0-9]` → `-`, trimmed, ≤ 60 chars. Names: 1–60 chars
  of letters, digits, space and `-_.'()+`; another name with the same slug is a
  `UserError` naming the existing sample.
- File format v1:
  ```
  { version: 1, name, createdAt, updatedAt,
    builds: [{ id, label?, source: 'code'|'xml'|'pobb.in'|'pastebin', url?, code, addedAt,
               snapshot?: { pobVersion, format, data } }] }
  ```
  `code` = `encodeBuildCode(xml)` (the build works offline); `url` the
  canonical link when the source was one. `snapshot.data` is the
  `compareSnapshot` (with item text) reply; `format` = the snapshot format
  constant (bumped when the bridge output changes) — a snapshot whose
  `pobVersion` or `format` differs is stale.
- Caps: 50 builds per sample, 100 samples, 8 MB per file. A write that would
  pass a cap is a `UserError` before writing.
- Writes are atomic (write `<slug>.json.tmp-<pid>-<n>` in the same directory,
  then rename) and serialized by one in-process async mutex. A file that does
  not parse or fails the schema is a `UserError` naming its path; it is never
  overwritten or deleted except by `deleteSample`.

## Bridge change

`compareSnapshot` takes `itemText: true` and then adds each item's PoB
"Copy item" text (`text`, the same text `get_item_in_slot` returns) to its
`items` entries. Without the flag the reply is unchanged (compare_builds).

## Invariants this keeps

- The loaded build, its undo stack and crash journal are never changed by any
  of the four tools (the gap report is probe-only; samples use the temporary
  engine).
- Nothing is sent anywhere except the pobb.in / pastebin downloads
  `load_build` already makes; no poe.ninja request exists in the code.
- Tool arguments are untrusted: sample names become file names only through
  the slug rule (no path separators, no `..`), labels are clipped.
