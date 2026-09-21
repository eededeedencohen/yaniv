// Authoritative Yaniv game engine. Pure game logic – no sockets, no timers.
import { buildDeck, KIND, handSum } from '../../shared/cards.js';
import {
  validateDiscard, takeableCards, canDeclareYaniv, isSuperYanivState, scoreRound, EXACT_TARGET_BONUS,
} from '../../shared/rules.js';

export class GameError extends Error {}

export function shuffle(array, rng = Math.random) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CARDS_PER_HAND = 5;

export class Game {
  /**
   * @param {{players: {id: string, name: string}[], targetScore?: number, rng?: () => number}} opts
   */
  constructor({ players, targetScore = 200, rng = Math.random }) {
    if (players.length < 2 || players.length > 4) throw new GameError('המשחק הוא ל-2 עד 4 משתתפים');
    this.rng = rng;
    this.targetScore = targetScore;
    this.players = players.map((p) => ({ id: p.id, name: p.name, score: 0, hand: [], eliminated: false, left: false }));
    this.round = 0;
    this.phase = 'playing';
    this.deck = [];
    this.pileSets = [];          // discard history, oldest → newest; each {playerId, type, cards}
    this.turnIndex = Math.floor(rng() * players.length);
    this.step = 'discard';
    this.pendingEffect = null;   // effect of the current player's discard, applied when the turn ends
    this.roundResult = null;
    this.winnerId = null;
    this.lastDrawn = {};         // playerId → [cardIds] drawn this action (private animation hint)
  }

  // ---------- helpers ----------

  get activePlayers() {
    return this.players.filter((p) => !p.eliminated && !p.left);
  }

  get lastDiscard() {
    return this.pileSets[this.pileSets.length - 1] || null;
  }

  /**
   * The set the current player may take from: the previous player's discard.
   * During the draw step the top of the pile is the current player's own discard, so look one below.
   */
  get activeSet() {
    const len = this.pileSets.length;
    return (this.step === 'draw' ? this.pileSets[len - 2] : this.pileSets[len - 1]) || null;
  }

  get currentPlayer() {
    return this.players[this.turnIndex];
  }

  player(id) {
    const p = this.players.find((x) => x.id === id);
    if (!p) throw new GameError('משתתף לא נמצא');
    return p;
  }

  nextActiveIndex(from) {
    for (let k = 1; k <= this.players.length; k++) {
      const i = (from + k) % this.players.length;
      const p = this.players[i];
      if (!p.eliminated && !p.left) return i;
    }
    return from;
  }

  assertTurn(playerId, step) {
    if (this.phase !== 'playing') throw new GameError('הסיבוב הסתיים');
    if (this.currentPlayer.id !== playerId) throw new GameError('לא התור שלך');
    if (step && this.step !== step) {
      throw new GameError(step === 'discard' ? 'כבר זרקת – עכשיו קח קלף' : 'קודם זרוק קלפים');
    }
  }

  drawFromDeck(events) {
    if (this.deck.length === 0) {
      // Reshuffle the pile back into the deck, keeping the sets still in play
      // (the current player's discard and the set they may take from).
      const keep = this.step === 'draw' ? 2 : 1;
      const kept = this.pileSets.slice(-keep);
      const recycled = this.pileSets.slice(0, -keep).flatMap((s) => s.cards);
      this.pileSets = kept;
      if (recycled.length === 0) return null;
      this.deck = shuffle(recycled, this.rng);
      events.push({ type: 'reshuffle', count: this.deck.length });
    }
    return this.deck.pop();
  }

  // ---------- round lifecycle ----------

  startRound() {
    this.round += 1;
    this.phase = 'playing';
    this.roundResult = null;
    this.pendingEffect = null;
    this.lastDrawn = {};
    this.deck = shuffle(buildDeck(), this.rng);
    for (const p of this.players) p.hand = [];
    for (let i = 0; i < CARDS_PER_HAND; i++) {
      for (const p of this.activePlayers) p.hand.push(this.deck.pop());
    }
    // Flip the first discard. Stop / +2 have no effect here and can't be taken, so bury them and flip again.
    this.pileSets = [];
    let first = this.deck.pop();
    const buried = [];
    while (first.kind === KIND.STOP || first.kind === KIND.PLUS2) {
      buried.push(first);
      first = this.deck.pop();
    }
    if (buried.length) this.pileSets.push({ playerId: null, type: 'buried', cards: buried });
    this.pileSets.push({ playerId: null, type: 'single', cards: [first] });

    if (this.currentPlayer.eliminated || this.currentPlayer.left) this.turnIndex = this.nextActiveIndex(this.turnIndex);
    this.step = 'discard';
    return [
      { type: 'roundStart', round: this.round, starterId: this.currentPlayer.id },
      { type: 'turn', playerId: this.currentPlayer.id },
    ];
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('הסיבוב עדיין לא הסתיים');
    return this.startRound();
  }

