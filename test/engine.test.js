import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError } from '../src/game/engine.js';
import { buildDeck, KIND } from '../shared/cards.js';

const seeded = (seed) => () => {
  // tiny deterministic PRNG (mulberry32)
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

function newGame(n = 3, opts = {}) {
  const players = ['a', 'b', 'c', 'd'].slice(0, n).map((id) => ({ id, name: id.toUpperCase() }));
  const g = new Game({ players, rng: seeded(7), ...opts });
  g.startRound();
  return g;
}

const find = (id) => buildDeck().find((c) => c.id === id);

test('round start deals 5 cards each and flips a takeable card', () => {
  const g = newGame(3);
  for (const p of g.players) assert.equal(p.hand.length, 5);
  assert.equal(g.deck.length + 15 + g.pileSets.flatMap((s) => s.cards).length, 51);
  const top = g.lastDiscard;
  assert.equal(top.cards.length, 1);
  assert.notEqual(top.cards[0].kind, KIND.STOP);
  assert.notEqual(top.cards[0].kind, KIND.PLUS2);
  assert.equal(g.step, 'discard');
});

test('turn flow: discard then draw from deck passes the turn', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  const other = g.players.find((x) => x.id !== p.id);
  const c = p.hand.find((x) => x.kind === KIND.NUMBER) || p.hand[0];
  const ev = g.discard(p.id, [c.id]);
  assert.equal(ev[0].type, 'discard');
  assert.equal(g.step, 'draw');
  assert.throws(() => g.discard(p.id, [p.hand[0].id]), GameError);
  assert.throws(() => g.draw(other.id, { source: 'deck' }), GameError);
  const stopOrPlus = c.kind === KIND.STOP || c.kind === KIND.PLUS2;
  g.draw(p.id, { source: 'deck' });
  assert.equal(p.hand.length, 5);
  if (!stopOrPlus) assert.equal(g.currentPlayer.id, other.id);
});

test('taking from the pile: the previous discard is takeable, my own discard is not', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  const other = g.players.find((x) => x.id !== p.id);
  const top = g.lastDiscard.cards[0]; // the flipped card
  const c = p.hand.find((x) => x.kind === KIND.NUMBER);
  g.discard(p.id, [c.id]);
  const v = g.viewFor(p.id);
  assert.deepEqual(v.pile.thrown.cards.map((x) => x.id), [c.id]);
  assert.deepEqual(v.takeable, [top.id]);
  assert.throws(() => g.draw(p.id, { source: 'pile', cardId: c.id }), GameError);
  g.draw(p.id, { source: 'pile', cardId: top.id });
  assert.ok(p.hand.some((x) => x.id === top.id));
  // next player sees my discard as the active set and nothing thrown yet
  const v2 = g.viewFor(other.id);
  assert.equal(v2.pile.thrown, null);
  assert.deepEqual(v2.pile.active.cards.map((x) => x.id), [c.id]);
  assert.equal(g.pileSets.some((s) => s.cards.includes(top)), false);
});

test('a run: only the ends can be taken', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  const other = g.players.find((x) => x.id !== p.id);
  p.hand = [find('red_7'), find('red_8'), find('red_9'), find('blue_1'), find('blue_2')];
  g.discard(p.id, ['red_9', 'red_7', 'red_8']);
  g.draw(p.id, { source: 'deck' });
  other.hand[0] = find('green_3');
  g.discard(other.id, ['green_3']);
  assert.deepEqual(g.viewFor(other.id).takeable, ['red_7', 'red_9']);
  assert.throws(() => g.draw(other.id, { source: 'pile', cardId: 'red_8' }), GameError);
  g.draw(other.id, { source: 'pile', cardId: 'red_9' });
  assert.ok(other.hand.some((x) => x.id === 'red_9'));
});

test('+2 makes the next player draw two cards and lose the turn', () => {
  const g = newGame(3);
  const p = g.currentPlayer;
  const plus2 = find('purple_plus2_1');
  p.hand[0] = plus2; // force the card into the hand
  const victim = g.players[g.nextActiveIndex(g.turnIndex)];
  const third = g.players[g.nextActiveIndex(g.players.indexOf(victim))];
  g.discard(p.id, [plus2.id]);
  const ev = g.draw(p.id, { source: 'deck' });
  assert.ok(ev.some((e) => e.type === 'plus2' && e.victimId === victim.id));
  assert.equal(victim.hand.length, 7);
  assert.equal(g.currentPlayer.id, third.id);
  // +2 can never be picked up from the pile
  third.hand[0] = find('green_3');
  g.discard(third.id, ['green_3']);
  assert.deepEqual(g.viewFor(third.id).takeable, []);
  assert.throws(() => g.draw(third.id, { source: 'pile', cardId: plus2.id }), GameError);
});

test('stop skips the next player; several stops act as one', () => {
  const g = newGame(3);
  const p = g.currentPlayer;
  const s1 = find('purple_stop_1');
  const s2 = find('purple_stop_2');
  p.hand[0] = s1; p.hand[1] = s2;
  const skipped = g.players[g.nextActiveIndex(g.turnIndex)];
  const third = g.players[g.nextActiveIndex(g.players.indexOf(skipped))];
  g.discard(p.id, [s1.id, s2.id]);
  const ev = g.draw(p.id, { source: 'deck' });
  assert.ok(ev.some((e) => e.type === 'stop' && e.skippedId === skipped.id));
  assert.equal(g.currentPlayer.id, third.id);
});

