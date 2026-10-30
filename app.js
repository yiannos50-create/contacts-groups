'use strict';

// Contacts Groups: edits Google Contacts directly through the People API.
// Nothing about your contacts is stored by this app. Only the Client ID and
// the group name are kept in this browser's local storage.

const SCOPE = 'https://www.googleapis.com/auth/contacts';
const API = 'https://people.googleapis.com/v1';
const PERSON_FIELDS = 'names,phoneNumbers,memberships,biographies';
const DEFAULT_GROUP = 'Εξομολόγηση';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const state = {
  clientId: store.get('clientId', ''),
  groupName: store.get('groupName', DEFAULT_GROUP),
  token: null,
  tokenExpires: 0,
  tokenClient: null,
  groups: new Map(),       // resourceName -> name (user groups only)
  groupRes: null,          // resourceName of the target group
  people: [],              // contacts, held in memory only
  tab: 'group',
  justAdded: new Set(),    // kept visible in "Other" right after ticking
  focusIndex: -1,
  queues: new Map(),       // resourceName -> promise chain, so saves never overlap
};

// ---------- Status line ----------

let statusTimer;
function status(msg, isErr = false, sticky = false) {
  const s = $('status');
  s.textContent = msg || '';
  s.classList.toggle('err', isErr);
  clearTimeout(statusTimer);
  if (msg && !sticky) statusTimer = setTimeout(() => (s.textContent = ''), 4000);
}

// ---------- Sign-in (Google Identity Services) ----------

function waitForGis() {
  return new Promise((resolve) => {
    const check = () => (window.google?.accounts?.oauth2 ? resolve() : setTimeout(check, 100));
    check();
  });
}

let pendingToken = null;
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    pendingToken = { resolve, reject };
    state.tokenClient.requestAccessToken({ prompt });
  });
}

function onToken(resp) {
  const p = pendingToken; pendingToken = null;
  if (resp.error) { p?.reject(new Error(resp.error_description || resp.error)); return; }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
    p?.reject(new Error('Contacts access was not allowed. Please sign in again and tick the contacts box.'));
    return;
  }
  state.token = resp.access_token;
  state.tokenExpires = Date.now() + (Number(resp.expires_in) - 60) * 1000;
  try {
    sessionStorage.setItem('tok', JSON.stringify({ t: state.token, e: state.tokenExpires }));
  } catch { /* ignore */ }
  p?.resolve();
}

function restoreToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem('tok') || 'null');
    if (saved && saved.e > Date.now()) { state.token = saved.t; state.tokenExpires = saved.e; }
  } catch { /* ignore */ }
}

function clearToken() {
  state.token = null; state.tokenExpires = 0;
  try { sessionStorage.removeItem('tok'); } catch { /* ignore */ }
}

// When the 1-hour sign-in runs out mid-work, a browser popup needs a tap,
// so show a button and wait for it instead of losing what's on screen.
let renewing = null;
function renewToken() {
  if (renewing) return renewing;
  renewing = new Promise((resolve, reject) => {
    const s = $('status');
    s.textContent = 'Your sign-in expired. ';
    s.classList.remove('err');
    clearTimeout(statusTimer);
    const b = el('button', 'primary', 'Continue');
    b.onclick = () => requestToken('').then(() => { status(''); resolve(); }, reject);
    s.append(b);
  }).finally(() => { renewing = null; });
  return renewing;
}

async function api(path, opts = {}, retried = false) {
  if (!state.token || Date.now() > state.tokenExpires) await renewToken();
  const res = await fetch(path.startsWith('http') ? path : API + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401 && !retried) { clearToken(); return api(path, opts, true); }
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error?.message || 'Google returned error ' + res.status);
    err.status = res.status;
    err.reason = body.error?.status;
    throw err;
  }
  return body;
}

// ---------- Loading contacts ----------

function personView(raw) {
  const name = raw.names?.[0]?.displayName || '';
  const phone = raw.phoneNumbers?.[0]?.value || '';
  const notes = raw.biographies?.[0]?.value || '';
  const groupIds = (raw.memberships || [])
    .map((m) => m.contactGroupMembership?.contactGroupResourceName)
    .filter((g) => g && state.groups.has(g));
  return { id: raw.resourceName, raw, name, phone, notes, notesSaved: notes, groupIds };
}

