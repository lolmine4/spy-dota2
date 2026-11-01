/* global io */
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const KINDS = { heroes: ['hero'], items: ['item'], mixed: ['hero', 'item'] };
const ACTIVE = ['round', 'vote', 'lastGuess'];

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private mode or blocked storage: the game still works, it just forgets the nick on reload.
    }
  },
};

// Past secrets, newest first. Every player keeps them, so whoever hosts next can ask the server
// to skip cards the group has already played, even in a new room or after the server restarted.
const HISTORY_KEY = 'spy.history';
const HISTORY_MAX = 250;

// Not named `history`: that would shadow window.history, which setUrl needs.
function pastCards() {
  try {
    const list = JSON.parse(store.get(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberCard(cardId) {
  const list = pastCards();
  if (list[0] === cardId) return;
  store.set(HISTORY_KEY, JSON.stringify([cardId, ...list.filter((id) => id !== cardId)].slice(0, HISTORY_MAX)));
}

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const S = {
  token: store.get('spy.token') || newToken(),
  name: store.get('spy.name') || '',
  code: null,
  state: null,
  offset: 0,
  cards: new Map(),
  pool: { hero: [], item: [] },
  cardShownRound: null,
  guessing: false,
  pick: null,
  boardKey: null,
  crossed: new Set(),
};
store.set('spy.token', S.token);

const socket = io();

/* ---------- helpers ---------- */

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function send(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, res) => {
      if (err) toast('Сервер не ответил, попробуй ещё раз');
      else if (res?.error) toast(res.error);
      resolve(err || res?.error ? null : res);
    });
  });
}

function img(card) {
  return `${CDN}/${card.kind === 'hero' ? 'heroes' : 'items'}/${card.key}.png`;
}

// Server cards are { id: "h:pudge", kind, name }; the local pool adds the image key.
function card(serverCard) {
  if (!serverCard) return null;
  return S.cards.get(serverCard.id) ?? { ...serverCard, key: serverCard.id.slice(2) };
}

const player = (id) => S.state?.players.find((p) => p.id === id);
const nameOf = (id) => esc(player(id)?.name ?? 'кто-то');
const isHost = () => S.state?.hostId === S.state?.me;
const fmtTime = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Only touches the DOM when the markup changed, so a state update that doesn't affect a section
// doesn't swap its buttons out from under a finger mid-tap.
const painted = new Map();
function paint(id, html) {
  if (painted.get(id) === html) return;
  painted.set(id, html);
  $(id).innerHTML = html;
}

function setUrl(code) {
  history.replaceState(null, '', code ? `/?room=${code}` : '/');
}

function roomLink() {
  return `${location.origin}/?room=${S.state.code}`;
}

/* ---------- home ---------- */

function renderHome(prefillCode = '') {
  $('game').hidden = true;
  paint('bar-room', '');
  const home = $('home');
  home.hidden = false;
  home.innerHTML = `
    <div class="home-card">
      <h1>Шпион по Доте</h1>
      <p class="lead">Все видят одного героя или предмет. Кроме шпиона. Задаёте друг другу вопросы и ищете, кто не в теме.</p>
      <label class="field">
        <span>Ник</span>
        <input id="name" maxlength="16" autocomplete="nickname" placeholder="Как тебя звать" value="${esc(S.name)}">
      </label>
      ${
        prefillCode
          ? `<button class="primary wide" data-act="join" data-code="${esc(prefillCode)}">Войти в комнату ${esc(prefillCode)}</button>
             <button class="ghost wide" data-act="create">Создать свою комнату</button>`
          : `<button class="primary wide" data-act="create">Создать комнату</button>
             <div class="or"><span>или по коду</span></div>
             <div class="row">
               <input id="code" maxlength="4" placeholder="ABCD" autocomplete="off" autocapitalize="characters">
               <button class="ghost" data-act="join">Войти</button>
             </div>`
      }
    </div>`;
  const nameInput = $('name');
  if (!S.name) nameInput.focus();
}

function readName() {
  const name = $('name')?.value.trim() ?? S.name;
  if (!name) {
    toast('Сначала введи ник');
    $('name')?.focus();
    return null;
  }
  S.name = name;
  store.set('spy.name', name);
  return name;
}

async function enterRoom(event, code) {
  const res = await send(event, { code, token: S.token, name: S.name });
  if (!res) return false;
  S.code = res.code;
  store.set('spy.room', res.code);
  setUrl(res.code);
  applyState(res.state);
  return true;
}

