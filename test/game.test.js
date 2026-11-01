import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCards, GameError, Room } from '../server/game.js';

const pool = {
  heroes: [
    { id: 'pudge', name: 'Pudge' },
    { id: 'axe', name: 'Axe' },
    { id: 'lina', name: 'Lina' },
  ],
  items: [{ id: 'black_king_bar', name: 'Black King Bar' }],
};

// A room with n online players and a controllable clock.
function setup(n = 4, settings = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const room = new Room('ABCD', buildCards(pool), { now: clock.now });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const id = room.join(`token-player-${i}-xxxxxxxx`, `P${i}`);
    room.connect(id);
    ids.push(id);
  }
  const host = ids[0];
  if (Object.keys(settings).length) room.setSettings(host, settings);
  return { room, ids, host, clock };
}

const spiesOf = (room) => room.round.spyIds;
const agentsOf = (room) => room.round.players.filter((id) => !room.round.spyIds.includes(id));

describe('lobby', () => {
  it('first player hosts and needs three online to start', () => {
    const { room, host } = setup(2);
    assert.equal(room.hostId, host);
    assert.throws(() => room.start(host), GameError);
  });

  it('rejects duplicate names but lets the same token rename', () => {
    const { room, ids } = setup(3);
    assert.throws(() => room.join('another-token-xxxxxxxx', 'p1'), /занят/);
    assert.equal(room.join('token-player-1-xxxxxxxx', 'Renamed'), ids[1]);
    assert.equal(room.players.get(ids[1]).name, 'Renamed');
  });

  it('only the host changes settings and only to known values', () => {
    const { room, ids, host } = setup(3);
    assert.throws(() => room.setSettings(ids[1], { pool: 'items' }), /хост/);
    assert.throws(() => room.setSettings(host, { minutes: 7 }), GameError);
    room.setSettings(host, { pool: 'items', minutes: 0 });
    assert.deepEqual(room.settings, { pool: 'items', spies: 1, minutes: 0 });
  });
});

describe('roles', () => {
  it('deals one secret from the chosen pool and hides it from the spy', () => {
    const { room, host } = setup(4, { pool: 'items' });
    room.start(host);
    assert.equal(room.round.secretId, 'i:black_king_bar');
    const [spy] = spiesOf(room);
    assert.equal(room.view(spy).round.role, 'spy');
    assert.equal(room.view(spy).round.card, null);
    for (const id of agentsOf(room)) assert.equal(room.view(id).round.card.name, 'Black King Bar');
    assert.ok(!JSON.stringify(room.view(spy)).includes('black_king_bar'));
  });

  it('late joiners spectate without the card', () => {
    const { room, host } = setup(3);
    room.start(host);
    const late = room.join('late-token-xxxxxxxxxx', 'Late');
    room.connect(late);
    const view = room.view(late);
    assert.equal(view.round.role, 'spectator');
    assert.equal(view.round.card, null);
  });

  it('gives two spies only from six players', () => {
    const small = setup(5, { spies: 2 });
    small.room.start(small.host);
    assert.equal(spiesOf(small.room).length, 1);
    const big = setup(6, { spies: 2 });
    big.room.start(big.host);
    assert.equal(spiesOf(big.room).length, 2);
  });

  it('does not repeat a secret until the pool runs out', () => {
    const { room, host } = setup(3, { pool: 'heroes' });
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      room.start(host);
      seen.add(room.round.secretId);
      room.guess(spiesOf(room)[0], 'i:black_king_bar');
    }
    assert.equal(seen.size, 3);
  });
});

describe('spy guesses', () => {
  it('a right guess wins for the spy and scores 2', () => {
    const { room, host } = setup(4);
    room.start(host);
    const [spy] = spiesOf(room);
    room.guess(spy, room.round.secretId);
    assert.equal(room.phase, 'result');
    assert.equal(room.round.result.winner, 'spies');
    assert.equal(room.players.get(spy).score, 2);
  });

  it('a wrong guess hands the round to the agents', () => {
    const { room, host } = setup(4, { pool: 'items' });
    room.start(host);
    room.guess(spiesOf(room)[0], 'h:pudge');
    assert.equal(room.round.result.winner, 'agents');
    for (const id of agentsOf(room)) assert.equal(room.players.get(id).score, 1);
  });

  it('agents cannot guess', () => {
    const { room, host } = setup(4);
    room.start(host);
    assert.throws(() => room.guess(agentsOf(room)[0], room.round.secretId), /шпион/);
  });
});

