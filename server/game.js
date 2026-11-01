// Room state and game rules. No I/O here: the clock and RNG are injected so tests can drive a room.
import { randomBytes } from 'node:crypto';

export class GameError extends Error {}

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 12;
export const TWO_SPIES_FROM = 6;
export const POOLS = ['heroes', 'items', 'mixed'];
export const TIMERS = [0, 5, 8, 10];

const NAME_MAX = 16;
const LAST_GUESS_MS = 60_000;
const HOST_GRACE_MS = 20_000;
const OFFLINE_DROP_MS = 5 * 60_000;
const IDLE_ROOM_MS = 30 * 60_000;
const RECENT_LIMIT = 40;
const ACTIVE = ['round', 'vote', 'lastGuess'];

// Cards are keyed "h:<hero>" and "i:<item>", the same ids the client uses for images.
export function buildCards(pool) {
  const cards = new Map();
  for (const h of pool.heroes) cards.set(`h:${h.id}`, { id: `h:${h.id}`, kind: 'hero', name: h.name });
  for (const i of pool.items) cards.set(`i:${i.id}`, { id: `i:${i.id}`, kind: 'item', name: i.name });
  return cards;
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!name) throw new GameError('Введи ник');
  return name;
}

export class Room {
  constructor(code, cards, { now = Date.now, rng = Math.random } = {}) {
    this.code = code;
    this.cards = cards;
    this.now = now;
    this.rng = rng;
    this.players = new Map();
    this.tokens = new Map();
    this.hostId = null;
    this.settings = { pool: 'heroes', spies: 1, minutes: 8 };
    this.phase = 'lobby';
    this.round = null;
    this.roundNo = 0;
    this.recent = [];
    this.lastActive = now();
  }

  touch() {
    this.lastActive = this.now();
  }

  isOnline(id) {
    return (this.players.get(id)?.sockets ?? 0) > 0;
  }

  join(token, rawName) {
    const name = cleanName(rawName);
    const known = this.tokens.get(token);
    for (const p of this.players.values()) {
      if (p.id !== known && p.name.toLowerCase() === name.toLowerCase()) {
        throw new GameError('Этот ник уже занят в комнате');
      }
    }
    if (known) {
      this.players.get(known).name = name;
      return known;
    }
    if (this.players.size >= MAX_PLAYERS) throw new GameError('Комната заполнена');
    const id = randomBytes(6).toString('hex');
    this.players.set(id, { id, name, score: 0, sockets: 0, offlineSince: this.now() });
    this.tokens.set(token, id);
    this.hostId ??= id;
    return id;
  }

