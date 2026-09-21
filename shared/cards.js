// Card definitions shared by the server (authoritative) and the client (display / instant validation).

export const COLORS = ['green', 'red', 'yellow', 'blue'];

export const KIND = {
  NUMBER: 'number',
  STOP: 'stop',
  PLUS2: 'plus2',
  MINUS3: 'minus3',
  MINUS4: 'minus4',
  JOKER: 'joker',
  SUPER_YANIV: 'superyaniv',
};

// Hebrew display names for power cards.
export const KIND_LABEL = {
  [KIND.STOP]: 'עצור',
  [KIND.PLUS2]: '+2',
  [KIND.MINUS3]: '-3',
  [KIND.MINUS4]: '-4',
  [KIND.JOKER]: "ג'וקר",
  [KIND.SUPER_YANIV]: 'סופר יניב',
};

export const COLOR_LABEL = {
  green: 'ירוק',
  red: 'אדום',
  yellow: 'צהוב',
  blue: 'כחול',
  purple: 'סגול',
};

/** Builds the full 51-card deck (40 number cards + 11 purple power cards). */
export function buildDeck() {
  const cards = [];
  for (const color of COLORS) {
    for (let v = 1; v <= 10; v++) {
      cards.push({ id: `${color}_${v}`, color, kind: KIND.NUMBER, value: v, image: `${color}_${v}.png` });
    }
  }
  const power = [
    [KIND.STOP, 3, 'stop'],
    [KIND.MINUS4, 2, 'minus4'],
    [KIND.MINUS3, 1, 'minus3'],
    [KIND.PLUS2, 2, 'plus2'],
    [KIND.JOKER, 2, 'joker'],
    [KIND.SUPER_YANIV, 1, 'superyaniv'],
  ];
  for (const [kind, count, file] of power) {
    for (let i = 1; i <= count; i++) {
      const suffix = count > 1 ? `_${i}` : '';
      cards.push({ id: `purple_${file}${suffix}`, color: 'purple', kind, value: null, image: `purple_${file}${suffix}.png` });
    }
  }
  return cards;
}

/** Points a card is worth when it is left in a hand at the end of a round. */
export function cardPoints(card) {
  switch (card.kind) {
    case KIND.NUMBER: return card.value;
    case KIND.STOP:
    case KIND.PLUS2: return 10;
    case KIND.MINUS3: return -3;
    case KIND.MINUS4: return -4;
    default: return 0; // joker, super yaniv
  }
}

export function handSum(hand) {
  return hand.reduce((s, c) => s + cardPoints(c), 0);
}

/** Jokers and the Super Yaniv card can stand in for any number card. */
export function isWild(card) {
  return card.kind === KIND.JOKER || card.kind === KIND.SUPER_YANIV;
}

export function isPower(card) {
  return card.color === 'purple';
}

/** Short Hebrew description of a card, e.g. "7 אדום" or "עצור". */
export function cardLabel(card) {
  if (card.kind === KIND.NUMBER) return `${card.value} ${COLOR_LABEL[card.color]}`;
  return KIND_LABEL[card.kind];
}