describe('voting', () => {
  it('catching the spy gives them one last guess', () => {
    const { room, host } = setup(4, { pool: 'items' });
    room.start(host);
    const [spy] = spiesOf(room);
    const agents = agentsOf(room);
    room.callVote(agents[0]);
    for (const a of agents) room.vote(a, spy);
    room.vote(spy, agents[0]);
    assert.equal(room.phase, 'lastGuess');
    assert.equal(room.view(agents[1]).round.lastGuessBy, spy);
    assert.throws(() => room.guess(agents[0], 'i:black_king_bar'), GameError);
    room.guess(spy, 'h:axe');
    assert.equal(room.round.result.winner, 'agents');
    assert.equal(room.round.result.reason, 'last-wrong');
  });

  it('the caught spy runs out of time', () => {
    const { room, host, clock } = setup(3);
    room.start(host);
    const [spy] = spiesOf(room);
    const agents = agentsOf(room);
    room.callVote(spy);
    for (const a of agents) room.vote(a, spy);
    room.vote(spy, agents[0]);
    clock.advance(61_000);
    assert.ok(room.tick());
    assert.equal(room.round.result.reason, 'last-timeout');
  });

  it('convicting an agent wins for the spy', () => {
    const { room, host } = setup(4);
    room.start(host);
    const [spy] = spiesOf(room);
    const [victim, ...rest] = agentsOf(room);
    room.callVote(victim);
    for (const a of [spy, ...rest]) room.vote(a, victim);
    room.vote(victim, spy);
    assert.equal(room.round.result.winner, 'spies');
    assert.equal(room.round.result.reason, 'wrong-accused');
  });

  it('without a majority play goes on', () => {
    const { room, host } = setup(4);
    room.start(host);
    const [a, b, c, d] = room.round.players;
    room.callVote(a);
    room.vote(a, b);
    room.vote(b, a);
    room.vote(c, d);
    room.vote(d, c);
    assert.equal(room.phase, 'round');
    assert.equal(room.round.lastVote.accusedId, null);
  });

  it('the host cannot force a conviction with one ballot', () => {
    const { room, host } = setup(5);
    room.start(host);
    const [spy] = spiesOf(room);
    const voter = agentsOf(room)[0];
    room.callVote(voter);
    room.vote(voter, spy);
    room.finishVote(host);
    assert.equal(room.phase, 'round');
  });

  it('the timer opens a vote, and no decision then means the spy wins', () => {
    const { room, host, clock } = setup(4, { minutes: 5 });
    room.start(host);
    clock.advance(5 * 60_000);
    assert.ok(room.tick());
    assert.equal(room.phase, 'vote');
    assert.ok(room.round.timeUp);
    room.finishVote(host);
    assert.equal(room.round.result.reason, 'no-decision');
    assert.equal(room.round.result.winner, 'spies');
  });

  it('does not wait for a player who went offline', () => {
    const { room, host } = setup(4);
    room.start(host);
    const [spy] = spiesOf(room);
    const agents = agentsOf(room);
    room.callVote(agents[0]);
    for (const a of agents.slice(0, 2)) room.vote(a, spy);
    room.vote(spy, agents[0]);
    room.disconnect(agents[2]);
    assert.ok(room.tick());
    assert.equal(room.phase, 'lastGuess');
  });

  it('you cannot vote for yourself', () => {
    const { room, host, ids } = setup(3);
    room.start(host);
    room.callVote(ids[0]);
    assert.throws(() => room.vote(ids[1], ids[1]), /себя/);
  });
});

describe('hosting', () => {
  it('passes host to an online player after the host is gone a while', () => {
    const { room, host, ids, clock } = setup(3);
    room.disconnect(host);
    clock.advance(10_000);
    room.tick();
    assert.equal(room.hostId, host);
    clock.advance(15_000);
    room.tick();
    assert.equal(room.hostId, ids[1]);
  });

  it('kicks only between rounds', () => {
    const { room, host, ids } = setup(4);
    room.start(host);
    assert.throws(() => room.kick(host, ids[1]), /между раундами/);
    room.guess(spiesOf(room)[0], room.round.secretId);
    room.kick(host, ids[1]);
    assert.ok(!room.players.has(ids[1]));
    assert.ok(!room.tokens.has('token-player-1-xxxxxxxx'));
  });

  it('a player leaving mid-round keeps their seat until it ends', () => {
    const { room, host, ids } = setup(3);
    room.start(host);
    room.leave(ids[2]);
    assert.ok(room.players.has(ids[2]));
  });
});
