// Rooms: lobby membership, host management, reconnection by token, and broadcasting per-player views.
import { randomBytes, randomInt } from 'node:crypto';
import { Game, GameError } from './game/engine.js';

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000;     // drop rooms idle for 3 hours
const LOBBY_GHOST_MS = 2 * 60 * 1000;         // drop disconnected lobby players after 2 minutes
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O – easy to read out loud

export function makeCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

export function cleanName(name, fallback) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || fallback;
}

export class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = [];       // {id, token, name, socketId, connected, lastSeen}
    this.hostId = null;
    this.game = null;
    this.targetScore = 200;
    this.holdMs = 500;       // long-press duration before cards can be dragged to the pile
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
  }

  get phase() {
    return this.game ? this.game.phase : 'lobby';
  }

  touch() {
    this.touchedAt = Date.now();
  }

  findByToken(token) {
    return this.players.find((p) => p.token === token);
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  addPlayer({ token, name, socketId }) {
    if (this.game) throw new GameError('המשחק כבר התחיל – אפשר להצטרף רק בין משחקים');
    if (this.players.length >= MAX_PLAYERS) throw new GameError('החדר מלא (מקסימום 4)');
    const player = {
      id: randomBytes(4).toString('hex'),
      token,
      name: cleanName(name, `שחקן ${this.players.length + 1}`),
      socketId,
      connected: true,
      lastSeen: Date.now(),
    };
    this.players.push(player);
    if (!this.hostId) this.hostId = player.id;
    this.touch();
    return player;
  }

  removePlayer(playerId) {
    const p = this.player(playerId);
    if (!p) return [];
    let events = [];
    if (this.game && this.game.phase !== 'gameOver') events = this.game.removePlayer(playerId);
    this.players = this.players.filter((x) => x.id !== playerId);
    if (this.hostId === playerId) this.pickHost();
    this.touch();
    return events;
  }

  pickHost() {
    const next = this.players.find((p) => p.connected) || this.players[0];
    this.hostId = next ? next.id : null;
  }

  setConnected(playerId, socketId, connected) {
    const p = this.player(playerId);
    if (!p) return;
    p.connected = connected;
    p.socketId = connected ? socketId : null;
    p.lastSeen = Date.now();
    if (!connected && this.hostId === playerId && this.players.some((x) => x.connected)) this.pickHost();
    if (connected && !this.player(this.hostId)?.connected) this.hostId = playerId;
    this.touch();
  }

  startGame(byId) {
    if (byId !== this.hostId) throw new GameError('רק המארח יכול להתחיל');
    if (this.game && this.game.phase !== 'gameOver') throw new GameError('המשחק כבר רץ');
    const players = this.players.filter((p) => p.connected);
    if (players.length < MIN_PLAYERS) throw new GameError('צריך לפחות 2 משתתפים מחוברים');
    // Drop ghosts so the table only has real people.
    this.players = players;
    this.game = new Game({ players: players.map((p) => ({ id: p.id, name: p.name })), targetScore: this.targetScore });
    this.touch();
    return this.game.startRound();
  }

  backToLobby(byId) {
    if (byId !== this.hostId) throw new GameError('רק המארח יכול לפתוח משחק חדש');
    this.game = null;
    this.touch();
    return [{ type: 'lobby' }];
  }

  /** Full state as seen by one player. */
  view(playerId) {
    const gv = this.game ? this.game.viewFor(playerId) : null;
    const gamePlayers = new Map((gv?.players || []).map((p) => [p.id, p]));
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      targetScore: this.targetScore,
      holdMs: this.holdMs,
      me: playerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.id === this.hostId,
        ...(gamePlayers.get(p.id) || {}),
      })),
      game: gv && {
        round: gv.round,
        turnId: gv.turnId,
        step: gv.step,
        deckCount: gv.deckCount,
        pile: gv.pile,
        takeable: gv.takeable,
        me: gv.me,
        roundResult: gv.roundResult,
        winnerId: gv.winnerId,
      },
    };
  }

  broadcast(events = []) {
    for (const p of this.players) {
      if (p.connected && p.socketId) {
        this.io.to(p.socketId).emit('update', { state: this.view(p.id), events });
      }
    }
  }

  /** Remove players who vanished from the lobby a while ago. Returns true if anything changed. */
  sweepGhosts() {
    if (this.game) return false;
    const now = Date.now();
    const before = this.players.length;
    this.players = this.players.filter((p) => p.connected || now - p.lastSeen < LOBBY_GHOST_MS);
    if (this.players.length !== before) {
      if (!this.player(this.hostId)) this.pickHost();
      return true;
    }
    return false;
  }
}

export class RoomManager {
  constructor(io) {
    this.io = io;
    this.rooms = new Map();
    setInterval(() => this.sweep(), 30 * 1000).unref();
  }

  create() {
    let code = makeCode();
    while (this.rooms.has(code)) code = makeCode();
    const room = new Room(code, this.io);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(String(code || '').toUpperCase().trim());
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.sweepGhosts()) room.broadcast([]);
      const empty = room.players.length === 0 || room.players.every((p) => !p.connected);
      if (empty && now - room.touchedAt > ROOM_IDLE_MS) this.rooms.delete(code);
      else if (room.players.length === 0 && now - room.touchedAt > 10 * 60 * 1000) this.rooms.delete(code);
    }
  }
}
