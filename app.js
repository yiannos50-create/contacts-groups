'use strict';

// Contacts Groups: edits Google Contacts directly through the People API.
// Nothing about your contacts is stored by this app. Only the Client ID and
// the group name are kept in this browser's local storage.

const SCOPE = 'https://www.googleapis.com/auth/contacts';
const API = 'https://people.googleapis.com/v1';
const PERSON_FIELDS = 'names,phoneNumbers,emailAddresses,memberships,biographies';
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
  filterGroups: new Set(), // group ids picked in Other contacts ('none' = no group)
  filterMode: 'any',
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

// Group names match ignoring capitals, accents and spaces (ΕΞΟΜΟΛΟΓΗΣΗ = Εξομολόγηση).
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim()
  .toLocaleLowerCase('el').replace(/ς/g, 'σ');

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
    const want = fold(state.groupName);
    for (const grp of g.contactGroups || []) {
      if (grp.groupType !== 'USER_CONTACT_GROUP') continue;
      state.groups.set(grp.resourceName, grp.name);
      if (fold(grp.name) === want) state.groupRes = grp.resourceName;
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
  return setGroups(p, add ? [state.groupRes] : [], add ? [] : [state.groupRes]);
}

// Adds the contact to some groups and takes it out of others, then reloads it.
function setGroups(p, addTo, removeFrom) {
  return enqueue(p, async () => {
    for (const g of addTo) {
      await api(`/${g}/members:modify`, { method: 'POST', body: JSON.stringify({ resourceNamesToAdd: [p.id] }) });
    }
    for (const g of removeFrom) {
      await api(`/${g}/members:modify`, { method: 'POST', body: JSON.stringify({ resourceNamesToRemove: [p.id] }) });
    }
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

// Other contacts: with no group buttons picked, everyone not in the main group.
// With buttons picked, everyone in any (or all) of the picked groups.
function inTab(p, tab) {
  if (tab === 'group') return !!inGroup(p);
  const picked = [...state.filterGroups];
  if (!picked.length) return !inGroup(p) || state.justAdded.has(p.id);
  const has = (g) => (g === 'none' ? p.groupIds.length === 0 : p.groupIds.includes(g));
  return state.filterMode === 'all' ? picked.every(has) : picked.some(has);
}

// Search ignores capitals and accents; 3 or more digits also match phone numbers.
function matcher() {
  const raw = $('search').value.trim();
  if (!raw) return () => true;
  const q = fold(raw);
  const digits = raw.replace(/\D/g, '');
  return (p) => fold(p.name).includes(q) || fold(p.notes).includes(q) ||
    (digits.length >= 3 && p.phone.replace(/\D/g, '').includes(digits));
}

function visiblePeople() {
  const match = matcher();
  return state.people.filter((p) => inTab(p, state.tab) && match(p));
}

// While searching, say how many matches sit in the other tab.
function renderElsewhere() {
  const box = $('elsewhere');
  const other = state.tab === 'group' ? 'other' : 'group';
  const n = $('search').value.trim() ? state.people.filter((p) => !inTab(p, state.tab) && matcher()(p)).length : 0;
  box.hidden = n === 0;
  if (!n) return;
  const label = other === 'group' ? state.groupName : 'Other contacts';
  const b = el('button', 'ghost', `${n} more match${n === 1 ? '' : 'es'} in ${label} →`);
  b.onclick = () => { if (other === 'other') state.filterGroups.clear(); switchTab(other); };
  box.replaceChildren(b);
}

function fillOtherFilter() {
  for (const g of state.filterGroups) if (g !== 'none' && !state.groups.has(g)) state.filterGroups.delete(g);
  const groups = [...state.groups].sort((a, b) => a[1].localeCompare(b[1]));
  const chips = [['none', 'No group'], ...groups].map(([id, name]) => {
    const b = el('button', 'filter-chip', name);
    b.setAttribute('aria-pressed', state.filterGroups.has(id));
    b.onclick = () => {
      if (state.filterGroups.has(id)) state.filterGroups.delete(id); else state.filterGroups.add(id);
      fillOtherFilter();
      render();
    };
    return b;
  });
  $('groupFilter').replaceChildren(...chips);
  const n = state.filterGroups.size;
  $('filterMode').hidden = n < 2;
  $('filterClear').hidden = n === 0;
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
  if (!state.groupRes) {
    const picks = [...state.groups.values()].sort((a, b) => a.localeCompare(b)).map((name) => {
      const b = el('button', null, name);
      b.onclick = () => { state.groupName = name; store.set('groupName', name); loadAll(); };
      return b;
    });
    $('groupPicks').replaceChildren(...picks);
    $('groupPicksWrap').hidden = picks.length === 0;
  }
  $('groupFilterWrap').hidden = state.tab !== 'other';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  updateCounts();

  const list = $('list');
  const people = visiblePeople();
  const y = window.scrollY;
  list.replaceChildren(...people.map(rowFor));
  window.scrollTo(0, y);
  renderIndex();
  $('empty').hidden = people.length > 0 || state.people.length === 0;
  renderElsewhere();
  state.focusIndex = Math.min(state.focusIndex, people.length - 1);
  highlight();
}

function rowFor(p) {
  const li = el('li', 'row');
  li.dataset.id = p.id;
  li.dataset.letter = letterOf(p);

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
    updateCounts();
    // Change only this row, so the list stays where you were.
    if (!add && !inTab(p, state.tab)) { li.remove(); $('empty').hidden = $('list').children.length > 0; return; }
    const fresh = rowFor(p);
    li.replaceWith(fresh);
    if (add) fresh.querySelector('textarea')?.focus({ preventScroll: true });
  } catch (e) {
    box.checked = !add;
    box.disabled = false;
    status('Could not change the group: ' + e.message, true);
  }
}

// ---------- Delete ----------

async function deleteContact(p) {
  const who = p.name || p.phone || 'this contact';
  if (!confirm(`Delete ${who} from your Google Contacts?\n\nThis removes the whole contact, with its phone numbers and notes, on all your devices.`)) return;
  status('Deleting…', false, true);
  try {
    await enqueue(p, () => api(`/${p.id}:deleteContact`, { method: 'DELETE' }));
    state.people = state.people.filter((x) => x !== p);
    state.justAdded.delete(p.id);
    status(`Deleted ${who}.`);
    render();
  } catch (e) {
    status('Could not delete: ' + e.message, true, true);
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
  const boxes = [...state.groups].sort((a, b) => a[1].localeCompare(b[1]))
    .map(([id, name]) => groupBox(id, name, p.groupIds.includes(id)));
  $('newGroupName').value = '';
  $('editGroups').replaceChildren(...boxes);
  $('editDialog').showModal();
  $('editName').focus();
}

function groupBox(id, name, checked) {
  const lab = el('label', 'group-pick');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = id;
  box.checked = checked;
  lab.append(box, ' ' + name);
  return lab;
}

// Creates a new Google Contacts group and ticks it for the contact being edited.
async function addGroup() {
  const name = $('newGroupName').value.trim();
  if (!name) { $('newGroupName').focus(); return; }
  const existing = [...state.groups].find(([, n]) => fold(n) === fold(name));
  if (existing) {
    const box = $('editGroups').querySelector(`input[value="${existing[0]}"]`);
    if (box) box.checked = true;
    $('newGroupName').value = '';
    return;
  }
  $('newGroupBtn').disabled = true;
  try {
    const g = await api('/contactGroups', { method: 'POST', body: JSON.stringify({ contactGroup: { name } }) });
    state.groups.set(g.resourceName, g.name);
    $('editGroups').append(groupBox(g.resourceName, g.name, true));
    $('newGroupName').value = '';
    fillOtherFilter();
    status(`Created group ${g.name}. Tap Save to put this contact in it.`);
  } catch (e) {
    status('Could not create the group: ' + e.message, true, true);
  } finally {
    $('newGroupBtn').disabled = false;
  }
}

$('newGroupBtn').onclick = addGroup;
$('newGroupName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); addGroup(); }
});

$('editNoGroup').onclick = () => {
  $('editGroups').querySelectorAll('input').forEach((b) => (b.checked = false));
};

$('editForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('editDialog').close('save'); }
  // Plain Enter in a text box must not press the first button (Delete).
  else if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault();
});

$('editDialog').addEventListener('close', async () => {
  const p = editing; editing = null;
  if (!p) return;
  if ($('editDialog').returnValue === 'delete') { deleteContact(p); return; }
  if ($('editDialog').returnValue !== 'save') return;
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
  const picked = [...$('editGroups').querySelectorAll('input:checked')].map((b) => b.value);
  const addTo = picked.filter((g) => !p.groupIds.includes(g));
  const removeFrom = p.groupIds.filter((g) => !picked.includes(g));
  if (!Object.keys(changes).length && !addTo.length && !removeFrom.length) return;
  status('Saving…', false, true);
  try {
    if (addTo.length || removeFrom.length) await setGroups(p, addTo, removeFrom);
    if (Object.keys(changes).length) await updatePerson(p, changes);
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
    case 'Delete': if (p) deleteContact(p); break;
    default: return;
  }
  e.preventDefault();
});

// ---------- Send to PMIS ----------

// Saves the contacts on screen as a Google CSV file, the format PMIS's
// "Import Google contacts" reads. PMIS skips people it already has and turns
// the group names into PMIS groups.
const csvCell = (v) => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);

