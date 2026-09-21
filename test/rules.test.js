import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, handSum, KIND } from '../shared/cards.js';
import { validateDiscard, takeableCards, scoreRound, isSuperYanivState, canDeclareYaniv } from '../shared/rules.js';

const deck = buildDeck();
const card = (id) => deck.find((c) => c.id === id);
const cards = (...ids) => ids.map(card);

test('deck has 51 cards: 40 numbers + 11 purple', () => {
  assert.equal(deck.length, 51);
  assert.equal(deck.filter((c) => c.kind === KIND.NUMBER).length, 40);
  assert.equal(deck.filter((c) => c.color === 'purple').length, 11);
  assert.equal(deck.filter((c) => c.kind === KIND.STOP).length, 3);
  assert.equal(deck.filter((c) => c.kind === KIND.MINUS4).length, 2);
  assert.equal(deck.filter((c) => c.kind === KIND.MINUS3).length, 1);
  assert.equal(deck.filter((c) => c.kind === KIND.PLUS2).length, 2);
  assert.equal(deck.filter((c) => c.kind === KIND.JOKER).length, 2);
  assert.equal(deck.filter((c) => c.kind === KIND.SUPER_YANIV).length, 1);
});

test('hand sums: numbers, stop/+2 = 10, wilds = 0, minus cards negative', () => {
  assert.equal(handSum(cards('green_7', 'purple_stop_1', 'purple_plus2_1', 'purple_joker_1', 'purple_superyaniv', 'purple_minus3', 'purple_minus4_1')), 7 + 10 + 10 + 0 + 0 - 3 - 4);
});

test('single card of any kind is a valid discard', () => {
  for (const id of ['green_1', 'purple_stop_1', 'purple_plus2_1', 'purple_joker_1', 'purple_minus3']) {
    assert.equal(validateDiscard(cards(id)).ok, true, id);
  }
});

test('sets of the same number (2-4), wilds may complete them', () => {
  assert.equal(validateDiscard(cards('green_6', 'blue_6')).type, 'set');
  assert.equal(validateDiscard(cards('green_6', 'blue_6', 'red_6', 'yellow_6')).type, 'set');
  assert.equal(validateDiscard(cards('green_6', 'purple_joker_1')).type, 'set');
  assert.equal(validateDiscard(cards('green_6', 'blue_7')).ok, false);
  assert.equal(validateDiscard(cards('purple_joker_1', 'purple_joker_2')).ok, false);
});

test('runs of 3+ same colour, wilds fill gaps and extend ends', () => {
  const r = validateDiscard(cards('red_9', 'red_7', 'red_8'));
  assert.equal(r.type, 'run');
  assert.deepEqual(r.cards.map((c) => c.id), ['red_7', 'red_8', 'red_9']);

  const gap = validateDiscard(cards('red_7', 'purple_joker_1', 'red_9'));
  assert.equal(gap.type, 'run');
  assert.deepEqual(gap.cards.map((c) => c.id), ['red_7', 'purple_joker_1', 'red_9']);

  const ext = validateDiscard(cards('red_9', 'red_10', 'purple_superyaniv'));
  assert.equal(ext.type, 'run');
  assert.deepEqual(ext.cards.map((c) => c.id), ['purple_superyaniv', 'red_9', 'red_10']);

  assert.equal(validateDiscard(cards('red_7', 'red_8')).ok, false, 'two cards are not a run');
  assert.equal(validateDiscard(cards('red_7', 'blue_8', 'red_9')).ok, false, 'mixed colours');
  assert.equal(validateDiscard(cards('red_7', 'red_8', 'red_10')).ok, false, 'gap without wild');
});

test('power cards other than stop cannot be combined', () => {
  assert.equal(validateDiscard(cards('purple_stop_1', 'purple_stop_2', 'purple_stop_3')).type, 'stops');
  assert.equal(validateDiscard(cards('purple_plus2_1', 'purple_plus2_2')).ok, false);
  assert.equal(validateDiscard(cards('purple_stop_1', 'purple_plus2_1')).ok, false);
  assert.equal(validateDiscard(cards('purple_minus4_1', 'purple_minus4_2')).ok, false);
});

test('takeable: only run ends, never stop or +2', () => {
  const run = validateDiscard(cards('red_7', 'red_8', 'red_9'));
  assert.deepEqual(takeableCards({ ...run }).map((c) => c.id), ['red_7', 'red_9']);
  const set = validateDiscard(cards('green_6', 'blue_6', 'purple_joker_1'));
  assert.deepEqual(takeableCards({ ...set }).map((c) => c.id), ['green_6', 'blue_6', 'purple_joker_1']);
  assert.deepEqual(takeableCards({ type: 'single', cards: cards('purple_stop_1') }), []);
  assert.deepEqual(takeableCards({ type: 'single', cards: cards('purple_plus2_1') }), []);
  assert.deepEqual(takeableCards({ type: 'stops', cards: cards('purple_stop_1', 'purple_stop_2') }), []);
});

test('yaniv and super yaniv conditions', () => {
  assert.equal(canDeclareYaniv(cards('green_2', 'blue_3')), true);
  assert.equal(canDeclareYaniv(cards('green_2', 'blue_4')), false);
  assert.equal(canDeclareYaniv(cards('green_10', 'purple_minus4_1', 'purple_minus3')), true); // 3
  assert.equal(isSuperYanivState(cards('purple_superyaniv')), true);
  assert.equal(isSuperYanivState(cards('purple_superyaniv', 'purple_joker_1', 'purple_joker_2')), true);
  assert.equal(isSuperYanivState(cards('purple_superyaniv', 'green_1')), false);
  assert.equal(isSuperYanivState(cards('purple_joker_1')), false);
});

test('scoring: successful yaniv gives 0 (or negative sum)', () => {
  const players = [
    { id: 'a', hand: cards('green_2', 'blue_1') },       // 3
    { id: 'b', hand: cards('green_9', 'purple_stop_1') }, // 19
  ];
  const r = scoreRound(players, 'a', 'yaniv');
  assert.equal(r.caught, false);
  assert.deepEqual(r.points, { a: 0, b: 19 });
  assert.equal(r.winnerId, 'a');

  const neg = scoreRound([{ id: 'a', hand: cards('purple_minus4_1', 'green_1') }, players[1]], 'a', 'yaniv');
  assert.equal(neg.points.a, -3);
});

test('scoring: caught yaniv = sum + 30, super yaniv holder = sum + 50', () => {
  const r = scoreRound([
    { id: 'a', hand: cards('green_2', 'blue_3') }, // 5
    { id: 'b', hand: cards('green_5') },            // 5 – equal counts as caught
  ], 'a', 'yaniv');
  assert.equal(r.caught, true);
  assert.deepEqual(r.points, { a: 35, b: 5 });
  assert.equal(r.winnerId, 'b');

  const s = scoreRound([
    { id: 'a', hand: cards('green_1') },
    { id: 'b', hand: cards('purple_superyaniv', 'purple_joker_1') },
    { id: 'c', hand: cards('green_10', 'red_10') },
  ], 'a', 'yaniv');
  assert.equal(s.penalty, 50);
  assert.deepEqual(s.points, { a: 51, b: 0, c: 20 });
});

test('scoring: super yaniv declarer gets -30, super yaniv in another hand counts 0', () => {
  const r = scoreRound([
    { id: 'a', hand: cards('purple_superyaniv', 'purple_joker_2') },
    { id: 'b', hand: cards('green_4', 'purple_joker_1') },
  ], 'a', 'superYaniv');
  assert.deepEqual(r.points, { a: -30, b: 4 });
});