  // ---------- player actions ----------

  discard(playerId, cardIds) {
    this.assertTurn(playerId, 'discard');
    const p = this.player(playerId);
    const ids = [...new Set(cardIds)];
    const cards = ids.map((id) => p.hand.find((c) => c.id === id));
    if (cards.some((c) => !c)) throw new GameError('הקלף לא בידך');
    const result = validateDiscard(cards);
    if (!result.ok) throw new GameError(result.reason);

    p.hand = p.hand.filter((c) => !ids.includes(c.id));
    this.pileSets.push({ playerId, type: result.type, cards: result.cards });
    this.lastDrawn = {};

    if (result.type === 'stops' || cards[0].kind === KIND.STOP) this.pendingEffect = { type: 'stop' };
    else if (cards[0].kind === KIND.PLUS2) this.pendingEffect = { type: 'plus2' };
    else this.pendingEffect = null;

    this.step = 'draw';
    return [{ type: 'discard', playerId, cards: result.cards, discardType: result.type }];
  }

  draw(playerId, { source, cardId } = {}) {
    this.assertTurn(playerId, 'draw');
    const p = this.player(playerId);
    const events = [];
    let card;
    if (source === 'pile') {
      const active = this.activeSet;
      const allowed = takeableCards(active);
      card = allowed.find((c) => c.id === cardId);
      if (!card) throw new GameError('אי אפשר לקחת את הקלף הזה');
      // The rest of that set stays on the pile, buried under this player's own discard.
      active.cards = active.cards.filter((c) => c.id !== cardId);
      if (active.cards.length === 0) this.pileSets.splice(this.pileSets.indexOf(active), 1);
      events.push({ type: 'draw', playerId, source: 'pile', card });
    } else {
      card = this.drawFromDeck(events);
      if (!card) throw new GameError('אין קלפים בקופה');
      events.push({ type: 'draw', playerId, source: 'deck' });
    }
    p.hand.push(card);
    this.lastDrawn = { [playerId]: [card.id] };
    events.push(...this.endTurn());
    return events;
  }

  declareYaniv(playerId) {
    this.assertTurn(playerId, 'discard');
    const p = this.player(playerId);
    if (!canDeclareYaniv(p.hand)) throw new GameError('אפשר להכריז יניב רק עם 5 נקודות או פחות');
    return [{ type: 'yaniv', playerId, sum: handSum(p.hand) }, ...this.finishRound(playerId, 'yaniv')];
  }

  declareSuperYaniv(playerId) {
    this.assertTurn(playerId);
    const p = this.player(playerId);
    if (!isSuperYanivState(p.hand)) throw new GameError("סופר יניב אפשר להכריז רק עם קלף סופר יניב לבד (או עם ג'וקרים)");
    return [{ type: 'superYaniv', playerId }, ...this.finishRound(playerId, 'superYaniv')];
  }

  /** The host may remove a player (e.g. after they disconnected). */
  removePlayer(playerId) {
    const p = this.player(playerId);
    if (p.left) return [];
    const wasTurn = this.phase === 'playing' && this.currentPlayer.id === playerId;
    p.left = true;
    if (p.hand.length) {
      // Bury their cards at the bottom of the pile so they come back on a reshuffle.
      this.pileSets.unshift({ playerId: null, type: 'buried', cards: p.hand });
      p.hand = [];
    }
    const events = [{ type: 'playerLeft', playerId }];
    if (this.activePlayers.length < 2) {
      this.phase = 'gameOver';
      this.winnerId = this.activePlayers[0]?.id ?? null;
      events.push({ type: 'gameOver', winnerId: this.winnerId });
    } else if (wasTurn) {
      this.pendingEffect = null;
      this.turnIndex = this.nextActiveIndex(this.turnIndex);
      this.step = 'discard';
      events.push({ type: 'turn', playerId: this.currentPlayer.id });
    }
    return events;
  }

  // ---------- internals ----------