function applyState(state) {
  if (state.phase === 'result' && state.round?.card) rememberCard(state.round.card.id);
  S.state = state;
  S.offset = state.serverNow - Date.now();
  render();
}

// Takes the same seat again after a reload, a dropped connection or a server restart.
function rejoin() {
  socket.timeout(8000).emit('join', { code: S.code, token: S.token, name: S.name }, (err, res) => {
    if (err) return;
    if (res?.error) leaveRoom(res.error === 'Комната не найдена' ? 'Комната закрылась' : res.error);
    else if (res.code === S.code) applyState(res.state);
  });
}

function leaveRoom(message) {
  S.code = null;
  S.state = null;
  S.boardKey = null;
  store.set('spy.room', null);
  setUrl(null);
  closeSheet();
  renderHome();
  if (message) toast(message);
}

/* ---------- game screen ---------- */

function render() {
  const st = S.state;
  if (!st) return;
  $('home').hidden = true;
  $('game').hidden = false;
  paint(
    'bar-room',
    `<button class="chip" data-act="copy" title="Скопировать ссылку">Комната <b>${esc(st.code)}</b></button>
     <button class="ghost small" data-act="leave">Выйти</button>`,
  );

  const r = st.round;
  if (r && S.cardShownRound !== null && S.cardShownRound !== r.no) S.cardShownRound = null;
  if (!ACTIVE.includes(st.phase) || r?.role !== 'spy') S.guessing = false;
  if (st.phase === 'lastGuess' && r.lastGuessBy === st.me) S.guessing = true;
  if (!S.guessing) closeSheet();

  paint('panel', st.phase === 'lobby' ? lobbyPanel(st) : st.phase === 'result' ? resultPanel(st) : roundPanel(st));
  paint('players', playersPanel(st));
  renderBoard();
  tickTimers();
}

function seg(key, value, label, current, enabled) {
  const on = current === value;
  return `<button class="seg ${on ? 'on' : ''}" ${enabled ? '' : 'disabled'} data-act="set" data-key="${key}" data-val="${value}">${label}</button>`;
}

function lobbyPanel(st) {
  const host = isHost();
  const online = st.players.filter((p) => p.online).length;
  const s = st.settings;
  const need = Math.max(0, 3 - online);
  return `
    <section class="panel">
      <h2>Лобби</h2>
      <p class="muted">Скинь ссылку в Discord: друзья заходят с ПК или телефона, голос остаётся в войсе.</p>
      <button class="ghost" data-act="copy">Скопировать ссылку на комнату</button>

      <div class="settings">
        <div class="setting">
          <span>Что загадываем</span>
          <div class="segs">
            ${seg('pool', 'heroes', 'Героев', s.pool, host)}
            ${seg('pool', 'items', 'Предметы', s.pool, host)}
            ${seg('pool', 'mixed', 'Всё вместе', s.pool, host)}
          </div>
        </div>
        <div class="setting">
          <span>Шпионов</span>
          <div class="segs">
            ${seg('spies', 1, 'Один', s.spies, host)}
            ${seg('spies', 2, 'Два', s.spies, host)}
          </div>
          ${s.spies === 2 ? '<small class="muted">Второй появится, если в раунде 6+ игроков</small>' : ''}
        </div>
        <div class="setting">
          <span>Таймер раунда</span>
          <div class="segs">
            ${seg('minutes', 5, '5 мин', s.minutes, host)}
            ${seg('minutes', 8, '8 мин', s.minutes, host)}
            ${seg('minutes', 10, '10 мин', s.minutes, host)}
            ${seg('minutes', 0, 'Без', s.minutes, host)}
          </div>
        </div>
      </div>

      ${
        host
          ? `<button class="primary wide" data-act="start" ${need ? 'disabled' : ''}>${
              need ? `Ждём ещё ${need} ${need === 1 ? 'игрока' : 'игроков'}` : 'Начать раунд'
            }</button>`
          : `<p class="wait">Раунд запустит хост: ${nameOf(st.hostId)}</p>`
      }
      ${rules()}
    </section>`;
}

