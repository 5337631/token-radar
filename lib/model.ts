// Token Radar model: one sealed snapshot in, one ranked board out.
//
// The idea, in one paragraph. A protocol that records no token yet is worth,
// as a first estimate, what the market already pays for comparable protocols
// that do trade. So the model first learns a price for locked value from the
// snapshot itself: for every category it takes the live-token protocols in
// that category and computes their median market-cap / TVL ratio, shrunk
// toward the global median when a category has few traded peers. A pre-token
// protocol's implied value is then its own TVL times its category's ratio,
// adjusted by three factors that also come only from its own record: a
// momentum factor from its seven-day TVL change, a seasoning factor from how
// long it has run with no token recorded, and a small reach factor for
// operating on more than one chain. No name is ever special-cased, so the
// same code scores a snapshot taken next year, with protocols that do not
// exist yet, exactly the same way.
//
// The board covers the snapshot's whole watchlist (the floor, never the
// ceiling) and then the strongest remaining pre-token protocols by implied
// value, up to BOARD_ROWS. Protocols whose token already trades are never
// ranked: they are carried separately, at the market's own values, as the
// comparison set the category ratios were learned from.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's tunable constants, stated in the dashboard so a reader can audit them. */
export interface ModelConstants {
  /** Momentum: implied value moves this fraction of the clamped 7-day TVL change. */
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  /** Seasoning: a protocol that just appeared starts here... */
  seasoning_floor: number;
  /** ...and gains up to this much more over `seasoning_days` with no token recorded. */
  seasoning_range: number;
  seasoning_days: number;
  unknown_age_days: number;
  /** Reach: each extra chain beyond the first adds this, up to `reach_max_chains`. */
  reach_per_chain: number;
  reach_max_chains: number;
  /** Category ratios are clamped into this band so thin categories cannot explode. */
  comp_floor: number;
  comp_cap: number;
  /** Shrinkage: a category ratio counts as this many phantom global-median peers. */
  comp_prior_peers: number;
}

export const MODEL: ModelConstants = {
  momentum_weight: 0.9,
  momentum_floor: -50,
  momentum_cap: 100,
  seasoning_floor: 0.75,
  seasoning_range: 0.35,
  seasoning_days: 1095,
  unknown_age_days: 365,
  reach_per_chain: 0.02,
  reach_max_chains: 10,
  comp_floor: 0.02,
  comp_cap: 1.2,
  comp_prior_peers: 3,
};

export const MODEL_VERSION = 'radar-2';

/** The board's size: the watchlist plus the strongest early finds, capped here. */
export const BOARD_ROWS = 300;

/** How many live-token protocols the comparison view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_comp: number;
    comp_peers: number;
    momentum_pct: number;
    momentum_multiplier: number;
    seasoning_multiplier: number;
    reach_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: the row plus its farm plan and tags. */
export interface RadarRow extends BoardRow {
  tags: string[];
}

/** A live-token protocol: it already trades, so it is shown at the market's value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** One category's learned ratio, for the dashboard's model panel. */
export interface CategoryComp {
  category: string;
  peers: number;
  comp: number;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  scanned_size: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  total_implied_usd: number;
  global_comp: number;
  category_comps: CategoryComp[];
  categories: string[];
  chains: string[];
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a pre-token protocol may be ranked as an early find (the watchlist bypasses this filter). */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category ratios learned from the snapshot's live-token protocols.
 * Each category's median market-cap / TVL is shrunk toward the global median
 * by `comp_prior_peers` phantom peers, then clamped. Returns the per-category
 * map, the global ratio, and a display list sorted by peer count.
 */
export function learnComps(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { comps: Map<string, { comp: number; peers: number }>; globalComp: number; list: CategoryComp[] } {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.tvl_usd > 0);
  const globalComp = live.length > 0 ? median(live.map((p) => p.mcap_usd! / p.tvl_usd)) : 0.17;
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorised';
    const arr = byCategory.get(key) ?? [];
    arr.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, arr);
  }
  const comps = new Map<string, { comp: number; peers: number }>();
  const list: CategoryComp[] = [];
  for (const [category, ratios] of byCategory) {
    const shrunk = (ratios.length * median(ratios) + model.comp_prior_peers * globalComp) / (ratios.length + model.comp_prior_peers);
    const comp = Math.min(model.comp_cap, Math.max(model.comp_floor, shrunk));
    comps.set(category, { comp, peers: ratios.length });
    list.push({ category, peers: ratios.length, comp: round4(comp) });
  }
  list.sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  return { comps, globalComp, list };
}

