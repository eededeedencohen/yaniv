import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, RoomManager } from '../src/rooms.js';

const fakeIo = { to: () => ({ emit() {} }) };

function roomWith(n = 2) {
  const room = new Room('ABCD', fakeIo);
  const players = [];
  for (let i = 0; i < n; i++) players.push(room.addPlayer({ token: `t${i}`, name: `P${i}`, socketId: `s${i}` }));
  return { room, players };
}

test('the host keeps the role while briefly disconnected', () => {
  const { room, players: [host, guest] } = roomWith(2);
  assert.equal(room.hostId, host.id);
  room.setConnected(host.id, 's0', false);
  assert.equal(room.hostId, host.id, 'still host right after disconnecting');
  assert.equal(room.sweepHost(), false, 'not handed over within the grace period');
  room.setConnected(host.id, 's0b', true);
  assert.equal(room.hostId, host.id);
  assert.equal(guest.connected, true);
});

test('the room is handed over only after the host has been gone for a long time', () => {
  const { room, players: [host, guest] } = roomWith(2);
  room.setConnected(host.id, 's0', false);
  host.lastSeen = Date.now() - 10 * 60 * 1000;
  assert.equal(room.sweepHost(), true);
  assert.equal(room.hostId, guest.id);
});

test('a late disconnect from an old socket does not disconnect a player who already reconnected', () => {
  const { room, players: [host] } = roomWith(2);
  room.setConnected(host.id, 'new-socket', true);          // reconnected on a new socket
  const changed = room.setConnected(host.id, 's0', false);  // the old socket finally times out
  assert.equal(changed, false);
  assert.equal(host.connected, true);
  assert.equal(host.socketId, 'new-socket');
});

test('a game starts with everyone in the lobby, even someone momentarily disconnected', () => {
  const { room, players: [host, guest, third] } = roomWith(3);
  room.setConnected(third.id, 's2', false);
  room.startGame(host.id);
  assert.equal(room.game.players.length, 3);
  assert.ok(room.player(guest.id));
});

test('room summaries expose public rooms and hide nothing they should not', () => {
  const mgr = new RoomManager(fakeIo);
  const pub = mgr.create();
  pub.isPublic = true;
  pub.addPlayer({ token: 'a', name: 'Dana', socketId: 's1' });
  const priv = mgr.create();
  priv.addPlayer({ token: 'b', name: 'Yossi', socketId: 's2' });
  const list = mgr.summaries();
  assert.equal(list.length, 2);
  const p = list.find((r) => r.code === pub.code);
  assert.equal(p.isPublic, true);
  assert.equal(p.joinable, true);
  assert.equal(p.hostName, 'Dana');
  assert.equal(list.find((r) => r.code === priv.code).joinable, false);
});