function rules() {
  return `
    <details class="rules">
      <summary>Как играть</summary>
      <ol>
        <li>Все, кроме шпиона, видят одну карточку: героя или предмет из Доты. Шпион видит только то, что он шпион.</li>
        <li>Спрашиваете по очереди — порядок игра показывает на экране. Тот, чей ход, задаёт вопрос любому игроку и жмёт «Передать ход».</li>
        <li>Отвечайте так, чтобы свои поняли, что вы в теме, а шпион не догадался.</li>
        <li>После трёх вопросов можно запустить голосование, если кого-то подозреваете. Чтобы выгнать игрока, нужно больше половины голосов.</li>
        <li>Выгнали шпиона — у шпиона минута на последнюю попытку назвать карточку. Выгнали своего — победа шпиона.</li>
        <li>Шпион может в любой момент нажать «Я знаю, что загадано» и назвать ответ. Ошибка — проигрыш.</li>
        <li>Кончилось время — сразу голосование. Не набрали большинства — победа шпиона.</li>
      </ol>
      <p class="muted small">Очки: агентам по 1 за победу, шпиону 2.</p>
    </details>`;
}

function roleCard(r) {
  if (r.role === 'spectator') {
    return `<div class="role spectator"><div><p class="kicker">Раунд уже идёт</p><p class="role-title">Ты смотришь</p><p>Сыграешь со следующего раунда.</p></div></div>`;
  }
  if (S.cardShownRound !== r.no) {
    return `<button class="role covered" data-act="reveal">
      <span class="kicker">Твоя роль</span>
      <span class="role-title">Нажми, чтобы открыть</span>
      <span class="muted">Если стримишь в Discord, сначала убери окно из трансляции</span>
    </button>`;
  }
  const hide = '<button class="ghost small hide" data-act="reveal">Скрыть</button>';
  if (r.role === 'spy') {
    return `<div class="role spy">
      <div class="spy-mark" aria-hidden="true"></div>
      <div>
        <p class="kicker">Твоя роль</p>
        <p class="role-title">Ты шпион</p>
        <p>${r.spyCount > 1 ? 'В раунде два шпиона, и вы не знаете друг друга. ' : ''}Слушай ответы, вычисли карточку и не выдай себя.</p>
      </div>${hide}</div>`;
  }
  const c = card(r.card);
  return `<div class="role agent ${c.kind}">
    <img src="${img(c)}" alt="">
    <div>
      <p class="kicker">${c.kind === 'hero' ? 'Загаданный герой' : 'Загаданный предмет'}</p>
      <p class="role-title">${esc(c.name)}</p>
      <p>Отвечай так, чтобы свои поняли, а шпион нет.</p>
    </div>${hide}</div>`;
}

function roundPanel(st) {
  const r = st.round;
  const inRound = r.role !== 'spectator';
  const spy = r.role === 'spy';
  const status = `
    <div class="status">
      <span>Раунд ${r.no}</span>
      ${r.endsAt && st.phase !== 'lastGuess' && !r.timeUp ? `<span class="timer" data-ends="${r.endsAt}"></span>` : ''}
    </div>`;

  let body = '';
  if (st.phase === 'round') {
    const failed = r.lastVote && !r.lastVote.accusedId;
    body = `
      ${turnBlock(st)}
      ${failed ? '<p class="note">Голосование не набрало большинства — играем дальше.</p>' : ''}
      <div class="actions">
        ${inRound ? voteButton(r) : ''}
        ${spy ? `<button class="${S.guessing ? 'primary' : 'danger'}" data-act="guessMode">${S.guessing ? 'Отмена: не угадывать' : 'Я знаю, что загадано'}</button>` : ''}
      </div>`;
  } else if (st.phase === 'vote') {
    body = votePanel(st);
  } else if (st.phase === 'lastGuess') {
    const me = r.lastGuessBy === st.me;
    body = `
      <div class="callout ${me ? 'spy' : ''}">
        <p class="callout-title">${me ? 'Тебя вычислили' : `Шпион — ${nameOf(r.lastGuessBy)}`}</p>
        <p>${me ? 'Последний шанс: выбери внизу, что загадано.' : 'У шпиона минута на последнюю попытку угадать карточку.'}
        <span class="timer" data-ends="${r.lastGuessEndsAt}"></span></p>
      </div>`;
  }

  return `<section class="panel">${status}${roleCard(r)}${body}</section>`;
}