/** The factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  comp: number,
  model: ModelConstants = MODEL,
): { implied: number; momentumPct: number; momentumMult: number; seasoningMult: number; reachMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawChange = typeof protocol.change_7d === 'number' && Number.isFinite(protocol.change_7d) ? protocol.change_7d : 0;
  const momentumPct = Math.min(model.momentum_cap, Math.max(model.momentum_floor, rawChange));
  const momentumMult = 1 + (momentumPct / 100) * model.momentum_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const seasoningMult =
    model.seasoning_floor + (Math.min(Math.max(ageForModel, 0), model.seasoning_days) / model.seasoning_days) * model.seasoning_range;
  const reachMult = 1 + model.reach_per_chain * Math.min(Math.max(protocol.chains.length - 1, 0), model.reach_max_chains);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * comp * momentumMult * seasoningMult * reachMult));
  return { implied, momentumPct, momentumMult, seasoningMult, reachMult, age };
}

/** A tiny deterministic hash of a slug, used only to vary farm-plan wording between protocols. */
function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return h;
}

/** Starting capital for one farm position, scaled to the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long a position should be held: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  if (age < 730) return 30;
  return 21;
}

/** The wallet a farmer needs for a chain, from the chain's own name. */
function walletFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c.includes('solana')) return 'a Solana wallet such as Phantom';
  if (c.includes('bitcoin') || c === 'b squared' || c.includes('bsquared')) return 'a Bitcoin wallet such as Xverse';
  if (c.includes('sui')) return 'a Sui wallet such as Slush';
  if (c.includes('aptos')) return 'an Aptos wallet such as Petra';
  if (c.includes('stellar')) return 'a Stellar wallet such as Freighter';
  if (c.includes('algorand')) return 'an Algorand wallet such as Pera';
  if (c.includes('tron')) return 'a Tron wallet such as TronLink';
  if (c.includes('ripple') || c.includes('xrpl')) return 'an XRP Ledger wallet such as Xaman';
  return 'an EVM wallet such as Rabby or MetaMask';
}