  endTurn() {
    const effect = this.pendingEffect;
    this.pendingEffect = null;
    const events = [];
    const byId = this.currentPlayer.id;
    if (effect?.type === 'plus2') {
      const victimIndex = this.nextActiveIndex(this.turnIndex);
      const victim = this.players[victimIndex];
      const drawn = [];
      for (let i = 0; i < 2; i++) {
        const c = this.drawFromDeck(events);
        if (c) { victim.hand.push(c); drawn.push(c.id); }
      }
      this.lastDrawn[victim.id] = drawn;
      events.push({ type: 'plus2', victimId: victim.id, byId, count: drawn.length });
      this.turnIndex = this.nextActiveIndex(victimIndex);
    } else if (effect?.type === 'stop') {
      const skippedIndex = this.nextActiveIndex(this.turnIndex);
      events.push({ type: 'stop', skippedId: this.players[skippedIndex].id, byId });
      this.turnIndex = this.nextActiveIndex(skippedIndex);
    } else {
      this.turnIndex = this.nextActiveIndex(this.turnIndex);
    }
    this.step = 'discard';
    events.push({ type: 'turn', playerId: this.currentPlayer.id });
    return events;
  }

  finishRound(declarerId, type) {
    const active = this.activePlayers;
    const score = scoreRound(active, declarerId, type);
    const before = {};
    const after = {};
    const bonuses = {};
    const eliminated = [];
    for (const p of active) {
      before[p.id] = p.score;
      p.score += score.points[p.id];
      if (p.score === this.targetScore) {
        bonuses[p.id] = EXACT_TARGET_BONUS;
        p.score += EXACT_TARGET_BONUS;
      }
      after[p.id] = p.score;
    }
    for (const p of active) {
      if (p.score > this.targetScore) { p.eliminated = true; eliminated.push(p.id); }
    }

    const hands = {};
    for (const p of active) hands[p.id] = p.hand;
    this.roundResult = {
      round: this.round,
      declarerId,
      type,
      ...score,
      hands,
      before,
      after,
      bonuses,
      eliminated,
    };
    this.pendingEffect = null;
    this.lastDrawn = {};

    const events = [{ type: 'roundEnd', result: this.roundResult }];
    const alive = this.activePlayers;
    if (alive.length <= 1) {
      this.phase = 'gameOver';
      if (alive.length === 1) this.winnerId = alive[0].id;
      else this.winnerId = active.slice().sort((a, b) => a.score - b.score)[0].id;
      events.push({ type: 'gameOver', winnerId: this.winnerId });
    } else {
      this.phase = 'roundEnd';
      // The round winner starts the next round (or the next active player after them).
      const winnerIndex = this.players.findIndex((p) => p.id === score.winnerId);
      const w = this.players[winnerIndex];
      this.turnIndex = w.eliminated || w.left ? this.nextActiveIndex(winnerIndex) : winnerIndex;
    }
    return events;
  }

  // ---------- views ----------

  /** State as seen by one player: other hands are hidden until the round ends. */
  viewFor(playerId) {
    const len = this.pileSets.length;
    const drawing = this.phase === 'playing' && this.step === 'draw';
    const visible = (set) => (set && set.type !== 'buried' ? { playerId: set.playerId, type: set.type, cards: set.cards } : null);
    // thrown: the current player's discard while they still have to draw; active: what may be taken.
    const thrown = drawing ? visible(this.pileSets[len - 1]) : null;
    const active = visible(this.pileSets[len - (drawing ? 2 : 1)]);
    const previous = visible(this.pileSets[len - (drawing ? 3 : 2)]);
    const me = this.players.find((p) => p.id === playerId);
    const myTurn = this.phase === 'playing' && this.currentPlayer.id === playerId;
    return {
      phase: this.phase,
      round: this.round,
      targetScore: this.targetScore,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        cardCount: p.hand.length,
        eliminated: p.eliminated,
        left: p.left,
        hand: p.id === playerId ? p.hand : undefined,
        lastDrawn: p.id === playerId ? this.lastDrawn[p.id] || [] : undefined,
      })),
      turnId: this.phase === 'playing' ? this.currentPlayer.id : null,
      step: this.step,
      deckCount: this.deck.length,
      pile: { thrown, active, previous: previous && { cards: previous.cards } },
      takeable: drawing ? takeableCards(this.activeSet).map((c) => c.id) : [],
      me: me && {
        sum: handSum(me.hand),
        canYaniv: myTurn && this.step === 'discard' && canDeclareYaniv(me.hand),
        canSuperYaniv: myTurn && isSuperYanivState(me.hand),
      },
      roundResult: this.roundResult,
      winnerId: this.winnerId,
    };
  }
}