function turnBlock(st) {
  const r = st.round;
  const nowId = r.order[r.turn];
  const nextId = r.order[(r.turn + 1) % r.order.length];
  const mine = nowId === st.me;
  const nowOffline = !player(nowId)?.online;
  const canPass = mine || isHost() || (r.role !== 'spectator' && nowOffline);
  const queue = r.order
    .map((id, i) => `<li class="${id === nowId ? 'now' : ''}"><span>${i + 1}</span>${nameOf(id)}</li>`)
    .join('');
  return `
    <div class="turn ${mine ? 'mine' : ''}">
      <p class="turn-title">${mine ? 'Твой ход: задай вопрос любому игроку' : `Спрашивает <b>${nameOf(nowId)}</b>${nowOffline ? ' <span class="muted">(не в сети)</span>' : ''}`}</p>
      <p class="muted small">Следующим спрашивает ${nameOf(nextId)}</p>
      <ol class="queue" aria-label="Очередь">${queue}</ol>
      ${canPass ? `<button class="${mine ? 'primary' : 'ghost small'}" data-act="passTurn">${mine ? 'Спросил — передать ход' : 'Передать ход дальше'}</button>` : ''}
    </div>`;
}

// Voting unlocks after a few questions; until then the button counts down instead.
function voteButton(r) {
  const left = r.voteAfter - r.asked;
  if (left <= 0) return '<button class="ghost" data-act="callVote">Начать голосование</button>';
  return `<button class="ghost" disabled>Голосование через ${left} ${left === 1 ? 'вопрос' : 'вопроса'}</button>`;
}

function votePanel(st) {
  const r = st.round;
  const inRound = r.role !== 'spectator';
  const online = r.players.filter((id) => player(id)?.online).length;
  const options = r.players
    .filter((id) => id !== st.me)
    .map(
      (id) =>
        `<button class="vote-option ${r.myVote === id ? 'on' : ''}" data-act="vote" data-id="${id}" ${inRound ? '' : 'disabled'}>${nameOf(id)}</button>`,
    )
    .join('');
  const spy = r.role === 'spy';
  return `
    <div class="callout vote">
      <p class="callout-title">${r.timeUp ? 'Время вышло. Кто шпион?' : 'Голосование. Кто шпион?'}</p>
      <p class="muted">Чтобы выгнать, нужно больше половины голосов. Проголосовали ${r.voted.length} из ${online}.</p>
      <div class="vote-options">${options}</div>
      <div class="actions">
        ${spy ? `<button class="${S.guessing ? 'primary' : 'danger'}" data-act="guessMode">${S.guessing ? 'Отмена: не угадывать' : 'Я знаю, что загадано'}</button>` : ''}
        ${isHost() ? '<button class="ghost" data-act="finishVote">Подвести итог</button>' : ''}
      </div>
    </div>`;
}

const REASONS = {
  'guess-right': (g) => `Шпион назвал «${g}» — и попал.`,
  'guess-wrong': (g) => `Шпион назвал «${g}», а загадано было другое.`,
  'last-right': (g) => `Шпиона вычислили, но последняя попытка — «${g}» — точно в цель.`,
  'last-wrong': (g) => `Шпиона вычислили, и последняя попытка мимо: «${g}».`,
  'last-timeout': () => 'Шпиона вычислили, а на ответ не хватило минуты.',
  'wrong-accused': (_g, accused) => `Голосованием выгнали ${accused}, а это был свой.`,
  'no-decision': () => 'Время вышло, а большинство так и не договорилось.',
};

function resultPanel(st) {
  const r = st.round;
  const res = r.result;
  const spiesWon = res.winner === 'spies';
  const c = card(r.card);
  const guess = res.guess ? esc(res.guess.name) : '';
  const accused = r.lastVote?.accusedId ? nameOf(r.lastVote.accusedId) : '';
  const spyNames = res.spyIds.map(nameOf).join(', ');
  const iWon = r.role !== 'spectator' && (r.role === 'spy') === spiesWon;
  const title = spiesWon ? (res.spyIds.length > 1 ? 'Победили шпионы' : 'Победил шпион') : 'Победили агенты';
  return `
    <section class="panel">
      <div class="result ${spiesWon ? 'spies' : 'agents'}">
        <p class="kicker">Раунд ${r.no}${r.role === 'spectator' ? '' : iWon ? ' · ты в выигрыше' : ' · в этот раз мимо'}</p>
        <h2>${title}</h2>
        <p>${REASONS[res.reason](guess, accused)}</p>
      </div>
      <div class="answer ${c.kind}">
        <img src="${img(c)}" alt="">
        <div>
          <p class="kicker">Было загадано</p>
          <p class="role-title">${esc(c.name)}</p>
          <p>${res.spyIds.length > 1 ? 'Шпионы' : 'Шпион'}: <b>${spyNames}</b></p>
        </div>
      </div>
      ${
        isHost()
          ? `<div class="actions">
               <button class="primary" data-act="start">Ещё раунд</button>
               <button class="ghost" data-act="lobby">В лобби, к настройкам</button>
             </div>`
          : `<p class="wait">Следующий раунд запустит хост: ${nameOf(st.hostId)}</p>`
      }
    </section>`;
}

