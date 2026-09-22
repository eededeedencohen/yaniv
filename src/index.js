// Yaniv server: Express (serves the built client from ./dist) + Socket.IO real-time game protocol.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';
import { GameError } from './game/engine.js';
import { buildDeck } from '../shared/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3210;

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: true, credentials: true },
  pingInterval: 10000,
  pingTimeout: 20000,
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.rooms.size }));

// Serve the built client (created by `npm run deploy` in ../client) when it exists.
if (existsSync(DIST)) {
  app.use(express.static(DIST, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.type('text').send('Yaniv server is running. Build the client with `npm run deploy` to serve it from here.'));
}

const rooms = new RoomManager(io);

io.on('connection', (socket) => {
  let room = null;
  let playerId = null;

  const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });
  const fail = (ack, err) => {
    const message = err instanceof GameError ? err.message : 'משהו השתבש';
    if (!(err instanceof GameError)) console.error(err);
    if (typeof ack === 'function') ack({ ok: false, error: message });
  };

  /** Runs a room action, broadcasts the resulting events + fresh state to everyone. */
  const act = (ack, fn) => {
    try {
      if (room && room.closed) { room = null; playerId = null; }
      if (!room || !playerId) throw new GameError('אינך בחדר');
      const events = fn() || [];
      room.broadcast(events);
      ok(ack);
    } catch (err) {
      fail(ack, err);
    }
  };

  const enter = (r, p) => {
    room = r;
    playerId = p.id;
    socket.join(r.code);
    r.setConnected(p.id, socket.id, true);
  };

  socket.on('room:create', ({ name, token } = {}, ack) => {
    try {
      if (!token) throw new GameError('חסר מזהה');
      const r = rooms.create();
      const p = r.addPlayer({ token, name, socketId: socket.id });
      enter(r, p);
      r.broadcast([]);
      ok(ack, { code: r.code, playerId: p.id });
    } catch (err) { fail(ack, err); }
  });

  socket.on('room:join', ({ code, name, token } = {}, ack) => {
    try {
      if (!token) throw new GameError('חסר מזהה');
      const r = rooms.get(code);
      if (!r) throw new GameError('חדר לא נמצא – בדוק את הקוד');
      let p = r.findByToken(token);
      if (!p) p = r.addPlayer({ token, name, socketId: socket.id });
      enter(r, p);
      r.broadcast([{ type: 'joined', playerId: p.id, name: p.name }]);
      ok(ack, { code: r.code, playerId: p.id });
    } catch (err) { fail(ack, err); }
  });

  socket.on('room:rejoin', ({ code, token } = {}, ack) => {
    try {
      const r = rooms.get(code);
      const p = r && r.findByToken(token);
      if (!p) throw new GameError('החדר כבר לא קיים');
      enter(r, p);
      r.broadcast([]);
      ok(ack, { code: r.code, playerId: p.id });
    } catch (err) { fail(ack, err); }
  });

  socket.on('room:leave', (_data, ack) => {
    if (!room) return ok(ack);
    const r = room;
    const events = r.removePlayer(playerId);
    socket.leave(r.code);
    room = null;
    playerId = null;
    r.broadcast([{ type: 'left' }, ...events]);
    ok(ack);
  });

  // Host closes the room: everyone is sent back to the home screen and the room is deleted.
  socket.on('room:close', (_data, ack) => {
    try {
      if (!room || !playerId) throw new GameError('אינך בחדר');
      if (playerId !== room.hostId) throw new GameError('רק המארח יכול לסגור את החדר');
      const r = room;
      r.closed = true;
      for (const p of r.players) {
        if (p.socketId && p.id !== playerId) io.to(p.socketId).emit('roomClosed');
      }
      rooms.rooms.delete(r.code);
      socket.leave(r.code);
      room = null;
      playerId = null;
      ok(ack);
    } catch (err) { fail(ack, err); }
  });

  socket.on('room:setName', ({ name } = {}, ack) => act(ack, () => {
    const p = room.player(playerId);
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!clean) throw new GameError('השם ריק');
    p.name = clean;
    if (room.game) room.game.player(playerId).name = clean;
    return [{ type: 'renamed', playerId, name: clean }];
  }));

  socket.on('room:setOptions', ({ targetScore, holdMs } = {}, ack) => act(ack, () => {
    if (playerId !== room.hostId) throw new GameError('רק המארח משנה הגדרות');
    if (targetScore !== undefined) {
      if (room.game && room.game.phase !== 'gameOver') throw new GameError('אי אפשר לשנות באמצע משחק');
      if (![100, 200].includes(Number(targetScore))) throw new GameError('ניקוד יעד לא חוקי');
      room.targetScore = Number(targetScore);
    }
    if (holdMs !== undefined) {
      // How long players hold a card before it lifts for dragging – may be tuned mid-game.
      const ms = Number(holdMs);
      if (!(ms >= 200 && ms <= 1500)) throw new GameError('משך לחיצה לא חוקי');
      room.holdMs = ms;
    }
    return [];
  }));

  socket.on('room:kick', ({ playerId: target } = {}, ack) => act(ack, () => {
    if (playerId !== room.hostId) throw new GameError('רק המארח יכול להסיר משתתפים');
    const t = room.player(target);
    if (!t) throw new GameError('משתתף לא נמצא');
    if (t.connected && room.game && room.game.phase === 'playing') throw new GameError('אפשר להסיר רק משתתף מנותק במהלך משחק');
    if (t.socketId) io.to(t.socketId).emit('kicked');
    return room.removePlayer(target);
  }));

  socket.on('game:start', (_data, ack) => act(ack, () => room.startGame(playerId)));
  socket.on('game:discard', ({ cardIds } = {}, ack) => act(ack, () => requireGame().discard(playerId, cardIds || [])));
  socket.on('game:draw', ({ source, cardId } = {}, ack) => act(ack, () => requireGame().draw(playerId, { source, cardId })));
  socket.on('game:yaniv', (_data, ack) => act(ack, () => requireGame().declareYaniv(playerId)));
  socket.on('game:superYaniv', (_data, ack) => act(ack, () => requireGame().declareSuperYaniv(playerId)));
  socket.on('game:nextRound', (_data, ack) => act(ack, () => {
    const hostHere = room.player(room.hostId)?.connected;
    if (playerId !== room.hostId && hostHere) throw new GameError('המארח מתחיל את הסיבוב הבא');
    return requireGame().nextRound();
  }));
  socket.on('game:restart', (_data, ack) => act(ack, () => room.backToLobby(playerId)));

  function requireGame() {
    if (!room.game) throw new GameError('המשחק לא התחיל');
    return room.game;
  }

  // Test hook (only when YANIV_DEV=1): replace a hand with specific cards to reach rare situations.
  if (process.env.YANIV_DEV === '1') {
    socket.on('dev:setHand', ({ playerId: target, cardIds, score } = {}, ack) => act(ack, () => {
      const game = requireGame();
      const p = game.player(target || playerId);
      if (Array.isArray(cardIds)) {
        const all = buildDeck();
        const cards = cardIds.map((id) => all.find((c) => c.id === id)).filter(Boolean);
        const inUse = new Set(cards.map((c) => c.id));
        game.deck = game.deck.filter((c) => !inUse.has(c.id));
        for (const s of game.pileSets) s.cards = s.cards.filter((c) => !inUse.has(c.id));
        for (const other of game.players) if (other !== p) other.hand = other.hand.filter((c) => !inUse.has(c.id));
        p.hand = cards;
      }
      if (typeof score === 'number') p.score = score;
      return [];
    }));
  }

  socket.on('disconnect', () => {
    if (!room || room.closed) return;
    room.setConnected(playerId, socket.id, false);
    room.broadcast([{ type: 'disconnected', playerId }]);
  });
});

http.listen(PORT, () => {
  console.log(`Yaniv server listening on http://localhost:${PORT}`);
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (lan) console.log(`LAN: http://${lan.address}:${PORT}`);
  console.log(existsSync(DIST) ? 'Serving client from ./dist' : 'No ./dist yet – run `npm run deploy` in ../client');
});
