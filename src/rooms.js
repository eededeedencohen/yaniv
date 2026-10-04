// Rooms: lobby membership, host management, reconnection by token, and broadcasting per-player views.
import { randomBytes, randomInt } from 'node:crypto';
import { Game, GameError } from './game/engine.js';

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const ROOM_IDLE_MS = 20 * 60 * 1000;          // drop a game nobody has been connected to for 20 minutes
const LOBBY_GHOST_MS = 5 * 60 * 1000;         // drop disconnected lobby players after 5 minutes
const HOST_GRACE_MS = 3 * 60 * 1000;          // a disconnected host keeps the role this long (e.g. while sharing the link)
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O - easy to read out loud

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
    this.isPublic = false;   // public rooms are listed for everyone and can be joined without the code
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
    if (this.game) throw new GameError('המשחק כבר התחיל - אפשר להצטרף רק בין משחקים');
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

  /**
   * Marks a player's socket as connected / gone. A disconnect only counts if it comes from the
   * player's *current* socket: after a quick reconnect the old socket's late "disconnect" must be ignored.
   * The host keeps the role while briefly away (switching apps to share the link, a network blip).
   */
  setConnected(playerId, socketId, connected) {
    const p = this.player(playerId);
    if (!p) return false;
    if (!connected && p.socketId && p.socketId !== socketId) return false;
    p.connected = connected;
    p.socketId = connected ? socketId : null;
    p.lastSeen = Date.now();
    this.touch();
    return true;
  }

  /** Hand the room over only when the host has been gone for a long time. Returns true if it changed. */
  sweepHost() {
    const host = this.player(this.hostId);
    if (host && (host.connected || Date.now() - host.lastSeen < HOST_GRACE_MS)) return false;
    const next = this.players.find((p) => p.connected);
    if (!next || next.id === this.hostId) return false;
    this.hostId = next.id;
    return true;
  }

  startGame(byId) {
    if (byId !== this.hostId) throw new GameError('רק המארח יכול להתחיל');
    if (this.game && this.game.phase !== 'gameOver') throw new GameError('המשחק כבר רץ');
    // Everyone in the lobby plays - someone who is momentarily disconnected rejoins their seat when back.
    const players = this.players;
    if (players.filter((p) => p.connected).length < MIN_PLAYERS) throw new GameError('צריך לפחות 2 משתתפים מחוברים');
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
      isPublic: this.isPublic,
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
    this.onChange = () => {};   // set by the server to refresh the public lobby list
    setInterval(() => this.sweep(), 10 * 1000).unref();
  }

  remove(code) {
    this.rooms.delete(code);
  }

  /** Summary of every room for the "who is online" lobby. Private rooms never expose their code. */
  summaries() {
    return [...this.rooms.values()].filter((r) => r.players.some((p) => p.connected)).map((r) => ({
      code: r.code,
      isPublic: r.isPublic,
      phase: r.phase,
      hostName: r.player(r.hostId)?.name || '',
      names: r.players.map((p) => p.name),
      tokens: r.players.map((p) => p.token),
      count: r.players.length,
      joinable: r.isPublic && !r.game && r.players.length < MAX_PLAYERS,
    }));
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
    let changed = false;
    for (const [code, room] of this.rooms) {
      const ghosts = room.sweepGhosts();
      const host = room.sweepHost();
      if (ghosts || host) { room.broadcast([]); changed = true; }
      const abandoned = room.players.every((p) => !p.connected) && now - room.touchedAt > ROOM_IDLE_MS;
      const forgotten = room.players.every((p) => !p.connected) && !room.game && now - room.touchedAt > LOBBY_GHOST_MS;
      if (room.players.length === 0 || abandoned || forgotten) { this.rooms.delete(code); changed = true; }
    }
    if (changed) this.onChange();
  }
}