async function loadAll() {
  status('Loading contacts…', false, true);
  $('refreshBtn').disabled = true;
  try {
    const g = await api('/contactGroups?pageSize=1000&groupFields=name,groupType');
    state.groups.clear();
    state.groupRes = null;
    const want = state.groupName.normalize('NFC').trim().toLocaleLowerCase();
    for (const grp of g.contactGroups || []) {
      if (grp.groupType !== 'USER_CONTACT_GROUP') continue;
      state.groups.set(grp.resourceName, grp.name);
      if (grp.name.normalize('NFC').trim().toLocaleLowerCase() === want) state.groupRes = grp.resourceName;
    }

    const people = [];
    let pageToken = '';
    do {
      const q = `/people/me/connections?pageSize=1000&personFields=${PERSON_FIELDS}&sortOrder=FIRST_NAME_ASCENDING` +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const page = await api(q);
      for (const raw of page.connections || []) people.push(personView(raw));
      pageToken = page.nextPageToken || '';
    } while (pageToken);

    state.people = people;
    state.justAdded.clear();
    fillOtherFilter();
    render();
    status(`Loaded ${people.length} contacts.`);
  } catch (e) {
    status('Could not load contacts: ' + e.message, true, true);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

async function refetchPerson(p) {
  const raw = await api(`/${p.id}?personFields=${PERSON_FIELDS}`);
  const fresh = personView(raw);
  Object.assign(p, { raw, name: fresh.name, phone: fresh.phone, groupIds: fresh.groupIds, notesSaved: fresh.notes });
  return fresh;
}

// One save at a time per contact, because each save needs the latest etag.
function enqueue(p, job) {
  const prev = state.queues.get(p.id) || Promise.resolve();
  const next = prev.catch(() => {}).then(job);
  state.queues.set(p.id, next);
  return next;
}

// ---------- Changes ----------

const inGroup = (p) => state.groupRes && p.groupIds.includes(state.groupRes);

function setGroup(p, add) {
  return enqueue(p, async () => {
    const body = add ? { resourceNamesToAdd: [p.id] } : { resourceNamesToRemove: [p.id] };
    await api(`/${state.groupRes}/members:modify`, { method: 'POST', body: JSON.stringify(body) });
    await refetchPerson(p);
  });
}

// Writes fields to Google. If the contact changed somewhere else since we
// loaded it, refuse to overwrite rather than lose that change.
function updatePerson(p, changes) {
  return enqueue(p, async () => {
    const fields = Object.keys(changes);
    const send = () => api(
      `/${p.id}:updateContact?updatePersonFields=${fields.join(',')}&personFields=${PERSON_FIELDS}`,
      { method: 'PATCH', body: JSON.stringify({ etag: p.raw.etag, ...changes }) },
    );
    let raw;
    try {
      raw = await send();
    } catch (e) {
      if (e.status !== 400 || !/etag|FAILED_PRECONDITION/i.test(e.message + e.reason)) throw e;
      const notesBefore = p.notesSaved;
      const fresh = await refetchPerson(p);
      if ('biographies' in changes && fresh.notes !== notesBefore) {
        throw new Error('These notes were changed on another device. Press Refresh, then edit again.');
      }
      raw = await send();
    }
    const v = personView(raw);
    Object.assign(p, { raw, name: v.name, phone: v.phone, groupIds: v.groupIds, notesSaved: v.notes });
  });
}

const notesPayload = (text) => ({ biographies: text.trim() ? [{ value: text, contentType: 'TEXT_PLAIN' }] : [] });

// ---------- Rendering ----------

function visiblePeople() {
  const q = $('search').value.trim().toLocaleLowerCase();
  const digits = q.replace(/\D/g, '');
  const filter = $('otherFilter').value;
  return state.people.filter((p) => {
    if (state.tab === 'group') {
      if (!inGroup(p)) return false;
    } else {
      if (inGroup(p) && !state.justAdded.has(p.id)) return false;
      if (filter === 'none' && p.groupIds.some((g) => g !== state.groupRes)) return false;
      if (filter !== 'all' && filter !== 'none' && !p.groupIds.includes(filter)) return false;
    }
    if (!q) return true;
    return p.name.toLocaleLowerCase().includes(q) ||
      p.notes.toLocaleLowerCase().includes(q) ||
      (digits.length >= 3 && p.phone.replace(/\D/g, '').includes(digits));
  });
}

function fillOtherFilter() {
  const sel = $('otherFilter');
  const keep = sel.value;
  sel.replaceChildren(new Option('All not in group', 'all'), new Option('No group', 'none'));
  [...state.groups].filter(([id]) => id !== state.groupRes)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => sel.add(new Option('Group: ' + name, id)));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : 'all';
}

function updateCounts() {
  const n = state.people.filter(inGroup).length;
  $('groupCount').textContent = n;
  $('otherCount').textContent = state.people.length - n;
}

function render() {
  $('groupTabName').textContent = state.groupName;
  $('missingGroupName').textContent = state.groupName;
  $('missingGroup').hidden = !!state.groupRes || state.people.length === 0;
  $('otherFilter').hidden = state.tab !== 'other';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  updateCounts();

  const list = $('list');
  const people = visiblePeople();
  list.replaceChildren(...people.map(rowFor));
  $('empty').hidden = people.length > 0 || state.people.length === 0;
  state.focusIndex = Math.min(state.focusIndex, people.length - 1);
  highlight();
}

function rowFor(p) {
  const li = el('li', 'row');
  li.dataset.id = p.id;

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !!inGroup(p);
  box.disabled = !state.groupRes;
  box.title = box.checked ? `In ${state.groupName} (untick to remove)` : `Add to ${state.groupName}`;
  box.setAttribute('aria-label', box.title);
  box.onchange = () => toggleGroup(p, box, li);

  const who = el('div', 'who');
  who.append(el('div', 'name', p.name || p.phone || '(no name)'));
  const phone = el('div', 'phone');
  if (p.phone) {
    const a = el('a', null, p.phone);
    a.href = 'tel:' + p.phone.replace(/[^\d+]/g, '');
    phone.append(a);
  }
  who.append(phone);
  const others = p.groupIds.filter((g) => g !== state.groupRes);
  if (others.length) {
    const chips = el('div', 'chips');
    others.forEach((g) => chips.append(el('span', 'chip', state.groups.get(g))));
    who.append(chips);
  }

  const edit = el('button', 'ghost edit', 'Edit');
  edit.onclick = () => openEdit(p);

  li.append(box, who);
  if (inGroup(p)) li.append(notesBox(p));
  li.append(edit);
  return li;
}

function notesBox(p) {
  const wrap = el('div', 'notes');
  const ta = document.createElement('textarea');
  ta.placeholder = 'Notes';
  ta.value = p.notes;
  ta.setAttribute('aria-label', 'Notes for ' + (p.name || 'contact'));
  const saved = el('div', 'save-state');
  let timer;
  const save = () => {
    clearTimeout(timer);
    if (ta.value === p.notesSaved) return;
    const text = ta.value;
    saved.textContent = 'Saving…'; saved.classList.remove('err');
    updatePerson(p, notesPayload(text)).then(
      () => { saved.textContent = p.notes === p.notesSaved ? 'Saved' : ''; },
      (e) => { saved.textContent = e.message; saved.classList.add('err'); },
    );
  };
  ta.oninput = () => { p.notes = ta.value; saved.textContent = 'Not saved yet'; clearTimeout(timer); timer = setTimeout(save, 1500); };
  ta.onblur = save;
  ta.onkeydown = (e) => { if (e.key === 'Escape') ta.blur(); };
  wrap.append(ta, saved);
  return wrap;
}

async function toggleGroup(p, box, li) {
  const add = box.checked;
  if (!add && !confirm(`Remove ${p.name || 'this contact'} from ${state.groupName}?\nTheir notes stay on the contact.`)) {
    box.checked = true; return;
  }
  box.disabled = true;
  try {
    await setGroup(p, add);
    if (add) state.justAdded.add(p.id); else state.justAdded.delete(p.id);
    status(add ? `Added ${p.name} to ${state.groupName}.` : `Removed ${p.name} from ${state.groupName}.`);
    const fresh = rowFor(p);
    li.replaceWith(fresh);
    updateCounts();
    if (add) fresh.querySelector('textarea')?.focus();
    else if (state.tab === 'group') render();
  } catch (e) {
    box.checked = !add;
    box.disabled = false;
    status('Could not change the group: ' + e.message, true);
  }
}

// ---------- Edit dialog ----------

let editing = null;
function openEdit(p) {
  editing = p;
  $('editName').value = p.name;
  $('editPhone').value = p.phone;
  $('editNotes').value = p.notes;
  const n = p.raw.phoneNumbers?.length || 0;
  $('editHint').textContent = n > 1 ? `This contact has ${n} phone numbers. Only the first one is shown and changed here.` : '';
  $('editDialog').showModal();
  $('editName').focus();
}

$('editForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('editDialog').close('save'); }
});