/** The core farming action for a category, written so a reader can follow it on the protocol's own app. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('curator'))
    return `Deposit $${capital} of USDC into a ${n} curated vault on ${chain}; pick the vault whose strategy you understand and keep the vault shares in the wallet.`;
  if (c.includes('lend')) return `Supply $${capital} of USDC to ${n} on ${chain}, then borrow about 30% against it and re-supply the borrowed amount once to build a real lending history.`;
  if (c.includes('cdp') || c.includes('stablecoin')) return `Deposit $${capital} of collateral into ${n} on ${chain} and mint a modest amount of its stablecoin, keeping the collateral ratio comfortably above liquidation.`;
  if (c.includes('dex')) return `Swap about $${Math.max(20, Math.round(capital / 4))} on ${n} and add $${capital} of two-sided liquidity to its busiest pool on ${chain}; keep the LP position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then make one swap or deposit on the far side so the trip is real usage, not a pass-through.`;
  if (c.includes('liquid staking') || c.includes('restak') || c.includes('staking'))
    return `Stake $${capital} of the chain's native asset through ${n} on ${chain} and hold the liquid receipt token; do not sell the receipt for at least one full week.`;
  if (c.includes('derivative') || c.includes('perpetual')) return `Deposit $${capital} of USDC margin on ${n} and trade one small hedged position a week; volume with a flat book counts, leverage does not help.`;
  if (c.includes('rwa')) return `Mint or buy $${capital} of ${n}'s yield-bearing asset on ${chain} through its own app and hold it; RWA positions usually qualify by holding, not by trading.`;
  if (c.includes('yield')) return `Deposit $${capital} of USDC into ${n}'s main yield vault on ${chain} and leave the shares untouched so weekly snapshots keep seeing the position.`;
  if (c.includes('basis')) return `Fund $${capital} on ${n} and open its standard basis position on ${chain}; check the funding rate weekly and close only if it stays negative for seven days.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover or underwrite in ${n}'s main pool on ${chain} and keep the policy or stake active for the full term shown in the app.`;
  if (c.includes('chain')) return `Bridge $${capital} of USDC to ${chain}, then use two native apps there (one swap, one deposit) so the wallet reads as a real ${n} ecosystem user.`;
  if (c.includes('payment')) return `Fund $${capital} through ${n} and make two real transfers a week; payment networks reward consistent transacting wallets over one large deposit.`;
  return `Deposit $${capital} of USDC into ${n}'s main product on ${chain} and keep the position open; use the product's primary action, not a side feature.`;
}

/** The recurring weekly action for a category: the behaviour its scoring is most likely to count. */
function weeklyActionFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend')) return `one supply or borrow adjustment on ${n}`;
  if (c.includes('dex')) return `one swap plus a small liquidity top-up on ${n}`;
  if (c.includes('bridge')) return `one small bridge transfer through ${n} in alternating directions`;
  if (c.includes('staking') || c.includes('restak')) return `one small stake top-up or reward claim on ${n}`;
  if (c.includes('derivative') || c.includes('perpetual')) return `one small hedged trade on ${n}, closed flat by the weekend`;
  if (c.includes('risk curator') || c.includes('allocator') || c.includes('yield')) return `one vault deposit or reward claim on ${n}, rotating vaults monthly`;
  if (c.includes('rwa')) return `one balance check and, monthly, a small mint or top-up on ${n}`;
  if (c.includes('chain')) return `one swap and one app interaction on ${n}'s chain`;
  return `one deposit, swap, borrow or claim on ${n}`;
}

/** A second, diversifying action: another chain when there is one, otherwise a second product surface. */
function secondAction(p: SnapshotProtocol, capital: number): string {
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    return `Repeat a smaller $${Math.max(25, Math.round(capital / 2))} position on ${second}, ${p.name}'s second chain: multi-chain usage is the cheapest way to look like a genuine user everywhere it operates.`;
  }
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend')) return `Also vote or delegate in ${p.name}'s governance or rewards page if it has one, and claim any supply rewards weekly so the wallet shows the full product loop.`;
  if (c.includes('dex')) return `Also make two direct swaps a week on ${p.name} outside your LP pair; swappers and liquidity providers are usually scored as separate behaviours.`;
  return `Also use one secondary feature of ${p.name} each week (a second vault, pool or market) so the wallet is not a single-transaction address.`;
}

/**
 * A protocol's farm plan: seven concrete steps, each carrying its cost and its
 * time inside the sentence. Every step is derived from the protocol's own
 * record (category, chains, TVL, age, seven-day change), so two protocols
 * never receive the same plan unless their records genuinely match.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, onWatchlist: boolean): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = chain.toLowerCase().includes('ethereum') ? 'about $6-12 of ETH gas' : 'about $1-3 of gas';
  const change = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null;
  const riskStep =
    change !== null && change <= -15
      ? `Risk check first: ${p.name}'s TVL fell ${Math.abs(change).toFixed(1)}% in seven days, so start at half size ($${Math.round(capital / 2)}), wait for two flat days, and only then top up to the full plan.`
      : change !== null && change >= 15
        ? `Momentum check: ${p.name}'s TVL rose ${change.toFixed(1)}% in seven days, so enter in two tranches a week apart instead of chasing the move with the full amount at once.`
        : `Risk check: keep this position under 10% of the wallet you farm with, and re-check ${p.name}'s TVL trend weekly; a 20% seven-day drop is the signal to pause and reassess.`;
  const cadence = slugHash(p.slug) % 2 === 0 ? 'one qualifying action every week' : 'two small qualifying actions a week';
  return [
    `Set up ${walletFor(chain)} dedicated to farming, fund it with about $${capital + 25}, and record the address in a farm log. Cost: ${gas} to fund and prepare. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of working capital plus ${gas}. Time: 15 minutes to set up.`,
    `${secondAction(p, capital)} Cost: about $2 of gas per action. Time: 10 minutes a week.`,
    `Keep ${cadence}: ${weeklyActionFor(p)}, in its own app, so the wallet is active in several weekly snapshots and shows the behaviour this category actually rewards. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the main position for at least ${hold} days${onWatchlist ? '; this protocol is on the snapshot watchlist, so consistency matters more than size' : ''}. Cost: the $${capital} stays deployed and cannot be reused meanwhile. Time: ${hold} days.`,
    `${riskStep} Cost: nothing to check; never pay anyone to "boost" eligibility. Time: 5 minutes a week.`,
    `Verify rewards only inside ${p.name}'s own app or its verified announcement channel, claim from that link alone, and log every claim with its date and hash. Cost: claim gas only, usually under $2. Time: 10 minutes.`,
  ];
}