function playersPanel(st) {
  const r = st.round;
  const host = isHost();
  const canKick = host && !ACTIVE.includes(st.phase);
  const rows = [...st.players]
    .sort((a, b) => b.score - a.score)
    .map((p) => {
      const tags = [
        p.id === st.hostId ? '<span class="tag">хост</span>' : '',
        p.id === st.me ? '<span class="tag me">ты</span>' : '',
        !p.online ? '<span class="tag off">не в сети</span>' : '',
        st.phase === 'vote' && r.voted.includes(p.id) ? '<span class="tag ok">голос</span>' : '',
        r && ACTIVE.includes(st.phase) && !r.players.includes(p.id) ? '<span class="tag off">смотрит</span>' : '',
      ].join('');
      const kick =
        canKick && p.id !== st.me ? `<button class="kick" data-act="kick" data-id="${p.id}" title="Убрать из комнаты">×</button>` : '';
      return `<li class="${p.online ? '' : 'off'}"><span class="pname">${esc(p.name)}</span>${tags}<span class="score">${p.score}</span>${kick}</li>`;
    })
    .join('');
  return `<h3>Игроки <span class="muted">${st.players.length}</span></h3><ul>${rows}</ul>`;
}

/* ---------- board ---------- */

function renderBoard() {
  const st = S.state;
  const board = $('board');
  const r = st.round;
  if (!r || !ACTIVE.includes(st.phase)) {
    board.hidden = true;
    return;
  }
  board.hidden = false;
  const key = `${st.code}:${r.no}`;
  if (S.boardKey !== key) {
    S.boardKey = key;
    S.crossed = new Set(JSON.parse(store.get(`spy.marks.${key}`) || '[]'));
    $('search').value = '';
    $('board-grid').innerHTML = KINDS[st.settings.pool]
      .map(
        (kind) => `
        <h4>${kind === 'hero' ? 'Герои' : 'Предметы'}</h4>
        <div class="grid ${kind}">${S.pool[kind]
          .map(
            (c) =>
              `<button class="tile" data-card="${c.id}" data-name="${esc(c.name.toLowerCase())}"><img src="${img(c)}" alt="" loading="lazy"><span>${esc(c.name)}</span></button>`,
          )
          .join('')}</div>`,
      )
      .join('');
  }
  applyBoard();
}

function applyBoard() {
  const query = $('search').value.trim().toLowerCase();
  const tiles = $('board-grid').querySelectorAll('.tile');
  let left = 0;
  for (const t of tiles) {
    const crossed = S.crossed.has(t.dataset.card);
    t.classList.toggle('crossed', crossed);
    t.hidden = Boolean(query) && !t.dataset.name.includes(query);
    if (!crossed) left++;
  }
  const board = $('board');
  board.classList.toggle('guessing', S.guessing);
  $('board-title').textContent = S.guessing ? 'Выбери ответ' : 'Все варианты';
  $('board-hint').textContent = S.guessing
    ? 'Нажми на карточку, которая, по-твоему, загадана. Ошибёшься — проиграешь.'
    : `Нажимай на карточки, чтобы вычёркивать. Осталось ${left} из ${tiles.length}.`;
}

function saveMarks() {
  store.set(`spy.marks.${S.boardKey}`, JSON.stringify([...S.crossed]));
}

function openSheet(cardId) {
  const c = S.cards.get(cardId);
  if (!c) return;
  S.pick = cardId;
  const sheet = $('sheet');
  sheet.innerHTML = `
    <img src="${img(c)}" alt="">
    <p>Ответить <b>${esc(c.name)}</b>?</p>
    <button class="primary" data-act="confirmGuess">Да, это ответ</button>
    <button class="ghost" data-act="cancelPick">Нет</button>`;
  sheet.hidden = false;
}

function closeSheet() {
  S.pick = null;
  $('sheet').hidden = true;
}