$('editDialog').addEventListener('close', async () => {
  const p = editing; editing = null;
  if ($('editDialog').returnValue !== 'save' || !p) return;
  const name = $('editName').value.trim();
  const phone = $('editPhone').value.trim();
  const notes = $('editNotes').value;
  const changes = {};
  if (name && name !== p.name) changes.names = [{ unstructuredName: name }];
  if (phone !== p.phone) {
    const list = (p.raw.phoneNumbers || []).map((x) => ({ value: x.value, type: x.type }));
    if (list.length) { if (phone) list[0].value = phone; else list.shift(); } else if (phone) list.push({ value: phone, type: 'mobile' });
    changes.phoneNumbers = list;
  }
  if (notes !== p.notesSaved) Object.assign(changes, notesPayload(notes));
  if (!Object.keys(changes).length) return;
  status('Saving…', false, true);
  try {
    await updatePerson(p, changes);
    p.notes = p.notesSaved;
    status('Saved.');
    render();
  } catch (e) {
    status('Could not save: ' + e.message, true, true);
  }
});

// ---------- Keyboard (PC) ----------

function highlight() {
  const rows = [...$('list').children];
  rows.forEach((r, i) => r.classList.toggle('focused', i === state.focusIndex));
  rows[state.focusIndex]?.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if ($('appView').hidden || $('editDialog').open || e.ctrlKey || e.metaKey || e.altKey) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== 'checkbox';
  if (typing) {
    if (e.key === 'Escape' || (e.key === 'ArrowDown' && document.activeElement === $('search'))) {
      document.activeElement.blur(); state.focusIndex = 0; highlight(); e.preventDefault();
    }
    return;
  }
  if ((e.key === ' ' || e.key === 'Enter') && /^(BUTTON|INPUT)$/.test(document.activeElement?.tagName)) return;
  const rows = [...$('list').children];
  const row = rows[state.focusIndex];
  const p = row && state.people.find((x) => x.id === row.dataset.id);
  switch (e.key) {
    case '/': $('search').focus(); break;
    case 'ArrowDown': case 'j': state.focusIndex = Math.min(rows.length - 1, state.focusIndex + 1); highlight(); break;
    case 'ArrowUp': case 'k': state.focusIndex = Math.max(0, state.focusIndex - 1); highlight(); break;
    case ' ': if (row) row.querySelector('input[type=checkbox]').click(); break;
    case 'Enter': case 'e': if (p) openEdit(p); break;
    case 'n': row?.querySelector('textarea')?.focus(); break;
    case '1': switchTab('group'); break;
    case '2': switchTab('other'); break;
    case 'r': loadAll(); break;
    default: return;
  }
  e.preventDefault();
});