/** Short display tags for a row, from its own figures. */
function tagsFor(p: SnapshotProtocol, age: number | null, onWatchlist: boolean): string[] {
  const tags: string[] = [];
  if (onWatchlist) tags.push('Watchlist');
  if (typeof p.change_7d === 'number' && p.change_7d >= 10) tags.push('Momentum');
  if (typeof p.change_7d === 'number' && p.change_7d <= -15) tags.push('Cooling');
  if (age !== null && age >= 730) tags.push('Seasoned');
  if (age !== null && age < 180) tags.push('New');
  if (p.chains.length >= 5) tags.push('Multi-chain');
  return tags;
}

/** The board: watchlist first-class, early finds scored in, live tokens never mixed in. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const { comps, globalComp } = learnComps(snapshot, model);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const candidates = snapshot.protocols.filter((p) => !chosen.has(p.slug) && isRankable(p));
  const scoredAll = candidates.map((p) => {
    const comp = comps.get(p.category ?? 'Uncategorised')?.comp ?? globalComp;
    return { p, implied: impliedValue(p, snapshot.as_of, comp, model).implied };
  });
  scoredAll.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  for (const s of scoredAll.slice(0, Math.max(0, BOARD_ROWS - chosen.size))) chosen.set(s.p.slug, s.p);

  const scored = [...chosen.values()].map((p) => {
    const entry = comps.get(p.category ?? 'Uncategorised');
    const comp = entry?.comp ?? globalComp;
    const v = impliedValue(p, snapshot.as_of, comp, model);
    return { p, comp, peers: entry?.peers ?? 0, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_comp: round4(s.comp),
      comp_peers: s.peers,
      momentum_pct: Math.round(s.momentumPct * 100) / 100,
      momentum_multiplier: round4(s.momentumMult),
      seasoning_multiplier: round4(s.seasoningMult),
      reach_multiplier: round4(s.reachMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, watch.has(s.p.slug)),
  }));
}

/** The live-token comparison set, by market cap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const { globalComp, list } = learnComps(snapshot, model);
  const categories = [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort();
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    scanned_size: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    global_comp: round4(globalComp),
    category_comps: list.slice(0, 12),
    categories,
    chains,
    rows: board.map((r) => ({ ...r, tags: tagsFor(r, r.age_days, r.on_watchlist) })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is valid. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board has ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