function pmisCsv(people) {
  const maxPhones = Math.max(1, ...people.map((p) => p.raw.phoneNumbers?.length || 0));
  const maxEmails = Math.max(1, ...people.map((p) => p.raw.emailAddresses?.length || 0));
  const head = ['Name', 'First Name', 'Middle Name', 'Last Name', 'Notes', 'Labels'];
  for (let i = 1; i <= maxPhones; i++) head.push(`Phone ${i} - Label`, `Phone ${i} - Value`);
  for (let i = 1; i <= maxEmails; i++) head.push(`E-mail ${i} - Label`, `E-mail ${i} - Value`);
  const rows = people.map((p) => {
    const n = p.raw.names?.[0] || {};
    const labels = p.groupIds.map((g) => state.groups.get(g)).filter(Boolean);
    const row = [p.name, n.givenName || '', n.middleName || '', n.familyName || '', p.notesSaved, labels.join(' ::: ')];
    for (let i = 0; i < maxPhones; i++) { const x = p.raw.phoneNumbers?.[i]; row.push(x?.formattedType || '', x?.value || ''); }
    for (let i = 0; i < maxEmails; i++) { const x = p.raw.emailAddresses?.[i]; row.push(x?.formattedType || '', x?.value || ''); }
    return row;
  });
  return '\ufeff' + [head, ...rows].map((r) => r.map((v) => csvCell(String(v))).join(',')).join('\r\n') + '\r\n';
}