// ---------- Screens ----------

function switchTab(tab) {
  state.tab = tab;
  state.justAdded.clear();
  state.focusIndex = -1;
  render();
}

function show(view) {
  $('setupView').hidden = view !== 'setup';
  $('signInView').hidden = view !== 'signin';
  $('appView').hidden = view !== 'app';
  $('refreshBtn').hidden = view !== 'app';
  $('signOutBtn').hidden = view !== 'app';
}

function showSetup() {
  $('clientIdInput').value = state.clientId;
  $('groupNameInput').value = state.groupName;
  show('setup');
}

async function start() {
  if (!state.clientId) { showSetup(); return; }
  await waitForGis();
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
    scope: SCOPE,
    callback: onToken,
    error_callback: (err) => {
      const p = pendingToken; pendingToken = null;
      p?.reject(new Error(err.type === 'popup_closed' ? 'Sign-in window was closed.' : (err.message || 'Sign-in failed.')));
    },
  });
  restoreToken();
  if (state.token) { show('app'); loadAll(); } else show('signin');
}

$('signInBtn').onclick = async () => {
  try {
    await requestToken('');
    show('app');
    loadAll();
  } catch (e) {
    status(e.message, true, true);
  }
};

$('signOutBtn').onclick = () => {
  if (state.token) google.accounts.oauth2.revoke(state.token, () => {});
  clearToken();
  state.people = [];
  $('list').replaceChildren();
  show('signin');
  status('Signed out.');
};

$('refreshBtn').onclick = loadAll;
$('settingsBtn').onclick = showSetup;

$('saveSetupBtn').onclick = () => {
  const id = $('clientIdInput').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) {
    status('That does not look like a Client ID. It should end in .apps.googleusercontent.com', true, true);
    return;
  }
  const changedId = id !== state.clientId;
  state.clientId = id;
  state.groupName = $('groupNameInput').value.trim() || DEFAULT_GROUP;
  store.set('clientId', id);
  store.set('groupName', state.groupName);
  status('');
  if (changedId || !state.tokenClient) { clearToken(); start(); }
  else if (state.token) { show('app'); loadAll(); }
  else show('signin');
};

$('createGroupBtn').onclick = async () => {
  try {
    await api('/contactGroups', { method: 'POST', body: JSON.stringify({ contactGroup: { name: state.groupName } }) });
    await loadAll();
  } catch (e) {
    status('Could not create the group: ' + e.message, true, true);
  }
};

document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
$('search').oninput = () => { state.focusIndex = -1; render(); };
$('otherFilter').onchange = render;

window.addEventListener('beforeunload', (e) => {
  if (state.people.some((p) => p.notes !== p.notesSaved)) e.preventDefault();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

start();