  connect(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.sockets++;
    p.offlineSince = null;
  }

  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.sockets = Math.max(0, p.sockets - 1);
    if (p.sockets === 0) p.offlineSince = this.now();
  }

  leave(id) {
    if (!this.players.has(id)) return;
    if (ACTIVE.includes(this.phase) && this.round.players.includes(id)) {
      // Mid-round the seat stays so votes and the result still make sense; they just go offline.
      return;
    }
    this.removePlayer(id);
  }

  removePlayer(id) {
    this.players.delete(id);
    for (const [token, pid] of this.tokens) if (pid === id) this.tokens.delete(token);
    if (this.hostId === id) this.hostId = this.pickHost();
  }

  pickHost() {
    const all = [...this.players.values()];
    return (all.find((p) => p.sockets > 0) ?? all[0])?.id ?? null;
  }

  requireHost(by) {
    if (by !== this.hostId) throw new GameError('Это может сделать только хост');
  }

  requireInRound(by) {
    if (!this.round?.players.includes(by)) throw new GameError('Ты не участвуешь в этом раунде');
  }

  setSettings(by, patch) {
    this.requireHost(by);
    if (ACTIVE.includes(this.phase)) throw new GameError('Настройки меняются между раундами');
    const next = { ...this.settings };
    if (patch.pool !== undefined) {
      if (!POOLS.includes(patch.pool)) throw new GameError('Неизвестный режим');
      next.pool = patch.pool;
    }
    if (patch.spies !== undefined) {
      if (![1, 2].includes(patch.spies)) throw new GameError('Шпионов может быть 1 или 2');
      next.spies = patch.spies;
    }
    if (patch.minutes !== undefined) {
      if (!TIMERS.includes(patch.minutes)) throw new GameError('Неизвестный таймер');
      next.minutes = patch.minutes;
    }
    this.settings = next;
  }

  kick(by, target) {
    this.requireHost(by);
    if (target === by) throw new GameError('Себя кикнуть нельзя');
    if (!this.players.has(target)) throw new GameError('Такого игрока нет');
    if (ACTIVE.includes(this.phase)) throw new GameError('Кикнуть можно между раундами');
    this.removePlayer(target);
  }

  start(by) {
    this.requireHost(by);
    if (ACTIVE.includes(this.phase)) throw new GameError('Раунд уже идёт');
    const ids = [...this.players.values()].filter((p) => p.sockets > 0).map((p) => p.id);
    if (ids.length < MIN_PLAYERS) throw new GameError(`Нужно минимум ${MIN_PLAYERS} игрока онлайн`);

    const kinds = { heroes: ['hero'], items: ['item'], mixed: ['hero', 'item'] }[this.settings.pool];
    const all = [...this.cards.values()].filter((c) => kinds.includes(c.kind));
    let fresh = all.filter((c) => !this.recent.includes(c.id));
    if (!fresh.length) fresh = all;
    const secret = fresh[Math.floor(this.rng() * fresh.length)];
    this.recent = [secret.id, ...this.recent].slice(0, RECENT_LIMIT);

    const spyCount = this.settings.spies === 2 && ids.length >= TWO_SPIES_FROM ? 2 : 1;
    const now = this.now();
    this.round = {
      no: ++this.roundNo,
      players: ids,
      spyIds: this.shuffle(ids).slice(0, spyCount),
      secretId: secret.id,
      // Its own shuffle: reusing the spy draw would always put a spy first in line.
      order: this.shuffle(ids),
      turn: 0,
      endsAt: this.settings.minutes ? now + this.settings.minutes * 60_000 : null,
      ballots: null,
      voteBy: null,
      timeUp: false,
      lastVote: null,
      lastGuessBy: null,
      lastGuessEndsAt: null,
      result: null,
    };
    this.phase = 'round';
  }

  shuffle(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // Passes the turn to the next player in line who is online. The player whose turn it is can do it,
  // so can the host, and so can anyone in the round if that player dropped out.
  // `fromTurn` is the turn the client saw, so two quick clicks can't skip someone.
  passTurn(by, fromTurn) {
    if (this.phase !== 'round') throw new GameError('Сейчас нельзя передать ход');
    const r = this.round;
    if (fromTurn !== undefined && fromTurn !== r.turn) return;
    const current = r.order[r.turn];
    const allowed = by === current || by === this.hostId || (r.players.includes(by) && !this.isOnline(current));
    if (!allowed) throw new GameError('Сейчас не твой ход');
    for (let step = 1; step <= r.order.length; step++) {
      const i = (r.turn + step) % r.order.length;
      if (this.isOnline(r.order[i])) {
        r.turn = i;
        return;
      }
    }
  }

  callVote(by) {
    if (this.phase !== 'round') throw new GameError('Сейчас нельзя начать голосование');
    this.requireInRound(by);
    this.openVote(by);
  }

  openVote(by) {
    this.round.ballots = {};
    this.round.voteBy = by;
    this.phase = 'vote';
  }

  vote(by, target) {
    if (this.phase !== 'vote') throw new GameError('Голосование не идёт');
    this.requireInRound(by);
    if (target === by) throw new GameError('За себя голосовать нельзя');
    if (!this.round.players.includes(target)) throw new GameError('Этот игрок не в раунде');
    this.round.ballots[by] = target;
    if (this.everyoneVoted()) this.resolveVote();
  }

  everyoneVoted() {
    const { players, ballots } = this.round;
    return players.filter((id) => this.isOnline(id)).every((id) => id in ballots);
  }

  finishVote(by) {
    this.requireHost(by);
    if (this.phase !== 'vote') throw new GameError('Голосование не идёт');
    this.resolveVote();
  }

  // A conviction needs a strict majority of the players still online, not just the most votes,
  // so one early ballot plus the host ending the vote can't send someone out.
  resolveVote() {
    const r = this.round;
    const tally = {};
    for (const target of Object.values(r.ballots)) tally[target] = (tally[target] ?? 0) + 1;
    const online = r.players.filter((id) => this.isOnline(id)).length;
    const [top, votes] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    const accusedId = votes > online / 2 ? top : null;
    r.lastVote = { tally, accusedId };
    r.ballots = null;

    if (!accusedId) {
      if (r.timeUp) return this.finish('spies', 'no-decision');
      this.phase = 'round';
      return;
    }
    if (r.spyIds.includes(accusedId)) {
      r.lastGuessBy = accusedId;
      r.lastGuessEndsAt = this.now() + LAST_GUESS_MS;
      this.phase = 'lastGuess';
      return;
    }
    this.finish('spies', 'wrong-accused');
  }

  guess(by, cardId) {
    const r = this.round;
    if (!this.cards.has(cardId)) throw new GameError('Такой карточки нет');
    if (this.phase === 'lastGuess') {
      if (by !== r.lastGuessBy) throw new GameError('Сейчас угадывает пойманный шпион');
    } else if (this.phase === 'round' || this.phase === 'vote') {
      if (!r.spyIds.includes(by)) throw new GameError('Угадывать может только шпион');
    } else {
      throw new GameError('Сейчас нельзя угадывать');
    }
    const right = cardId === r.secretId;
    const caught = this.phase === 'lastGuess';
    const reason = `${caught ? 'last' : 'guess'}-${right ? 'right' : 'wrong'}`;
    this.finish(right ? 'spies' : 'agents', reason, { guessBy: by, guessId: cardId });
  }

  finish(winner, reason, extra = {}) {
    const r = this.round;
    r.result = { winner, reason, ...extra };
    r.ballots = null;
    this.phase = 'result';
    for (const id of r.players) {
      const p = this.players.get(id);
      if (!p) continue;
      const spy = r.spyIds.includes(id);
      if (winner === 'spies' && spy) p.score += 2;
      if (winner === 'agents' && !spy) p.score += 1;
    }
  }

  toLobby(by) {
    this.requireHost(by);
    if (this.phase !== 'result') throw new GameError('Сначала доиграйте раунд');
    this.phase = 'lobby';
    this.round = null;
  }

  // Called once a second by the server. Returns true when something visible changed.
  tick() {
    const now = this.now();
    let changed = false;

    const host = this.players.get(this.hostId);
    if (host && host.sockets === 0 && now - host.offlineSince > HOST_GRACE_MS) {
      const next = this.pickHost();
      if (next && next !== this.hostId && this.isOnline(next)) {
        this.hostId = next;
        changed = true;
      }
    }

    const r = this.round;
    if (this.phase === 'round' && r.endsAt && now >= r.endsAt) {
      r.timeUp = true;
      this.openVote(null);
      changed = true;
    } else if (this.phase === 'vote' && this.everyoneVoted()) {
      // Someone who hadn't voted dropped out; the rest shouldn't wait for them.
      this.resolveVote();
      changed = true;
    } else if (this.phase === 'lastGuess' && now >= r.lastGuessEndsAt) {
      this.finish('agents', 'last-timeout', { guessBy: r.lastGuessBy });
      changed = true;
    }

    if (!ACTIVE.includes(this.phase)) {
      for (const p of [...this.players.values()]) {
        if (p.sockets === 0 && now - p.offlineSince > OFFLINE_DROP_MS) {
          this.removePlayer(p.id);
          changed = true;
        }
      }
    }
    return changed;
  }

  isIdle() {
    const anyoneOnline = [...this.players.values()].some((p) => p.sockets > 0);
    return !anyoneOnline && this.now() - this.lastActive > IDLE_ROOM_MS;
  }

  // What one player is allowed to see. The secret never goes to a spy or a late joiner before the result.
  view(id) {
    const out = {
      code: this.code,
      me: id,
      hostId: this.hostId,
      phase: this.phase,
      settings: this.settings,
      serverNow: this.now(),
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        online: p.sockets > 0,
        score: p.score,
      })),
      round: null,
    };
    const r = this.round;
    if (!r) return out;

    const inRound = r.players.includes(id);
    const spy = r.spyIds.includes(id);
    const over = this.phase === 'result';
    out.round = {
      no: r.no,
      players: r.players,
      order: r.order,
      turn: r.turn,
      endsAt: r.endsAt,
      spyCount: r.spyIds.length,
      role: !inRound ? 'spectator' : spy ? 'spy' : 'agent',
      card: (inRound && !spy) || over ? this.cards.get(r.secretId) : null,
      voteBy: r.voteBy,
      timeUp: r.timeUp,
      voted: r.ballots ? Object.keys(r.ballots) : [],
      myVote: r.ballots?.[id] ?? null,
      lastVote: r.lastVote,
      lastGuessBy: r.lastGuessBy,
      lastGuessEndsAt: r.lastGuessEndsAt,
      result: over ? { ...r.result, spyIds: r.spyIds, guess: this.cards.get(r.result.guessId) ?? null } : null,
    };
    return out;
  }
}