/* ---------- timers ---------- */

function tickTimers() {
  const now = Date.now() + S.offset;
  for (const el of document.querySelectorAll('[data-ends]')) {
    const left = Number(el.dataset.ends) - now;
    el.textContent = fmtTime(left);
    el.classList.toggle('low', left < 60_000);
  }
}
setInterval(tickTimers, 250);

/* ---------- events ---------- */

const actions = {
  async create() {
    if (!readName()) return;
    await enterRoom('create');
  },
  async join(el) {
    if (!readName()) return;
    const code = (el.dataset.code || $('code')?.value || '').trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      toast('Код комнаты — четыре буквы');
      return;
    }
    await enterRoom('join', code);
  },
  home(_el, e) {
    e.preventDefault();
    if (!S.code) renderHome();
  },
  async copy() {
    const link = roomLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    } catch {
      toast(link);
    }
  },
  async leave() {
    await send('leave');
    leaveRoom();
  },
  set(el) {
    const raw = el.dataset.val;
    const value = el.dataset.key === 'pool' ? raw : Number(raw);
    send('settings', { [el.dataset.key]: value });
  },
  kick(el) {
    send('kick', { target: el.dataset.id });
  },
  start() {
    send('start', { history: pastCards() });
  },
  // The server answers in a few hundred ms on Render; until then the button shows it was pressed
  // and can't be pressed again.
  async passTurn(el) {
    const before = S.state.round.turn;
    el.disabled = true;
    el.textContent = 'Передаю ход…';
    const res = await send('passTurn', { turn: before });
    const r = S.state?.round;
    if (res && r && r.turn !== before) toast(`Ход передан. Спрашивает ${player(r.order[r.turn])?.name ?? 'следующий'}`);
    painted.delete('panel');
    if (S.state) render();
  },
  callVote() {
    send('callVote');
  },
  vote(el) {
    send('vote', { target: el.dataset.id });
  },
  finishVote() {
    send('finishVote');
  },
  lobby() {
    send('lobby');
  },
  reveal() {
    const no = S.state.round.no;
    S.cardShownRound = S.cardShownRound === no ? null : no;
    render();
  },
  guessMode() {
    S.guessing = !S.guessing;
    render();
    if (S.guessing) $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  resetMarks() {
    S.crossed.clear();
    saveMarks();
    applyBoard();
  },
  async confirmGuess() {
    const cardId = S.pick;
    closeSheet();
    await send('guess', { cardId });
  },
  cancelPick() {
    closeSheet();
  },
};

document.addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (tile) {
    const id = tile.dataset.card;
    if (S.guessing) {
      openSheet(id);
    } else {
      if (S.crossed.has(id)) S.crossed.delete(id);
      else S.crossed.add(id);
      saveMarks();
      applyBoard();
    }
    return;
  }
  const el = e.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el, e);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('#name, #code')) return;
  const prefilled = document.querySelector('[data-act="join"][data-code]');
  if (prefilled || e.target.id === 'code') actions.join(prefilled ?? { dataset: {} });
  else actions.create();
});

$('search').addEventListener('input', applyBoard);

/* ---------- socket ---------- */

socket.on('state', (state) => {
  if (S.code && state.code === S.code) applyState(state);
});

socket.on('kicked', () => leaveRoom('Хост убрал тебя из комнаты'));

socket.on('connect', () => {
  $('offline').hidden = true;
  if (S.code && S.name) rejoin();
});

socket.on('disconnect', () => {
  if (S.code) $('offline').hidden = false;
});

/* ---------- boot ---------- */

async function boot() {
  const pool = await fetch('/data/pool.json').then((r) => r.json());
  for (const h of pool.heroes) S.pool.hero.push({ id: `h:${h.id}`, key: h.id, kind: 'hero', name: h.name });
  for (const i of pool.items) S.pool.item.push({ id: `i:${i.id}`, key: i.id, kind: 'item', name: i.name });
  for (const c of [...S.pool.hero, ...S.pool.item]) S.cards.set(c.id, c);

  const urlCode = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
  const code = /^[A-Z]{4}$/.test(urlCode) ? urlCode : '';
  const storedCode = store.get('spy.room');
  // Reloading the page inside a room drops you straight back in; a fresh invite link asks for a nick first.
  if (code && S.name && code === storedCode) {
    S.code = code;
    if (socket.connected) rejoin();
    return;
  }
  renderHome(code);
}

boot();
