// Game rules shared by the server (authoritative) and the client (instant feedback).
import { KIND, handSum, isPower, isWild } from './cards.js';

export const YANIV_MAX = 5;          // may declare Yaniv when the hand sums to 5 or less
export const YANIV_PENALTY = 30;     // declared Yaniv but someone had an equal or lower hand
export const SUPER_PENALTY = 50;     // declared Yaniv while someone was in a Super Yaniv state
export const SUPER_YANIV_BONUS = -30;
export const EXACT_TARGET_BONUS = -50;

/**
 * Validates a set of cards a player wants to discard together.
 * Returns { ok: true, type: 'single' | 'set' | 'run' | 'stops', cards: [ordered cards] }
 * or { ok: false, reason: 'hebrew message' }.
 */
export function validateDiscard(cards) {
  if (!cards || cards.length === 0) return { ok: false, reason: 'בחר קלפים לזריקה' };

  if (cards.length === 1) return { ok: true, type: 'single', cards: [...cards] };

  // Several stop cards together act as a single stop.
  if (cards.every((c) => c.kind === KIND.STOP)) return { ok: true, type: 'stops', cards: [...cards] };

  // Other power cards (+2, -3, -4) can only be thrown alone.
  const nonWildPower = cards.filter((c) => isPower(c) && !isWild(c));
  if (nonWildPower.length > 0) return { ok: false, reason: 'קלף כוח אפשר לזרוק רק לבד' };

  const numbers = cards.filter((c) => c.kind === KIND.NUMBER);
  const wilds = cards.filter(isWild);
  if (numbers.length === 0) return { ok: false, reason: "ג'וקרים צריכים קלף מספר לצידם" };

  // Set: 2-4 cards of the same number (wilds may complete it).
  const sameValue = numbers.every((c) => c.value === numbers[0].value);
  if (sameValue && cards.length <= 4) {
    return { ok: true, type: 'set', cards: [...numbers, ...wilds] };
  }

  // Run: 3+ consecutive cards of the same colour (wilds fill gaps or extend the ends).
  if (cards.length >= 3) {
    const run = arrangeRun(numbers, wilds);
    if (run) return { ok: true, type: 'run', cards: run };
  }

  if (sameValue) return { ok: false, reason: 'מקסימום 4 קלפים עם אותו מספר' };
  if (cards.length < 3) return { ok: false, reason: 'סדרה צריכה לפחות 3 קלפים' };
  return { ok: false, reason: 'לא סדרה ולא קלפים זהים' };
}

/**
 * Tries to lay out number cards + wilds as a run of the same colour.
 * Returns the ordered cards (low → high) or null if impossible.
 */
export function arrangeRun(numbers, wilds) {
  if (numbers.length === 0) return null;
  const color = numbers[0].color;
  if (!numbers.every((c) => c.color === color)) return null;
  const sorted = [...numbers].sort((a, b) => a.value - b.value);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].value === sorted[i - 1].value) return null;

  const total = numbers.length + wilds.length;
  const span = sorted[sorted.length - 1].value - sorted[0].value + 1;
  if (span > total || total > 10) return null;

  const pool = [...wilds];
  const run = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    for (let v = sorted[i - 1].value + 1; v < sorted[i].value; v++) run.push(pool.pop());
    run.push(sorted[i]);
  }
  // Leftover wilds extend upward while possible, otherwise downward.
  let high = sorted[sorted.length - 1].value;
  while (pool.length && high < 10) { run.push(pool.pop()); high++; }
  while (pool.length) run.unshift(pool.pop());
  return run;
}

/**
 * Which cards of the previous discard may be picked up by the next player.
 * Stop and +2 can never be taken; from a run only the two ends.
 */
export function takeableCards(lastDiscard) {
  if (!lastDiscard || lastDiscard.cards.length === 0 || lastDiscard.type === 'buried') return [];
  const { type, cards } = lastDiscard;
  const candidates = type === 'run' && cards.length > 2 ? [cards[0], cards[cards.length - 1]] : cards;
  return candidates.filter((c) => c.kind !== KIND.STOP && c.kind !== KIND.PLUS2);
}

export function canDeclareYaniv(hand) {
  return hand.length > 0 && handSum(hand) <= YANIV_MAX;
}

/** Super Yaniv state: the hand is exactly the Super Yaniv card, optionally with jokers. */
export function isSuperYanivState(hand) {
  return hand.some((c) => c.kind === KIND.SUPER_YANIV) && hand.every(isWild);
}

/**
 * Scores a finished round.
 * players: [{ id, hand }], declarerId, type: 'yaniv' | 'superYaniv'
 * Returns { points: {id: n}, sums: {id: n}, caught: bool, penalty: 0|30|50, winnerId }
 */
export function scoreRound(players, declarerId, type) {
  const sums = {};
  for (const p of players) sums[p.id] = handSum(p.hand);
  const points = {};
  let caught = false;
  let penalty = 0;
  let catcherId = null;

  if (type === 'superYaniv') {
    for (const p of players) points[p.id] = p.id === declarerId ? SUPER_YANIV_BONUS : sums[p.id];
  } else {
    const mySum = sums[declarerId];
    const others = players.filter((p) => p.id !== declarerId);
    const superHolder = others.find((p) => isSuperYanivState(p.hand));
    const lower = others.filter((p) => sums[p.id] <= mySum).sort((a, b) => sums[a.id] - sums[b.id])[0];
    if (superHolder) { caught = true; penalty = SUPER_PENALTY; catcherId = superHolder.id; }
    else if (lower) { caught = true; penalty = YANIV_PENALTY; catcherId = lower.id; }
    for (const p of players) {
      if (p.id !== declarerId) points[p.id] = sums[p.id];
      else points[p.id] = caught ? mySum + penalty : Math.min(mySum, 0);
    }
  }

  // Round winner: lowest points; a successful declarer wins ties, otherwise the catcher.
  let winnerId = caught ? catcherId : declarerId;
  for (const p of players) if (points[p.id] < points[winnerId]) winnerId = p.id;

  return { points, sums, caught, penalty, catcherId, winnerId };
}