test('yaniv only at the start of the turn with 5 or less; scoring and next round', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  const other = g.players.find((x) => x.id !== p.id);
  p.hand = [find('green_2'), find('blue_3')];
  other.hand = [find('red_10'), find('yellow_9')];
  assert.equal(g.viewFor(p.id).me.canYaniv, true);
  const ev = g.declareYaniv(p.id);
  assert.equal(ev[0].type, 'yaniv');
  assert.equal(g.phase, 'roundEnd');
  assert.equal(p.score, 0);
  assert.equal(other.score, 19);
  assert.equal(g.roundResult.winnerId, p.id);
  // the round winner starts the next round
  g.nextRound();
  assert.equal(g.currentPlayer.id, p.id);
  assert.equal(g.round, 2);
});

test('yaniv cannot be declared after discarding', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  p.hand = [find('green_2'), find('blue_3'), find('red_10')];
  g.discard(p.id, ['red_10']);
  assert.throws(() => g.declareYaniv(p.id), GameError);
});

test('super yaniv may be declared mid-turn after discarding', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  p.hand = [find('purple_superyaniv'), find('purple_joker_1'), find('red_10')];
  assert.equal(g.viewFor(p.id).me.canSuperYaniv, false);
  g.discard(p.id, ['red_10']);
  assert.equal(g.viewFor(p.id).me.canSuperYaniv, true);
  g.declareSuperYaniv(p.id);
  assert.equal(p.score, -30);
});

test('exact target gives -50, exceeding target eliminates, last player wins', () => {
  const g = newGame(3, { targetScore: 100 });
  const [a, b, c] = g.players;
  a.score = 90; b.score = 81; c.score = 0;
  g.turnIndex = 2; g.step = 'discard';
  c.hand = [find('green_1')];
  a.hand = [find('red_10'), find('blue_10')];      // 20 → 110 → eliminated
  b.hand = [find('yellow_9'), find('purple_stop_1')]; // 19 → 100 → exact → 50
  const ev = g.declareYaniv(c.id);
  assert.equal(a.eliminated, true);
  assert.equal(b.score, 50);
  assert.equal(g.roundResult.bonuses[b.id], -50);
  assert.equal(g.phase, 'roundEnd');
  assert.ok(!ev.some((e) => e.type === 'gameOver'));

  // next round only deals to active players
  g.nextRound();
  assert.equal(a.hand.length, 0);
  assert.equal(b.hand.length, 5);
  assert.equal(c.hand.length, 5);
  assert.notEqual(g.currentPlayer.id, a.id);
});

test('game over when one player remains; everyone busting → lowest wins', () => {
  const g = newGame(2, { targetScore: 100 });
  const [a, b] = g.players;
  a.score = 95; b.score = 99;
  g.turnIndex = 0; g.step = 'discard';
  a.hand = [find('green_1')];
  b.hand = [find('red_10')];
  const ev = g.declareYaniv(a.id);
  assert.equal(g.phase, 'gameOver');
  assert.equal(g.winnerId, a.id);
  assert.ok(ev.some((e) => e.type === 'gameOver'));

  const g2 = newGame(2, { targetScore: 100 });
  const [x, y] = g2.players;
  x.score = 99; y.score = 95;
  g2.turnIndex = 0; g2.step = 'discard';
  x.hand = [find('green_5')];
  y.hand = [find('green_4')]; // caught: 4 + 30 = 34 → 129 ; x: 5 + 30 = 35 → 134
  g2.declareYaniv(x.id);
  assert.equal(g2.phase, 'gameOver');
  assert.equal(g2.winnerId, y.id);
});

test('deck reshuffles from the pile when empty', () => {
  const g = newGame(2);
  const p = g.currentPlayer;
  // move the whole deck onto the pile as old sets
  g.pileSets.unshift({ playerId: null, type: 'buried', cards: g.deck });
  g.deck = [];
  const c = p.hand.find((x) => x.kind === KIND.NUMBER) || p.hand[0];
  g.discard(p.id, [c.id]);
  const ev = g.draw(p.id, { source: 'deck' });
  assert.ok(ev.some((e) => e.type === 'reshuffle'));
  assert.equal(p.hand.length, 5);
  // the flipped card (takeable) and my own discard stay on the pile, the rest became the deck
  assert.equal(g.pileSets.length, 2);
  assert.equal(g.deck.length + 10 + g.pileSets.flatMap((s) => s.cards).length, 51);
});

test('views hide other hands during play and reveal them at round end', () => {
  const g = newGame(2);
  const [a, b] = g.players;
  const v = g.viewFor(a.id);
  assert.equal(v.players[0].hand.length, 5);
  assert.equal(v.players[1].hand, undefined);
  assert.equal(v.players[1].cardCount, 5);
  g.turnIndex = 0; g.step = 'discard';
  a.hand = [find('green_1')];
  g.declareYaniv(a.id);
  assert.equal(g.viewFor(a.id).roundResult.hands[b.id].length, 5);
});

test('removing the current player passes the turn; removing down to one ends the game', () => {
  const g = newGame(3);
  const p = g.currentPlayer;
  const next = g.players[g.nextActiveIndex(g.turnIndex)];
  g.removePlayer(p.id);
  assert.equal(g.currentPlayer.id, next.id);
  assert.equal(g.phase, 'playing');
  g.removePlayer(next.id);
  assert.equal(g.phase, 'gameOver');
});