function sendToPmis() {
  const people = visiblePeople().filter((p) => p.name); // PMIS skips contacts without a name
  if (!people.length) { status('No named contacts on screen to send.', true); return; }
  const where = state.tab === 'group' ? state.groupName : 'Other contacts';
  if (!confirm(`Save ${people.length} contact${people.length === 1 ? '' : 's'} from "${where}" for PMIS?\n\n` +
    'Then open PMIS, choose Import Google contacts and pick the saved file.\n' +
    'The file is not encrypted, so delete it from Downloads after importing.')) return;
  const blob = new Blob([pmisCsv(people)], { type: 'text/csv;charset=utf-8' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = `contacts-for-PMIS-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  status(`Saved ${people.length} contacts for PMIS. Open PMIS → Import Google contacts.`, false, true);
}

$('pmisBtn').onclick = sendToPmis;

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

// ---------- Letter bar (like the phone's Contacts app) ----------

function letterOf(p) {
  const c = fold(p.name || '').charAt(0);
  return /\p{L}/u.test(c) ? c.toLocaleUpperCase('el') : '#';
}

function renderIndex() {
  const seen = [];
  for (const li of $('list').children) {
    if (!seen.includes(li.dataset.letter)) seen.push(li.dataset.letter);
  }
  const bar = $('azIndex');
  bar.replaceChildren(...seen.map((l) => el('span', null, l)));
  bar.hidden = seen.length < 2;
  document.body.classList.toggle('has-index', !bar.hidden);
}

function jumpTo(letter) {
  const row = [...$('list').children].find((li) => li.dataset.letter === letter);
  if (!row) return;
  const header = document.querySelector('.topbar').offsetHeight;
  window.scrollTo(0, row.getBoundingClientRect().top + window.scrollY - header - 8);
  const bubble = $('azBubble');
  bubble.textContent = letter;
  bubble.hidden = false;
  clearTimeout(jumpTo.t);
  jumpTo.t = setTimeout(() => (bubble.hidden = true), 600);
}

// Tap a letter, or slide a finger along the bar.
function indexPointer(e) {
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (hit?.parentElement === $('azIndex')) jumpTo(hit.textContent);
}
$('azIndex').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  $('azIndex').setPointerCapture(e.pointerId);
  indexPointer(e);
});
$('azIndex').addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') indexPointer(e); });

// Back-to-top arrow appears once you have scrolled down a screen.
window.addEventListener('scroll', () => { $('toTop').hidden = window.scrollY < window.innerHeight; }, { passive: true });
$('toTop').onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
$('search').oninput = () => { state.focusIndex = -1; render(); };
$('filterMode').onchange = () => { state.filterMode = $('filterMode').value; render(); };
$('filterClear').onclick = () => { state.filterGroups.clear(); fillOtherFilter(); render(); };

window.addEventListener('beforeunload', (e) => {
  if (state.people.some((p) => p.notes !== p.notesSaved)) e.preventDefault();
});

if ('serviceWorker' in navigator) {
  // When an update arrives, reload once so the new version is used straight away.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
}

start();
