import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { buildCards, GameError, Room } from './game.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 500;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

const publicDir = new URL('../public/', import.meta.url);
const pool = JSON.parse(readFileSync(new URL('data/pool.json', publicDir), 'utf8'));
const cards = buildCards(pool);
const rooms = new Map();

const app = express();
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(
  express.static(fileURLToPath(publicDir), {
    setHeaders(res, path) {
      // The page and scripts change with deploys; hero data only with patches.
      const long = /[\\/]data[\\/]/.test(path);
      res.setHeader('Cache-Control', long ? 'public, max-age=3600' : 'no-cache');
    },
  }),
);

const httpServer = createServer(app);
const io = new Server(httpServer, { maxHttpBufferSize: 10_000 });

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
}

const seat = (code, id) => `${code}:${id}`;

function broadcast(room) {
  for (const id of room.players.keys()) io.to(seat(room.code, id)).emit('state', room.view(id));
}

function leaveCurrent(socket) {
  const { code, id } = socket.data;
  if (!code) return;
  socket.leave(seat(code, id));
  socket.data = {};
  const room = rooms.get(code);
  if (!room) return;
  room.disconnect(id);
  broadcast(room);
}

function enter(socket, room, token, name) {
  if (!TOKEN_RE.test(String(token))) throw new GameError('Обнови страницу');
  const id = room.join(token, name);
  // Same seat again (a rename or a duplicate join after reconnect): nothing to rewire.
  if (socket.data.code === room.code && socket.data.id === id) return;
  leaveCurrent(socket);
  socket.data = { code: room.code, id };
  socket.join(seat(room.code, id));
  room.connect(id);
}

io.on('connection', (socket) => {
  socket.data = {};

  // Every handler answers through the ack callback: { ok: true, ... } or { error: 'text for the player' }.
  const on = (event, handler) => {
    socket.on(event, (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const extra = handler(payload ?? {});
        reply({ ok: true, ...extra });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(event, err);
        reply({ error: err instanceof GameError ? err.message : 'Что-то сломалось, попробуй ещё раз' });
      }
    });
  };

  const current = () => {
    const room = rooms.get(socket.data.code);
    if (!room || !room.players.has(socket.data.id)) throw new GameError('Ты не в комнате');
    return room;
  };

  // Runs a room action as the current player, then pushes the new state to everyone in the room.
  const act = (event, fn) =>
    on(event, (payload) => {
      const room = current();
      fn(room, socket.data.id, payload);
      room.touch();
      broadcast(room);
    });

  on('create', ({ token, name }) => {
    if (rooms.size >= MAX_ROOMS) throw new GameError('Сервер переполнен, попробуй позже');
    const room = new Room(newCode(), cards);
    rooms.set(room.code, room);
    try {
      enter(socket, room, token, name);
    } catch (err) {
      rooms.delete(room.code);
      throw err;
    }
    broadcast(room);
    // The state rides along with the ack: the broadcast above lands before the client knows its room code.
    return { code: room.code, state: room.view(socket.data.id) };
  });

  on('join', ({ code, token, name }) => {
    const room = rooms.get(String(code ?? '').toUpperCase());
    if (!room) throw new GameError('Комната не найдена');
    enter(socket, room, token, name);
    room.touch();
    broadcast(room);
    return { code: room.code, state: room.view(socket.data.id) };
  });

  on('leave', () => {
    const { code, id } = socket.data;
    leaveCurrent(socket);
    const room = rooms.get(code);
    if (!room) return;
    room.leave(id);
    broadcast(room);
  });

  act('settings', (room, by, patch) => room.setSettings(by, patch));
  act('start', (room, by) => room.start(by));
  act('passTurn', (room, by, { turn }) => room.passTurn(by, turn));
  act('callVote', (room, by) => room.callVote(by));
  act('vote', (room, by, { target }) => room.vote(by, target));
  act('finishVote', (room, by) => room.finishVote(by));
  act('guess', (room, by, { cardId }) => room.guess(by, cardId));
  act('lobby', (room, by) => room.toLobby(by));
  act('kick', (room, by, { target }) => {
    room.kick(by, target);
    io.to(seat(room.code, target)).emit('kicked');
    io.in(seat(room.code, target)).socketsLeave(seat(room.code, target));
  });

  socket.on('disconnect', () => leaveCurrent(socket));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.isIdle()) rooms.delete(room.code);
    else if (room.tick()) broadcast(room);
  }
}, 1000);

httpServer.listen(PORT, () => {
  console.log(`Dota Spy on http://localhost:${PORT} (${pool.heroes.length} heroes, ${pool.items.length} items)`);
});
