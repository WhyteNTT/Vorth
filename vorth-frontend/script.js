/* =========================================================
   VORTH — API-backed frontend
   ========================================================= */

/* Escaping / URL-allowlist helpers from lib/safe.js. */
const Safe = window.VorthSafe;
if (!Safe) {
  throw new Error('lib/safe.js failed to load — refusing to render unescaped content.');
}

/*
 * Resolve the API base.
 *
 * Same-origin by default, because that is what the deployment actually is: the
 * backend mounts this frontend statically (see app.js), so the page and /api
 * share an origin and need no CORS or CSP exception at all.
 *
 * Earlier versions tried to work out "is the backend serving me?" from the
 * hostname plus whether the port was literally 5000. That is wrong on any other
 * port - a platform-assigned one, or PORT=xxxx locally - and the page then aimed
 * at http://localhost:5000/api. Being cross-origin, every request was refused by
 * connect-src and the application sat there inert while reporting no error of its
 * own. There was also a hardcoded third-party origin that could never be correct
 * for anyone else's deployment.
 *
 * Same-origin needs no configuration. The split case (serving these files from a
 * separate static server in development) is covered by ?api=... , and a request
 * that fails at the network level on a local host additionally retries once
 * against the local API port.
 */
const LOCAL_API_FALLBACK = 'http://localhost:5000/api';
const isLocalHost = () => ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);

function resolveApiBase(){
  const explicit = window.VORTH_API_BASE;
  if(explicit) return String(explicit).replace(/\/$/, '');
  const override = new URLSearchParams(window.location.search).get('api');
  if(override) return override.replace(/\/$/, '');
  return `${window.location.origin}/api`;
}

let apiBase = resolveApiBase();
// Set once a same-origin request has proven the API is not on this origin.
let apiBaseIsSplit = false;

const TOKEN_STORAGE_KEY = 'vorth_token';
const GENRES = ['Fantasy','Romance','Sci-Fi','Horror','Mystery','Action','Drama','Isekai','Slice of Life'];
const GLYPH = { Fantasy:'⚔', Romance:'❦', 'Sci-Fi':'✦', Horror:'☠', Mystery:'✧', Action:'⚡', Drama:'❂', Isekai:'☾', 'Slice of Life':'❈' };
const GRADIENTS = [
  ['#5b21b6','#c026d3'], ['#4c1d95','#a78bfa'], ['#3f1f7a','#e879f9'],
  ['#1b0f38','#8b5cf6'], ['#6d28d9','#f5d485'], ['#2e1065','#c9b3ff'],
  ['#581c87','#f0abfc'], ['#4a1d78','#93c5fd']
];
const state = {
  token: localStorage.getItem(TOKEN_STORAGE_KEY) || '',
  profile: null,
  catalog: [],
  seriesMap: {},
  detailCache: {},
  chapterCache: {},
  commentsCache: {},
  libraryIds: [],
  librarySeries: [],
  ownedSeries: [],
  downloadItems: [],
  progressEntries: [],
  progressMap: {},
  notifications: [],
  unreadNotifications: 0,
  /* Accepted DMCA takedowns against this publisher's own content. */
  dmcaTakedowns: [],
  /* The takedown the counter-notice form is currently open for. */
  activeCounterNotice: null,
  /* Guards the profile view's own refresh against overlapping calls. */
  profileRefreshing: false,
  currentDetailId: null,
  currentReader: null,
  rankRange: 'daily',
  browseFilters: { type:'all', genre:'all', status:'all', sort:'popular', tag:null, query:'' },
  libraryTab: 'saved',
  novelSettings: { theme:'dark', font:'serif', size:18, lineHeight:1.7, width:680 },
  comicSettings: { mode:'paginated', zoom:100, page:0 },
  authMode: 'login',
  progressSaveTimer: null,
  signupProfileImage: null
};
function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return [...root.querySelectorAll(sel)]; }
function fmtViews(n){ if(n>=1000000) return (n/1000000).toFixed(1)+'M'; if(n>=1000) return (n/1000).toFixed(1)+'K'; return String(n); }
const escapeHtml = (str)=> Safe.escapeHtml(str);
function hash(str){ let h=0; for(let i=0;i<str.length;i++){ h = (h<<5)-h + str.charCodeAt(i); h|=0; } return Math.abs(h); }
function coverGradient(seed){ const g = GRADIENTS[hash(String(seed))%GRADIENTS.length]; return `linear-gradient(150deg, ${g[0]}, ${g[1]})`; }
let ORIGIN = apiBase.replace(/\/api$/, '');
function mediaUrl(value){ return Safe.resolveMediaUrl(value, ORIGIN); }
/* Artwork is applied through the CSSOM after insertion (see applyArtwork),
   never interpolated into an HTML attribute — that was the stored-XSS sink. */
function coverAttr(series){ const url = Safe.resolveMediaUrl(series.coverImage, ORIGIN); return url ? ` data-cover="${escapeHtml(url)}"` : ''; }
function applyArtwork(root){ return Safe.applyCovers(root || document, ORIGIN); }
function normalizeSeries(series){ if(!series) return null; const item = { ...series, id: series.id || series._id || series.slug, _id: series._id || series.id || series.slug }; if(item.owner && typeof item.owner === 'object'){ item.owner = { ...item.owner, id: item.owner.id || item.owner._id, _id: item.owner._id || item.owner.id }; } if(!item.genres) item.genres=[]; if(!item.tags) item.tags=[]; if(!item.views) item.views = { daily:0, weekly:0, alltime:0 }; if(!item.chapters) item.chapters=[]; return item; }
function normalizeChapter(ch){ if(!ch) return null; return { ...ch, id: ch.id || ch._id, _id: ch._id || ch.id }; }
function normalizeComment(comment){ if(!comment) return null; return { ...comment, id: comment.id || comment._id, _id: comment._id || comment.id, user: comment.user && typeof comment.user==='object' ? { ...comment.user, id: comment.user.id || comment.user._id, _id: comment.user._id || comment.user.id } : comment.user }; }
function normalizeProgress(entry){ if(!entry) return null; const item = { ...entry, id: entry.id || entry._id, _id: entry._id || entry.id }; /* Run the embedded documents through their own normalisers so partial projections (title/type/coverImage only) still get genres/tags/views defaults. */ if(item.series && typeof item.series === 'object'){ item.series = normalizeSeries(item.series); } if(item.chapter && typeof item.chapter === 'object'){ item.chapter = normalizeChapter(item.chapter); } return item; }
function cacheSeries(items){ items.forEach(item=>{ const normalized = normalizeSeries(item); if(normalized) state.seriesMap[normalized.id] = normalized; }); }
function seriesById(id){ return state.seriesMap[id] || state.ownedSeries.find(s=>s.id===id) || null; }
function ownedById(id){ return state.ownedSeries.find(s=>s.id===id) || seriesById(id) || null; }
function starString(rating){ if(!rating) return '☆☆☆☆☆'; const full = Math.round(rating); return '★★★★★☆☆☆☆☆'.slice(5-full, 10-full); }
function avgRating(comments){ if(!comments || !comments.length) return 0; return comments.reduce((sum,c)=>sum + (c.rating || 0), 0)/comments.length; }
let toastTimer=null;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 2200); }
function getToken(){ return state.token || localStorage.getItem(TOKEN_STORAGE_KEY) || ''; }
/*
 * All API traffic goes through here.
 *
 * The long-lived credential is an httpOnly refresh cookie that this code can
 * never read, so XSS cannot exfiltrate a reusable session. When the short-lived
 * access token expires we swap it for a fresh one exactly once and replay the
 * original request, rather than bouncing the user to the sign-in form.
 */
let refreshInFlight = null;
function clearSession(){ storeToken(''); state.profile=null; state.libraryIds=[]; state.librarySeries=[]; state.ownedSeries=[]; state.downloadItems=[]; state.progressEntries=[]; state.progressMap={}; state.notifications=[]; state.unreadNotifications=0; /* Claims are the signed-in publisher's, and the form holds a takedown id from them, so signing out has to drop both. */ state.dmcaTakedowns=[]; state.activeCounterNotice=null; state.profileRefreshing=false; }
function storeToken(token){ state.token = token || ''; if(token) localStorage.setItem(TOKEN_STORAGE_KEY, token); else localStorage.removeItem(TOKEN_STORAGE_KEY); }
function refreshSession(){
  /* One in-flight refresh shared by all concurrent 401s: rotating twice would
     revoke the first new token and lock the user out. */
  if(!refreshInFlight){
    refreshInFlight = (async () => {
      try{
        const data = await apiFetch('/auth/refresh', { method:'POST', _retried:true });
        if(data.token){ storeToken(data.token); if(data.user) state.profile = data.user; return true; }
        return false;
      }catch(_){ clearSession(); return false; }
      finally{ refreshInFlight = null; }
    })();
  }
  return refreshInFlight;
}
/*
 * True when the response came from something that is not this application's
 * API: a static host answering for /api, a CDN 404, or a proxy error page.
 *
 * The API always speaks JSON, so a non-JSON error body, or one carrying a
 * hosting provider's marker, means nobody is serving the API here.
 */
/*
 * Turns a failed response into something a reader can act on.
 *
 * The wording lives in lib/apiError.js so it can be unit tested. Previously the
 * message was whatever the server put in the body: with no API reachable, the
 * front-end host answered for /api and visitors saw its error text verbatim,
 * including an internal request id.
 *
 * There is deliberately no toast here. Every caller already toasts err.message
 * in its own catch, so raising one here was immediately overwritten - the reader
 * saw the two swap places rather than either one properly.
 */
function apiErrorMessage(response, payload){
  return VorthApiError.apiErrorMessage(response.status, payload);
}

async function apiFetch(path, options={}){
  const buildUrl = (base) => path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  const url = buildUrl(apiBase);
  const headers = {};
  const token = getToken();
  if(token) headers.Authorization = `Bearer ${token}`;
  const body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  if(body && !isFormData){ headers['Content-Type'] = 'application/json'; }
  const send = (tok) => fetch(url, { ...options, headers:{ ...headers, ...(tok ? { Authorization:`Bearer ${tok}` } : {}), ...(options.headers || {}) }, credentials:'include', body: body && !isFormData ? JSON.stringify(body) : body });
  let response;
  try {
    response = await send(token);
  } catch (netErr) {
    /*
     * The page was served by something that is not the API - the separate
     * static-server development setup. Only retry when we are on a local host,
     * where that is the expected cause, and only once, so a genuinely
     * unreachable API does not turn into a retry storm.
     */
    if (!path.startsWith('http') && !apiBaseIsSplit && !options._splitRetried && isLocalHost()) {
      apiBaseIsSplit = true;
      apiBase = LOCAL_API_FALLBACK;
      ORIGIN = apiBase.replace(/\/api$/, '');
      try {
        response = await send(token);
      } catch (_) {
        throw netErr;
      }
    } else {
      throw netErr;
    }
  }
  /*
   * Refresh and replay on an expired access token.
   *
   * The guard must name the refresh endpoint exactly: a substring test such as
   * path.includes('/auth/') also matches /auth/me, /auth/logout and friends,
   * which silently disables recovery on precisely the endpoints that need it.
   */
  const isRefreshCall = /\/auth\/refresh\/?$/.test(path);
  if(response.status === 401 && !options._retried && !isRefreshCall){
    if(await refreshSession()) response = await send(getToken());
  }
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  if(text){
    if(contentType.includes('application/json') || text.trim().startsWith('{') || text.trim().startsWith('[')){
      try{ payload = JSON.parse(text); } catch{ payload = { message: text }; }
    } else {
      payload = text;
    }
  }
  if(!response.ok){
    throw new Error(apiErrorMessage(response, payload));
  }
  return payload ?? {};
}
function isSignedIn(){ return !!state.token && !!state.profile; }
async function loadCatalog(params={}){ try{ const query = new URLSearchParams({ ...params }); const data = await apiFetch(`/series${query.toString() ? `?${query.toString()}` : ''}`); const list = (data.series || []).map(normalizeSeries).filter(Boolean); cacheSeries(list); state.catalog = list; return list; } catch(err){ toast(err.message || 'Could not load catalog.'); return []; } }
async function loadSeriesDetail(seriesId){ if(state.detailCache[seriesId]) return state.detailCache[seriesId]; try{ const [detailRes, commentsRes] = await Promise.all([apiFetch(`/series/${seriesId}`), apiFetch(`/series/${seriesId}/comments`)]); const series = normalizeSeries(detailRes.series); const chapters = (detailRes.chapters || []).map(normalizeChapter).filter(Boolean); const comments = (commentsRes.comments || []).map(normalizeComment).filter(Boolean); state.detailCache[seriesId] = { series, chapters, comments, commentCount: detailRes.commentCount || comments.length }; if(series) cacheSeries([series]); state.commentsCache[seriesId] = comments; return state.detailCache[seriesId]; } catch(err){ toast(err.message || 'Could not load series details.'); return null; } }
async function loadChapter(chapterId){ if(state.chapterCache[chapterId]) return state.chapterCache[chapterId]; try{ const data = await apiFetch(`/chapters/${chapterId}`); const chapter = normalizeChapter(data.chapter); state.chapterCache[chapterId] = chapter; return chapter; } catch(err){ toast(err.message || 'Could not open chapter.'); return null; } }
async function loadAuthProfile(){ if(!state.token && !localStorage.getItem(TOKEN_STORAGE_KEY)) return null; try{ const data = await apiFetch('/auth/me'); state.profile = data.user || null; if(state.profile && !state.token) state.token = localStorage.getItem(TOKEN_STORAGE_KEY) || ''; return state.profile; } catch(err){ clearSession(); return null; } }
async function refreshUserData(){ if(!isSignedIn()) return; try{ const [libraryRes, downloadsRes, progressRes, notifRes, mineRes, dmcaRes] = await Promise.all([apiFetch('/library'), apiFetch('/library/downloads'), apiFetch('/progress'), apiFetch('/notifications'), apiFetch('/series/mine'), apiFetch('/dmca/mine').catch(() => ({ takedowns: [] }))]); /* The API returns populated documents, not bare ids, so these tabs no longer depend on what happens to be in state.seriesMap. */ state.librarySeries = (libraryRes.series || []).map(normalizeSeries).filter(Boolean); state.libraryIds = state.librarySeries.map(s=>s.id); state.downloadItems = (downloadsRes.downloads || []).map(item=>({ ...item, series: normalizeSeries(item.series), chapter: normalizeChapter(item.chapter) })).filter(item=>item.series && item.chapter); state.ownedSeries = (mineRes.series || []).map(normalizeSeries).filter(Boolean); state.progressEntries = (progressRes.progress || []).map(normalizeProgress).filter(Boolean).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)); state.progressMap = {}; state.progressEntries.forEach(entry=>{ if(entry.series) state.progressMap[entry.series.id] = entry; }); state.notifications = notifRes.notifications || []; state.unreadNotifications = notifRes.unreadCount || 0; state.dmcaTakedowns = dmcaRes.takedowns || []; } catch(err){ toast(err.message || 'Could not sync your account data.'); } }
async function signIn(identifier, password){ try{ const data = await apiFetch('/auth/login', { method:'POST', body:{ identifier, password } }); storeToken(data.token); if(data.user) state.profile = data.user; await loadAuthProfile(); await refreshUserData(); refreshAuthUI(); toast(`Welcome back, ${state.profile?.displayName || state.profile?.username || 'reader'}.`); return true; } catch(err){ toast(err.message || 'Sign-in failed.'); return false; } }
async function signUp(payload){ try{ const data = await apiFetch('/auth/register', { method:'POST', body: payload }); storeToken(data.token); if(data.user) state.profile = data.user; await loadAuthProfile(); await refreshUserData(); refreshAuthUI(); toast(`Welcome to Vorth, ${state.profile?.displayName || payload.displayName}.`); return true; } catch(err){ toast(err.message || 'Account creation failed.'); return false; } }
async function signOut(){ try{ await apiFetch('/auth/logout', { method:'POST' }); }catch(_){ /* the local session is cleared regardless */ } clearSession(); refreshAuthUI(); toast('Signed out.'); }
function updateNotifBadge(){ const b=$('#notifBadge'); b.textContent = state.unreadNotifications; b.dataset.zero = state.unreadNotifications===0 ? 'true':'false'; }
function showView(name){ $all('.view').forEach(v=> v.classList.toggle('active', v.dataset.view===name)); $all('.nav-item[data-view]').forEach(b=> b.classList.toggle('active', b.dataset.view===name)); window.scrollTo(0,0); closeMobileNav(); if(name==='home') renderHome(); if(name==='browse') renderBrowse(); if(name==='library') renderLibrary(); if(name==='profile') renderProfile(); if(name==='upload') renderUploadSeriesSelect(); }
function openMobileNav(){ $('#sidenav').classList.add('open'); $('#navScrim').classList.add('open'); }
function closeMobileNav(){ $('#sidenav').classList.remove('open'); $('#navScrim').classList.remove('open'); }
function openSearch(){ $('#searchOverlay').classList.add('open'); $('#searchInput').value=''; renderSuggest(''); setTimeout(()=>$('#searchInput').focus(), 50); closeMobileNav(); }
function closeSearch(){ $('#searchOverlay').classList.remove('open'); }
function toggleNotifs(){ $('#notifPanel').classList.contains('open') ? closeNotifs() : openNotifs(); }
function openNotifs(){ $('#notifPanel').classList.add('open'); $('#navScrim').classList.add('open'); renderNotifs(); closeMobileNav(); }
function closeNotifs(){ $('#notifPanel').classList.remove('open'); $('#navScrim').classList.remove('open'); }
function cardHtml(series){ const saved = state.libraryIds.includes(series.id); const rating = state.commentsCache[series.id] && state.commentsCache[series.id].length ? avgRating(state.commentsCache[series.id]) : 4.2; return `<div class="card" data-id="${escapeHtml(series.id)}"><div class="card-cover" style="background:${coverGradient(series.id)}"${coverAttr(series)}><span class="card-type-tag">${escapeHtml(series.type)}</span><button class="card-save ${saved?'saved':''}" data-save="${escapeHtml(series.id)}" title="Save to library">${saved?'✓':'+'}</button><span class="glyph">${GLYPH[(series.genres||[])[0]] || '✦'}</span>${escapeHtml(series.title)}</div><div class="card-body"><p class="card-title">${escapeHtml(series.title)}</p><div class="card-meta"><span class="stars">${starString(rating)}</span><span>${fmtViews(series.views?.weekly || 0)} wk</span></div></div></div>`; }
function wireCards(root){ applyArtwork(root); $all('.card', root).forEach(card=>{ card.addEventListener('click', e=>{ if(e.target.closest('[data-save]')) return; openDetail(card.dataset.id); }); }); $all('[data-save]', root).forEach(btn=>{ btn.addEventListener('click', async e=>{ e.stopPropagation(); await toggleLibrary(btn.dataset.save); btn.classList.toggle('saved', state.libraryIds.includes(btn.dataset.save)); btn.textContent = state.libraryIds.includes(btn.dataset.save) ? '✓' : '+'; }); }); }
async function toggleLibrary(seriesId){ if(!isSignedIn()){ toast('Please sign in to save series.'); showView('profile'); return; } const saved = state.libraryIds.includes(seriesId); try{ if(saved){ await apiFetch(`/library/${seriesId}`, { method:'DELETE' }); state.libraryIds = state.libraryIds.filter(id=>id!==seriesId); toast('Removed from library.'); } else{ await apiFetch(`/library/${seriesId}`, { method:'POST' }); state.libraryIds.push(seriesId); toast('Saved to library.'); } await refreshUserData(); } catch(err){ toast(err.message || 'Could not update library.'); } }
async function toggleDownload(seriesId, chapterId){ if(!isSignedIn()){ toast('Please sign in to save chapters offline.'); showView('profile'); return; } const exists = state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===chapterId); try{ if(exists){ await apiFetch(`/library/downloads/${chapterId}`, { method:'DELETE' }); state.downloadItems = state.downloadItems.filter(item=> (item.chapter?.id||item.chapter?._id)!==chapterId); toast('Offline download removed.'); } else{ await apiFetch('/library/downloads', { method:'POST', body:{ seriesId, chapterId } }); await refreshUserData(); toast('Chapter saved for offline reading.'); } } catch(err){ toast(err.message || 'Could not update downloads.'); } }
async function renderHome(){ const contRow = $('#continueRow'); const trendRow = $('#trendingRow'); const recGrid = $('#recommendedGrid'); const genreChips = $('#genreChips'); const catalog = await loadCatalog({ limit: 12, sort:'popular' }); contRow.innerHTML = state.progressEntries.length ? state.progressEntries.map(entry=>{ const s=normalizeSeries(entry.series); return s ? cardHtml(s) : ''; }).join('') : '<p class="empty-hint">Nothing in progress yet - open a title and start a chapter.</p>'; if(state.progressEntries.length) wireCards(contRow); const trending = [...catalog].sort((a,b)=>(b.views?.weekly||0)-(a.views?.weekly||0)).slice(0,8); trendRow.innerHTML = trending.map(s=>cardHtml(s)).join(''); wireCards(trendRow); renderRankings(); const rec = state.libraryIds.length ? catalog.filter(s=>!state.libraryIds.includes(s.id)).slice(0,8) : catalog.slice(0,8); recGrid.innerHTML = rec.map(s=>cardHtml(s)).join(''); wireCards(recGrid); genreChips.innerHTML = GENRES.map(g=>`<button class="chip" data-genre="${g}">${GLYPH[g]||''} ${g}</button>`).join(''); $all('.chip', genreChips).forEach(chip=> chip.addEventListener('click', ()=>{ state.browseFilters = {...state.browseFilters, genre: chip.dataset.genre}; showView('browse'); })); }
async function renderRankings(){ try{ const data = await apiFetch(`/series/rankings?range=${state.rankRange}`); const list = $('#rankList'); const ranked = (data.series || []).map(normalizeSeries).filter(Boolean); list.innerHTML = ranked.map((s,i)=>`<li class="rank-row" data-id="${escapeHtml(s.id)}"><span class="rank-num">${i+1}</span><span class="rank-thumb" style="background:${coverGradient(s.id)};border-radius:6px;"></span><span><div class="rank-title">${escapeHtml(s.title)}</div><div class="rank-tags">${(s.genres||[]).map(g=>escapeHtml(g)).join(' · ')}</div></span><span class="rank-views">${fmtViews(s.views?.[state.rankRange] || 0)} views</span></li>`).join(''); $all('.rank-row', list).forEach(row=> row.addEventListener('click', ()=> openDetail(row.dataset.id))); } catch(err){ toast(err.message || 'Could not load rankings.'); } }
async function renderBrowse(){ const grid = $('#browseGrid'); grid.innerHTML = '<p class="empty-hint">Loading…</p>'; populateGenreFilter(); $('#filterType').value = state.browseFilters.type; $('#filterGenre').value = state.browseFilters.genre; $('#filterStatus').value = state.browseFilters.status; $('#filterSort').value = state.browseFilters.sort; const tagBox = $('#browseTagChips'); const tags = [...new Set(state.catalog.flatMap(s=>s.tags || []))].slice(0,16); tagBox.innerHTML = tags.map(t=>`<button class="chip ${state.browseFilters.tag===t?'active':''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join(''); $all('.chip', tagBox).forEach(chip=> chip.addEventListener('click', ()=>{ state.browseFilters.tag = state.browseFilters.tag===chip.dataset.tag ? null : chip.dataset.tag; renderBrowse(); })); try{ const b=state.browseFilters; /* Drop unset filters instead of sending empty values — an empty `type=` is not the same as an absent one to the API. */ const params = { sort: b.sort || 'popular', page: 1, limit: 24 }; if(b.type && b.type !== 'all') params.type = b.type; if(b.genre && b.genre !== 'all') params.genre = b.genre; if(b.status && b.status !== 'all') params.status = b.status; if(b.tag) params.tag = b.tag; if(b.query) params.q = b.query; const data = await apiFetch(`/series?${new URLSearchParams(params).toString()}`); const seriesList = (data.series || []).map(normalizeSeries).filter(Boolean); cacheSeries(seriesList); $('#browseCount').textContent = `${seriesList.length} series found`; grid.innerHTML = seriesList.length ? seriesList.map(s=>cardHtml(s)).join('') : '<p class="empty-hint">Nothing matches those filters yet.</p>'; wireCards(grid); } catch(err){ grid.innerHTML = `<p class="empty-hint">${escapeHtml(err.message || 'Unable to load catalog.')}</p>`; } }
function populateGenreFilter(){ const sel=$('#filterGenre'); if(sel.children.length>1) return; GENRES.forEach(g=>{ const o=document.createElement('option'); o.value=g; o.textContent=g; sel.appendChild(o); }); }
async function renderSuggest(query){ const box=$('#searchSuggest'); if(!query.trim()){ box.innerHTML = '<p class="empty-hint">Search by title, creator, or tag.</p>'; return; } try{ const params = new URLSearchParams({ q: query, limit: '8', sort:'popular' }); const data = await apiFetch(`/series?${params.toString()}`); const results = (data.series || []).map(normalizeSeries).filter(Boolean); box.innerHTML = results.length ? results.map(s=>`<div class="suggest-row" data-id="${escapeHtml(s.id)}"><div class="suggest-thumb" style="background:${coverGradient(s.id)}"></div><span class="suggest-name">${escapeHtml(s.title)}</span><span class="suggest-type">${escapeHtml(s.type)}</span></div>`).join('') : '<p class="empty-hint">No matches. Try a different title, tag, or author.</p>'; $all('.suggest-row', box).forEach(row=> row.addEventListener('click', ()=>{ closeSearch(); openDetail(row.dataset.id); })); } catch(err){ box.innerHTML = `<p class="empty-hint">${escapeHtml(err.message || 'Search failed.')}</p>`; } }
async function openDetail(id){ state.currentDetailId=id; showView('detail'); await renderDetail(id); }
async function renderDetail(id){ const container=$('#detailContent'); container.innerHTML='<p class="empty-hint">Loading…</p>'; const detail=await loadSeriesDetail(id); if(!detail){ container.innerHTML='<p class="empty-hint">Series not found.</p>'; return; } const series=detail.series; const comments=detail.comments || []; const saved=state.libraryIds.includes(series.id); const progress=state.progressMap[series.id]; const hasChapters=detail.chapters.length > 0; const rating=comments.length ? avgRating(comments) : 4.2; container.innerHTML=`<div class="detail-hero"><div class="detail-cover" style="background:${coverGradient(series.id)}"${coverAttr(series)}>${escapeHtml(series.title)}</div><div class="detail-info"><span class="format-tag">${escapeHtml(series.type)} · ${escapeHtml(series.status)}</span><h1>${escapeHtml(series.title)}</h1><p class="detail-creators">By ${escapeHtml(series.author)}${series.artist ? ' · Art by '+escapeHtml(series.artist):''}</p><div class="detail-rating"><span class="stars">${starString(rating)}</span><span class="num">${rating.toFixed(1)} · ${comments.length} review${comments.length===1?'':'s'}</span></div><p class="detail-synopsis">${escapeHtml(series.synopsis || '')}</p><div class="detail-tags">${(series.genres||[]).map(g=>`<span class="chip">${GLYPH[g]||''} ${escapeHtml(g)}</span>`).join('')}${(series.tags||[]).map(t=>`<span class="chip">#${escapeHtml(t)}</span>`).join('')}</div><div class="detail-actions"><button class="btn btn-primary" id="detailReadBtn" ${hasChapters?'':'disabled'}>${!hasChapters ? 'No chapters yet' : (progress ? 'Continue reading' : 'Start reading')}</button><button class="btn btn-ghost" id="detailSaveBtn">${saved ? '✓ In library' : '+ Add to library'}</button></div></div></div><div class="section-row"><h2 class="section-title">Chapters</h2></div><ul class="chapter-list" id="detailChapterList"></ul><div class="reviews-block"><div class="section-row"><h2 class="section-title">Comments &amp; reviews</h2></div><p class="shared-note">Reviews here are visible to everyone who opens this page — like a real comment thread.</p><form class="review-form" id="reviewForm"><div class="star-input" id="reviewStars">${[1,2,3,4,5].map(n=>`<span data-v="${n}">★</span>`).join('')}</div><input type="text" id="reviewText" placeholder="Share your thoughts on this series…" required><button type="submit" class="btn btn-primary sm" style="align-self:flex-start;">Post review</button></form><div id="reviewList"></div></div>`; applyArtwork(container); const chList=$('#detailChapterList'); chList.innerHTML=detail.chapters.map(ch=>{ const downloaded=state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===ch.id); return `<li class="chapter-row" data-ch="${escapeHtml(ch.id)}"><div class="chapter-row-left"><span class="chapter-num">${String(ch.num).padStart(2,'0')}</span><span class="chapter-title">${escapeHtml(ch.title)}</span>${downloaded?'<span class="chapter-flag">⭳ offline</span>':''}</div><span class="chapter-date">${ch.createdAt ? new Date(ch.createdAt).toLocaleDateString() : ''}</span></li>`; }).join(''); $all('.chapter-row', chList).forEach(row=> row.addEventListener('click', ()=> openReader(series.id, row.dataset.ch))); $('#detailReadBtn').addEventListener('click', ()=>{ const first = detail.chapters[0]; if(first) openReader(series.id, progress?.chapter?.id || progress?.chapter?._id || progress?.chapterId || first.id); }); $('#detailSaveBtn').addEventListener('click', async ()=>{ await toggleLibrary(series.id); await renderDetail(id); }); let starVal=0; const starEls=$all('span', $('#reviewStars')); starEls.forEach(el=> el.addEventListener('click', ()=>{ starVal = +el.dataset.v; starEls.forEach(e=> e.classList.toggle('on', +e.dataset.v<=starVal)); })); renderReviewList(comments); $('#reviewForm').addEventListener('submit', async e=>{ e.preventDefault(); if(!isSignedIn()){ toast('Please sign in to leave a review.'); showView('profile'); return; } const text=$('#reviewText').value.trim(); if(!text || !starVal){ toast('Please choose a rating before posting.'); return; } try{ const data=await apiFetch(`/series/${id}/comments`, { method:'POST', body:{ rating: starVal, text } }); const nextComments=[normalizeComment(data.comment), ...comments]; state.commentsCache[id]=nextComments; state.detailCache[id].comments=nextComments; $('#reviewText').value=''; starVal=0; starEls.forEach(e=>e.classList.remove('on')); renderReviewList(nextComments); /* Refresh the header rating/count too, otherwise it keeps showing the pre-post values until reload. */ const r2=avgRating(nextComments); const rEl=document.querySelector('.detail-rating .stars'); const nEl=document.querySelector('.detail-rating .num'); if(rEl) rEl.innerHTML=starString(r2); if(nEl) nEl.textContent=r2.toFixed(1)+' \u00b7 '+nextComments.length+' review'+(nextComments.length===1?'':'s'); toast('Review posted.'); } catch(err){ if(err.message.includes('unauthorized') || err.message.includes('forbidden')){ toast('Please sign in to leave a review.'); showView('profile'); } else { toast(err.message || 'Could not post review.'); } } }); }
function renderReviewList(comments){ const box=$('#reviewList'); if(!comments.length){ box.innerHTML='<p class="empty-hint">No reviews yet — be the first to leave one.</p>'; return; } box.innerHTML = comments.map(c=>`<div class="review-item"><div class="review-top"><span class="review-user">${escapeHtml(c.user?.displayName || c.user?.username || 'Reader')}</span><span class="review-stars">${starString(c.rating)}</span><span class="review-date">${new Date(c.createdAt || Date.now()).toLocaleDateString()}</span></div><p class="review-text">${escapeHtml(c.text)}</p></div>`).join(''); }
async function openReader(seriesId, chapterId){ const series=seriesById(seriesId); if(!series){ toast('Series not found.'); return; } state.currentReader={ seriesId, chapterId }; if(series.type==='novel'){ showView('reader-novel'); $('#novelText').innerHTML='<p class="empty-hint">Loading…</p>'; } else { showView('reader-comic'); $('#comicPages').innerHTML='<p class="empty-hint">Loading…</p>'; } await loadSeriesDetail(seriesId); const info=state.detailCache[seriesId]; const chapter=await loadChapter(chapterId); if(!chapter) return; if(series.type==='novel') openNovelReader(series, chapter, info?.chapters || []); else openComicReader(series, chapter, info?.chapters || []); await saveProgress(seriesId, { chapterId, scrollPct: 0, page: 0, bookmarked: false, type: series.type }); }
function openNovelReader(series, chapter, chapters){ showView('reader-novel'); $('#novelSeriesTitle').textContent=series.title; $('#novelChapterTitle').textContent=`Ch. ${chapter.num} — ${chapter.title}`; $('#novelText').innerHTML=`<h3>${escapeHtml(chapter.title)}</h3>` + (chapter.paragraphs || []).map(p=>`<p>${escapeHtml(p)}</p>`).join(''); applyNovelSettings(); const jump=$('#novelChapterJump'); jump.innerHTML=chapters.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===chapter.id?'selected':''}>Ch. ${c.num} — ${c.title}</option>`).join(''); const idx=chapters.findIndex(c=>c.id===chapter.id); $('#novelPrevBtn').disabled = idx===0; $('#novelNextBtn').textContent = idx===chapters.length-1 ? 'End of series' : 'Next chapter →'; $('#novelNextBtn').disabled = idx===chapters.length-1; const prog=state.progressMap[series.id]; const body=$('#novelBody'); requestAnimationFrame(()=>{ if(prog?.chapter?.id===chapter.id && typeof prog.scrollPct==='number'){ body.scrollTop = prog.scrollPct * (body.scrollHeight - body.clientHeight); } else { body.scrollTop = 0; } updateNovelProgressBar(); }); const downloaded=state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===chapter.id); $('#novelDownloadBtn').textContent = downloaded ? '✓ Saved offline' : '⭳ Save chapter for offline'; }
function openComicReader(series, chapter, chapters){ showView('reader-comic'); $('#comicSeriesTitle').textContent=series.title; $('#comicChapterTitle').textContent=`Ch. ${chapter.num} — ${chapter.title}`; const prog=state.progressMap[series.id]; state.comicSettings.page=prog?.page || 0; renderComicPages(chapter); updateComicChrome(chapter); const jump=$('#comicChapterJump'); jump.innerHTML=chapters.map(c=>`<option value="${escapeHtml(c.id)}" ${c.id===chapter.id?'selected':''}>Ch. ${c.num} — ${c.title}</option>`).join(''); const idx=chapters.findIndex(c=>c.id===chapter.id); $('#comicPrevChBtn').disabled = idx===0; $('#comicNextChBtn').textContent = idx===chapters.length-1 ? 'End of series' : 'Next chapter →'; $('#comicNextChBtn').disabled = idx===chapters.length-1; const downloaded=state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===chapter.id); $('#comicDownloadBtn').textContent = downloaded ? '✓ Saved offline' : '⭳ Save chapter for offline'; }
function applyNovelSettings(){ const st=state.novelSettings; const body=$('#novelBody'); body.className='novel-body theme-'+st.theme; const text=$('#novelText'); const fontMap={serif:"'Georgia', 'Iowan Old Style', serif", sans:"'Manrope', sans-serif", mono:"'JetBrains Mono', monospace"}; text.style.fontFamily=fontMap[st.font]; text.style.fontSize=st.size+'px'; text.style.lineHeight=st.lineHeight; text.style.maxWidth=st.width+'px'; $('#novelFontSizeVal').textContent=st.size+'px'; $('#novelLineHeightVal').textContent=st.lineHeight; $('#novelWidthVal').textContent=st.width+'px'; }
function updateNovelProgressBar(){ const body=$('#novelBody'); const pct = body.scrollHeight <= body.clientHeight ? 1 : body.scrollTop / (body.scrollHeight - body.clientHeight); $('#novelProgressFill').style.width = Math.min(100, pct*100)+'%'; return pct; }
function renderComicPages(chapter){ const wrap=$('#comicPages'); wrap.classList.toggle('vertical', state.comicSettings.mode==='vertical'); const zoom=state.comicSettings.zoom/100; const baseW=380; const pages=Array.isArray(chapter.pages)?chapter.pages:[]; wrap.innerHTML=pages.map((seed,i)=>{ const url=Safe.resolveMediaUrl(seed, ORIGIN); return `<div class="comic-page" data-i="${i}" style="width:${baseW*zoom}px; height:${baseW*1.42*zoom}px; background:${comicPageColor(seed)};"${url?` data-cover="${escapeHtml(url)}"`:''}><div class="pg-loading" data-loading="${i}">loading page ${i+1}…</div><span style="position:relative; z-index:1;">Page ${i+1}</span></div>`; }).join(''); applyArtwork(wrap); $all('.pg-loading', wrap).forEach((el,i)=> setTimeout(()=>el.remove(), 180 + i*90)); if(state.comicSettings.mode==='paginated'){ $all('.comic-page', wrap).forEach(p=> p.style.display='none'); const cur=wrap.children[state.comicSettings.page]; if(cur) cur.style.display='flex'; } }
function comicPageColor(seed){ const g=GRADIENTS[hash(String(seed))%GRADIENTS.length]; return `linear-gradient(160deg, ${g[0]}, ${g[1]})`; }
function updateComicChrome(chapter){ $('#comicZoomVal').textContent = state.comicSettings.zoom+'%'; const total = chapter.pages?.length || 1; $('#comicPageIndicator').textContent = state.comicSettings.mode==='paginated' ? `Page ${state.comicSettings.page+1} / ${total}` : `${total} pages · scroll`; $('#comicProgressFill').style.width = Math.min(100, ((state.comicSettings.page+1)/total)*100)+'%'; $all('#comicModeControl button').forEach(b=>b.classList.toggle('active', b.dataset.mode===state.comicSettings.mode)); const arrows = state.comicSettings.mode==='paginated'; $('#comicPrevPageBtn').style.visibility = arrows ? 'visible':'hidden'; $('#comicNextPageBtn').style.visibility = arrows ? 'visible':'hidden'; }
function currentChapterObj(){ const r=state.currentReader; if(!r) return null; const series=seriesById(r.seriesId); if(!series) return null; return state.detailCache[r.seriesId]?.chapters.find(ch=>ch.id===r.chapterId) || null; }
function scheduleProgressSave(data){ clearTimeout(state.progressSaveTimer); state.progressSaveTimer = setTimeout(()=> saveProgress(state.currentReader?.seriesId, data), 700); }
async function saveProgress(seriesId, data){ if(!seriesId) return; const payload = { ...data, updatedAt: Date.now() }; if(state.currentReader && state.currentReader.seriesId===seriesId) state.progressMap[seriesId] = { ...(state.progressMap[seriesId] || {}), ...payload, series: { id: seriesId } }; if(!isSignedIn()) return; try{ const response = await apiFetch(`/progress/${seriesId}`, { method:'PUT', body: payload }); const progress = normalizeProgress(response.progress); if(progress){ const existing = state.progressEntries.filter(entry=> (entry.series?.id||entry.series?._id)!==seriesId); state.progressEntries = [progress, ...existing]; state.progressMap[seriesId] = progress; } } catch(err){ /* keep UI responsive */ } }
function renderLibrary(){ const grid=$('#libraryGrid'); if(!isSignedIn()){ grid.innerHTML='<p class="empty-hint">Sign in to sync your library, history, and downloads.</p>'; return; } /* Each tab renders from server data rather than state.seriesMap, which only ever held whatever the user happened to browse. */ let series=[]; if(state.libraryTab==='saved') series = state.librarySeries; if(state.libraryTab==='history') series = state.progressEntries.map(entry=> entry.series).filter(Boolean); if(state.libraryTab==='downloads') series = [...new Map(state.downloadItems.map(item=>[item.series.id, item.series])).values()]; if(!series.length){ const msg={saved:'Nothing saved yet. Tap the + on any cover to add it here.', history:'No reading history yet.', downloads:'No chapters saved for offline reading yet.'}[state.libraryTab]; grid.innerHTML=`<p class="empty-hint">${msg}</p>`; return; } grid.innerHTML = series.map(cardHtml).join(''); wireCards(grid); }
function refreshAuthUI(){ const signedIn = isSignedIn(); $('#navProfileLabel').textContent = signedIn ? (state.profile?.displayName || state.profile?.username || 'Profile').split(' ')[0] : 'Sign in'; $('#profileLoggedOut').classList.toggle('hidden', signedIn); $('#profileLoggedIn').classList.toggle('hidden', !signedIn); updateNotifBadge();
  /* The account panel (reset / verify) only makes sense while signed out. */
  const accountPanel = $('#accountPanel');
  if(accountPanel) accountPanel.classList.toggle('hidden', signedIn);
  if(!signedIn){ $('#profileName').textContent=''; $('#profileMeta').textContent=''; $('#profileStats').innerHTML=''; $('#profileHistoryGrid').innerHTML='<p class="empty-hint">Sign in to view your history.</p>'; return; } $('#profileName').textContent = state.profile?.displayName || state.profile?.username || 'Reader'; $('#profileMeta').textContent = `@${state.profile?.username || 'reader'} · ${state.profile?.email || 'active reader'}`; $('#profileAvatar').dataset.initial = (state.profile?.displayName || state.profile?.username || 'R').slice(0,1).toUpperCase(); $('#profileStats').innerHTML = `<div class="stat-pill"><div class="num">${state.libraryIds.length}</div><div class="label">Saved series</div></div><div class="stat-pill"><div class="num">${state.progressEntries.length}</div><div class="label">In progress</div></div><div class="stat-pill"><div class="num">${state.downloadItems.length}</div><div class="label">Offline chapters</div></div>`; const histSeries = state.progressEntries.map(entry=> entry.series).filter(Boolean); $('#profileHistoryGrid').innerHTML = histSeries.length ? histSeries.map(cardHtml).join('') : '<p class="empty-hint">No reading history yet.</p>'; wireCards($('#profileHistoryGrid'));
  /* Offer "resend verification" only while the address is unconfirmed. */
  const verifyBtn = $('#accountVerifyBtn');
  if(verifyBtn) verifyBtn.hidden = !!state.profile?.emailVerifiedAt; }

/* ------------------------------------------------------------------ *
 * DMCA counter-notices (17 U.S.C. 512(g)).
 *
 * Reached from the profile panel. The backend keys the counter-notice endpoint
 * on the takedown id, and nothing else in the product shows a publisher that
 * id, so this panel is the difference between the flow existing and being
 * usable.
 *
 * Everything rendered here was typed by an anonymous complainant and reaches a
 * *different* user than the one who wrote it, so every field goes through
 * escapeHtml. The work description is the one piece of third-party text in the
 * profile view and the most likely place for a stored-XSS regression to land.
 * ------------------------------------------------------------------ */

const claimDate = VorthClaims.claimDate;

function renderDmcaTakedowns(){
  const list = $('#dmcaTakedownList');
  if(!list) return;

  // Markup comes from lib/claims.js so the browser XSS test exercises the code
  // that ships, not a copy of it.
  list.innerHTML = VorthClaims.claimList(state.dmcaTakedowns);

  $all('[data-counter-notice]', list).forEach(btn => btn.addEventListener('click', () => {
    openCounterNotice(btn.dataset.counterNotice);
  }));
}

/**
 * Opens the form for one takedown.
 *
 * Prefills the identity fields from the signed-in profile, because retyping a
 * legal name and postal address into a perjury statement is a good way to get an
 * inconsistent one. Never prefills any of the three affirmations or the
 * signature: those are the publisher's to make, every time.
 */
function openCounterNotice(takedownId){
  const row = state.dmcaTakedowns.find(t => t.id === takedownId);
  if(!row) return;

  state.activeCounterNotice = row;
  const form = $('#counterNoticeForm');
  form.classList.remove('hidden');
  form.scrollIntoView({ block:'nearest' });

  const profile = state.profile || {};
  $('#cnName').value = profile.displayName || '';
  $('#cnEmail').value = profile.email || '';
  // No address on the profile, so this one has to be typed.
  $('#cnAddress').value = '';

  // 512(g)(3)(B): what was removed, and where it was. Pre-filled from the claim
  // because the publisher cannot know our internal ids, and edited by them.
  $('#cnMaterial').value = row.infringingUrlDescription
    ? row.infringingUrlDescription
    : (row.copyrightedWorkDescription || '');

  // Bare ids: $() takes a full selector, so prefixing here would build
  // "##cnGoodFaith" and throw.
  ['cnGoodFaith','cnJurisdiction','cnPerjury'].forEach(id => { $('#'+id).checked = false; });
  $('#cnSignature').value = '';
  $('#cnHint').textContent = '';
  $('#cnSubmit').disabled = false;
  $('#cnSubmit').textContent = 'Send counter-notice';

  $('#cnName').focus();
}

function closeCounterNotice(){
  state.activeCounterNotice = null;
  const form = $('#counterNoticeForm');
  if(form) form.classList.add('hidden');
}

async function submitCounterNotice(ev){
  ev.preventDefault();
  const row = state.activeCounterNotice;
  if(!row) return;

  const payload = {
    subscriberName: $('#cnName').value.trim(),
    subscriberEmail: $('#cnEmail').value.trim(),
    subscriberAddress: $('#cnAddress').value.trim(),
    identifiedMaterial: $('#cnMaterial').value.trim(),
    // Where it appeared. The material field is what the publisher identifies;
    // the location is what the claim gives us, and it is the best we have.
    materialLocation: row.infringingUrlDescription || row.originalWorkUrl || 'See the work identified above.',
    signature: $('#cnSignature').value.trim(),
    // Sent as strings because the checkboxes are the affirmation; the API
    // requires each to be explicitly true and will not infer it.
    goodFaithStatement: $('#cnGoodFaith').checked ? 'true' : 'false',
    perjuryStatement: $('#cnPerjury').checked ? 'true' : 'false',
    jurisdictionStatement: $('#cnJurisdiction').checked ? 'true' : 'false',
  };

  const submit = $('#cnSubmit');
  submit.disabled = true;
  submit.textContent = 'Sending\u2026';
  $('#cnHint').textContent = '';

  try{
    const res = await apiFetch('/dmca/' + encodeURIComponent(row.id) + '/counter-notice', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const deadline = res.responseDeadline ? claimDate(res.responseDeadline) : null;
    $('#cnHint').textContent = deadline
      ? 'Sent and forwarded to the copyright holder. They have until ' + deadline
        + ' to say they have filed a court action; after that the material may be restored.'
      : 'Sent and forwarded to the copyright holder.';
    closeCounterNotice();
    toast('Counter-notice sent.');
    await refreshUserData();
    renderDmcaTakedowns();
  }catch(err){
    // Surfaced in the form, not only as a toast: this is a legal filing, and the
    // publisher needs to read why it did not go through.
    $('#cnHint').textContent = err.message || 'Could not send the counter-notice.';
    submit.disabled = false;
    submit.textContent = 'Send counter-notice';
  }
}

function renderProfile(){
  refreshAuthUI();
  renderDmcaTakedowns();

  /*
   * The account panels are painted from state that is only filled on sign-in, so
   * anything that changed since is invisible until you reload: a copyright claim
   * accepted while you were reading, an unread notification, a chapter saved in
   * another tab. Opening your own account should mean "now", not "when I logged
   * in".
   *
   * Guarded so the repeated showView('profile') calls that follow a hash change
   * cannot pile up a fresh batch of requests each time.
   */
  if(!isSignedIn() || state.profileRefreshing) return;
  state.profileRefreshing = true;
  refreshUserData().then(() => {
    state.profileRefreshing = false;
    refreshAuthUI();
    renderDmcaTakedowns();
    updateNotifBadge();
  }).catch(() => { state.profileRefreshing = false; });
}
function renderNotifs(){ const list=$('#notifList'); list.innerHTML = state.notifications.length ? state.notifications.map(n=>`<div class="notif-item ${n.isRead?'read':'unread'}" data-id="${n._id || n.id}"><span class="notif-dot"></span><div><span class="notif-text">${escapeHtml(n.message || '')}</span><span class="notif-time">${new Date(n.createdAt).toLocaleString()}</span></div></div>`).join('') : '<p class="empty-hint">No notifications yet.</p>'; $all('.notif-item', list).forEach(item=> item.addEventListener('click', async ()=>{ const id=item.dataset.id; try{ await apiFetch(`/notifications/${id}/read`, { method:'PATCH' }); await refreshUserData(); renderNotifs(); } catch(err){ toast(err.message || 'Could not mark notification as read.'); } })); updateNotifBadge(); }
async function openLegalDoc(doc){ try{ const data = await apiFetch(`/legal/${doc}`); const content = typeof data === 'string' ? data : (data.markdown || data.content || ''); const win=window.open('', '_blank'); if(win){ win.document.write(`<pre style="white-space:pre-wrap;font-family:Manrope, sans-serif;padding:24px;">${escapeHtml(content)}</pre>`); win.document.title = `${doc} — Vorth`; } } catch(err){ toast(err.message || 'Could not open legal document.'); } }
/* DMCA counter-notice: the form only exists for a signed-in publisher. */
  $('#counterNoticeForm').addEventListener('submit', submitCounterNotice);
  $('#cnCancel').addEventListener('click', () => { closeCounterNotice(); renderDmcaTakedowns(); });
  $('#dmcaRefreshBtn').addEventListener('click', async () => {
    try{ await refreshUserData(); renderDmcaTakedowns(); toast('Copyright claims refreshed.'); }
    catch(err){ toast(err.message || 'Could not refresh copyright claims.'); }
  });
  $('#mobileMenuBtn').addEventListener('click', openMobileNav); $('#navCloseBtn').addEventListener('click', closeMobileNav); $('#navScrim').addEventListener('click', ()=>{ closeMobileNav(); closeSearch(); closeNotifs(); }); $all('button[data-view]').forEach(btn=> btn.addEventListener('click', ()=> showView(btn.dataset.view))); $('[data-action="search"]').addEventListener('click', openSearch); $('[data-action="notifications"]').addEventListener('click', toggleNotifs); $('#searchCloseBtn').addEventListener('click', closeSearch); $('#searchOverlay').addEventListener('click', e=>{ if(e.target.id==='searchOverlay') closeSearch(); }); $('#searchInput').addEventListener('input', e=> renderSuggest(e.target.value)); $('#searchInput').addEventListener('keydown', e=>{ if(e.key==='Enter'){ const first=$('.suggest-row', $('#searchSuggest')); if(first){ closeSearch(); openDetail(first.dataset.id); } } if(e.key==='Escape') closeSearch(); }); $('#notifMarkAllBtn').addEventListener('click', async ()=>{ try{ await apiFetch('/notifications/read-all', { method:'PATCH' }); await refreshUserData(); renderNotifs(); toast('All caught up.'); } catch(err){ toast(err.message || 'Could not mark notifications as read.'); } }); $('#notifCloseBtn').addEventListener('click', closeNotifs); $('#rankTabs').addEventListener('click', e=>{ const btn=e.target.closest('.tab'); if(!btn) return; $all('.tab', $('#rankTabs')).forEach(b=>b.classList.remove('active')); btn.classList.add('active'); state.rankRange = btn.dataset.range; renderRankings(); }); ['filterType','filterGenre','filterStatus','filterSort'].forEach(id=> $('#'+id).addEventListener('change', e=>{ const map={filterType:'type', filterGenre:'genre', filterStatus:'status', filterSort:'sort'}; state.browseFilters[map[id]] = e.target.value; renderBrowse(); })); $('#filterReset').addEventListener('click', ()=>{ state.browseFilters = { type:'all', genre:'all', status:'all', sort:'popular', tag:null, query:'' }; renderBrowse(); }); $('#authTabs').addEventListener('click', e=>{ const b=e.target.closest('.tab'); if(!b) return; $all('.tab', $('#authTabs')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); $('#loginForm').classList.toggle('hidden', b.dataset.auth!=='login'); $('#signupForm').classList.toggle('hidden', b.dataset.auth!=='signup'); state.authMode=b.dataset.auth; }); $('#signupPicTrigger').addEventListener('click', ()=> $('#signupPicInput').click()); $('#signupPicInput').addEventListener('change', e=>{ const file = e.target.files?.[0]; const preview=$('#signupPicPreview'); const name=$('#signupPicName'); if(!file){ preview.innerHTML=''; name.textContent='No image selected'; state.signupProfileImage=null; return; } const reader = new FileReader(); reader.onload = ()=>{ state.signupProfileImage = reader.result; const img=document.createElement('img'); img.alt='Selected profile preview'; img.src=reader.result; preview.replaceChildren(img); }; reader.readAsDataURL(file); name.textContent = file.name; }); $('#loginForm').addEventListener('submit', async e=>{ e.preventDefault(); const identifier=$('#loginIdentifier').value.trim(); const password=$('#loginPassword').value; if(!identifier || !password) return; await signIn(identifier, password); }); $('#signupForm').addEventListener('submit', async e=>{ e.preventDefault(); const displayName=$('#signupName').value.trim(); const username=$('#signupUsername').value.trim(); const email=$('#signupEmail').value.trim(); const password=$('#signupPassword').value; const confirm=$('#signupConfirmPassword').value; const agreed=$('#signupTerms').checked; const age=$('#signupAge').checked; if(!displayName || !username || !email || !password || !confirm){ toast('Please complete all fields.'); return; } if(password !== confirm){ toast('Passwords do not match.'); return; } if(!agreed || !age){ toast('Both legal checkboxes must be accepted to create an account.'); return; } const ok = await signUp({ displayName, username, email, password, agreedToTerms: 'true', ageConfirmed: 'true' }); if(ok){ $('#signupForm').reset(); $('#signupPicPreview').innerHTML=''; $('#signupPicName').textContent='No image selected'; $('#signupPicInput').value=''; state.signupProfileImage = null; } }); $('#logoutBtn').addEventListener('click', async ()=>{ await signOut(); }); $all('[data-legal]').forEach(link=> link.addEventListener('click', e=>{ e.preventDefault(); openLegalDoc(link.dataset.legal); })); $('#novelBody').addEventListener('scroll', ()=>{ const pct = updateNovelProgressBar(); if(state.currentReader) scheduleProgressSave({ chapterId: state.currentReader.chapterId, scrollPct: pct, bookmarked:false, type:'novel' }); }); $('#novelBackBtn').addEventListener('click', ()=> openDetail(state.currentReader?.seriesId)); $('#novelSettingsBtn').addEventListener('click', ()=> $('#novelSettings').classList.toggle('open')); $('#novelBookmarkBtn').addEventListener('click', async ()=>{ if(!state.currentReader) return; const pct = updateNovelProgressBar(); await saveProgress(state.currentReader.seriesId, { chapterId: state.currentReader.chapterId, scrollPct: pct, bookmarked:true, type:'novel' }); toast('Reading spot bookmarked.'); }); $('#novelDownloadBtn').addEventListener('click', async ()=>{ if(!state.currentReader) return; await toggleDownload(state.currentReader.seriesId, state.currentReader.chapterId); $('#novelDownloadBtn').textContent = state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===state.currentReader.chapterId) ? '✓ Saved offline' : '⭳ Save chapter for offline'; }); $('#novelThemeControl').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $all('button', $('#novelThemeControl')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.novelSettings.theme=b.dataset.theme; applyNovelSettings(); }); $('#novelFontControl').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $all('button', $('#novelFontControl')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.novelSettings.font=b.dataset.font; applyNovelSettings(); }); $('#novelFontSize').addEventListener('input', e=>{ state.novelSettings.size=+e.target.value; applyNovelSettings(); }); $('#novelLineHeight').addEventListener('input', e=>{ state.novelSettings.lineHeight=(+e.target.value/10).toFixed(1); applyNovelSettings(); }); $('#novelWidth').addEventListener('input', e=>{ state.novelSettings.width=+e.target.value; applyNovelSettings(); }); $('#novelPrevBtn').addEventListener('click', ()=>{ const r=state.currentReader; if(!r) return; const chapters=state.detailCache[r.seriesId]?.chapters || []; const idx=chapters.findIndex(ch=>ch.id===r.chapterId); const next=chapters[idx-1]; if(next) openReader(r.seriesId, next.id); }); $('#novelNextBtn').addEventListener('click', ()=>{ const r=state.currentReader; if(!r) return; const chapters=state.detailCache[r.seriesId]?.chapters || []; const idx=chapters.findIndex(ch=>ch.id===r.chapterId); const next=chapters[idx+1]; if(next) openReader(r.seriesId, next.id); }); $('#novelChapterJump').addEventListener('change', e=>{ const r=state.currentReader; if(r) openReader(r.seriesId, e.target.value); }); $('#comicBackBtn').addEventListener('click', ()=> openDetail(state.currentReader?.seriesId)); $('#comicModeControl').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; state.comicSettings.mode=b.dataset.mode; const ch=currentChapterObj(); if(ch){ renderComicPages(ch); updateComicChrome(ch); } }); $('#comicZoomIn').addEventListener('click', ()=>{ state.comicSettings.zoom=Math.min(200, state.comicSettings.zoom+20); const ch=currentChapterObj(); if(ch){ renderComicPages(ch); updateComicChrome(ch); } }); $('#comicZoomOut').addEventListener('click', ()=>{ state.comicSettings.zoom=Math.max(40, state.comicSettings.zoom-20); const ch=currentChapterObj(); if(ch){ renderComicPages(ch); updateComicChrome(ch); } }); $('#comicPrevPageBtn').addEventListener('click', ()=>{ const ch=currentChapterObj(); if(!ch) return; const next=state.comicSettings.page-1; if(next>=0){ state.comicSettings.page=next; renderComicPages(ch); updateComicChrome(ch); scheduleProgressSave({ chapterId: state.currentReader.chapterId, page: next, type:'comic' }); } }); $('#comicNextPageBtn').addEventListener('click', ()=>{ const ch=currentChapterObj(); if(!ch) return; const next=state.comicSettings.page+1; if(next < (ch.pages||[]).length){ state.comicSettings.page=next; renderComicPages(ch); updateComicChrome(ch); scheduleProgressSave({ chapterId: state.currentReader.chapterId, page: next, type:'comic' }); } }); $('#comicPrevChBtn').addEventListener('click', ()=>{ const r=state.currentReader; if(!r) return; const chapters=state.detailCache[r.seriesId]?.chapters || []; const idx=chapters.findIndex(ch=>ch.id===r.chapterId); const next=chapters[idx-1]; if(next) openReader(r.seriesId, next.id); }); $('#comicNextChBtn').addEventListener('click', ()=>{ const r=state.currentReader; if(!r) return; const chapters=state.detailCache[r.seriesId]?.chapters || []; const idx=chapters.findIndex(ch=>ch.id===r.chapterId); const next=chapters[idx+1]; if(next) openReader(r.seriesId, next.id); }); $('#comicChapterJump').addEventListener('change', e=>{ const r=state.currentReader; if(r) openReader(r.seriesId, e.target.value); }); $('#comicDownloadBtn').addEventListener('click', async ()=>{ if(!state.currentReader) return; await toggleDownload(state.currentReader.seriesId, state.currentReader.chapterId); $('#comicDownloadBtn').textContent = state.downloadItems.some(item=> (item.chapter?.id||item.chapter?._id)===state.currentReader.chapterId) ? '✓ Saved offline' : '⭳ Save chapter for offline'; }); $('#libraryTabs').addEventListener('click', e=>{ const b=e.target.closest('.tab'); if(!b) return; $all('.tab', $('#libraryTabs')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); state.libraryTab = b.dataset.lib; renderLibrary(); }); $('#uploadTabs').addEventListener('click', e=>{ const b=e.target.closest('.tab'); if(!b) return; $all('.tab', $('#uploadTabs')).forEach(x=>x.classList.remove('active')); b.classList.add('active'); $('#seriesForm').classList.toggle('hidden', b.dataset.upload!=='series'); $('#chapterForm').classList.toggle('hidden', b.dataset.upload!=='chapter'); }); $('#coverInput').addEventListener('change', e=>{ const file=e.target.files && e.target.files[0]; if(!file) return; const reader=new FileReader(); reader.onload=()=>{ $('#coverInput').dataset.coverData=reader.result; $('#coverDrop').style.backgroundImage=`linear-gradient(180deg, rgba(7,3,18,.12), rgba(7,3,18,.45)), url("${Safe.escapeCssUrl(reader.result)}")`; $('#coverDrop').style.backgroundSize='cover'; $('#coverDrop').style.backgroundPosition='center'; $('#coverDrop').style.color='#fff'; $('#coverDropTitle').textContent=$('#upTitle').value.trim() || file.name.replace(/\.[^/.]+$/, ''); toast('Cover image selected.'); }; reader.readAsDataURL(file); }); $('#coverDrop').addEventListener('keydown', e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); $('#coverInput').click(); } }); $('#upTitle').addEventListener('input', ()=>{ $('#coverDropTitle').textContent = $('#upTitle').value.trim() || 'Book cover preview'; }); $('#upType').addEventListener('change', ()=>{ toggleChapterFormFields(); }); $('#seriesForm').addEventListener('submit', async e=>{ e.preventDefault(); if(!isSignedIn()){ toast('Please sign in to publish a series.'); showView('profile'); return; } const title=$('#upTitle').value.trim(); const type=$('#upType').value; const status=$('#upStatus').value; const author=$('#upAuthor').value.trim(); const artist=$('#upArtist').value.trim() || null; const genres=$('#upGenres').value.split(',').map(s=>s.trim()).filter(Boolean); const tags=$('#upTags').value.split(',').map(s=>s.trim()).filter(Boolean); const synopsis=$('#upSynopsis').value.trim(); const rightsAttested=$('#upRightsAttested').checked; if(!title || !author || !synopsis || !rightsAttested){ toast('Please complete the required fields and confirm you own the rights to this work.'); return; } try{ let coverImage = null; const file=$('#coverInput').files && $('#coverInput').files[0]; if(file){ const form=new FormData(); form.append('cover', file); const uploadRes=await apiFetch('/uploads/cover', { method:'POST', body: form }); coverImage=uploadRes.path || null; } const data=await apiFetch('/series', { method:'POST', body:{ title, type, author, artist, genres, tags, status, synopsis, coverImage, rightsAttested: 'true' } }); const created=normalizeSeries(data.series); if(created){ cacheSeries([created]); state.catalog.unshift(created); } e.target.reset(); $('#coverInput').value=''; $('#coverDrop').style.background=''; $('#coverDrop').style.color=''; $('#coverDropTitle').textContent='Book cover preview'; $('#seriesFormHint').textContent=`"${title}" is live in the catalog.`; $('#seriesFormHint').className='form-hint ok'; toast('Series published.'); /* Re-sync so /series/mine includes the new series immediately, otherwise the 'Add chapter' picker stays empty until the next sign-in. */ await refreshUserData(); renderUploadSeriesSelect(); } catch(err){ toast(err.message || 'Could not publish series.'); } }); $('.upload-file-trigger').addEventListener('click', e=>{ e.preventDefault(); $('#upChapterPagesInput').click(); }); $('#upChapterPagesInput').addEventListener('change', e=>{ const files=e.target.files ? [...e.target.files] : []; $('#upChapterPdfName').textContent = files.length ? `${files.length} file${files.length>1?'s':''} selected` : 'No files selected'; }); $('#chapterForm').addEventListener('submit', async e=>{ e.preventDefault(); if(!isSignedIn()){ toast('Please sign in to publish a chapter.'); showView('profile'); return; } const seriesId=$('#upSeriesSelect').value; const series=ownedById(seriesId); if(!series){ toast('Choose a series to add a chapter to.'); return; } const title=$('#upChapterTitle').value.trim(); if(!title) return; try{ if(series.type==='novel'){ const paragraphs=$('#upChapterParagraphs').value.split(/\n\s*\n+/).map(p=>p.trim()).filter(Boolean); if(!paragraphs.length){ toast('Please add at least one paragraph of novel content.'); return; } await apiFetch(`/series/${seriesId}/chapters`, { method:'POST', body:{ title, paragraphs } }); $('#chapterFormHint').textContent=`Chapter published to ${series.title}.`; $('#chapterFormHint').className='form-hint ok'; toast('Chapter published.'); } else { const files=$('#upChapterPagesInput').files ? [...$('#upChapterPagesInput').files] : []; if(!files.length){ toast('Please upload at least one page image for comic chapters.'); return; } const form=new FormData(); files.forEach(file=>form.append('pages', file)); const uploadRes=await apiFetch('/uploads/pages', { method:'POST', body: form }); await apiFetch(`/series/${seriesId}/chapters`, { method:'POST', body:{ title, pages: uploadRes.paths || [] } }); $('#chapterFormHint').textContent=`Chapter published to ${series.title}.`; $('#chapterFormHint').className='form-hint ok'; toast('Chapter published.'); } e.target.reset(); $('#upChapterPagesInput').value=''; $('#upChapterPdfName').textContent='No files selected'; } catch(err){ toast(err.message || 'Could not publish chapter.'); } }); function toggleChapterFormFields(){ const seriesId=$('#upSeriesSelect').value; const series=ownedById(seriesId); const isComic = series && series.type==='comic'; $('#upChapterParagraphsWrap').classList.toggle('hidden', isComic); $('#upChapterPagesWrap').classList.toggle('hidden', !isComic); }
function renderUploadSeriesSelect(){ const sel=$('#upSeriesSelect'); const owned = state.ownedSeries; sel.innerHTML = owned.length ? owned.map(s=>`<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)}</option>`).join('') : '<option value="">No owned series yet</option>'; toggleChapterFormFields(); }
/* ---------- account: password reset + email verification ---------- */
function readQueryToken(key){ return new URLSearchParams(window.location.search).get(key) || ''; }
function openForgotForm(){ $('#resetForm').classList.add('hidden'); $('#verifyForm').classList.add('hidden'); $('#forgotForm').classList.remove('hidden'); $('#forgotHint').textContent=''; showView('profile'); }
function openResetForm(token){ $('#forgotForm').classList.add('hidden'); $('#verifyForm').classList.add('hidden'); $('#resetForm').classList.remove('hidden'); $('#resetForm').dataset.token = token || ''; $('#resetHint').textContent = token ? '' : 'Paste the token from your reset email below.'; if(token) $('#resetPassword').focus(); showView('profile'); }
function openVerifyForm(token){ $('#forgotForm').classList.add('hidden'); $('#resetForm').classList.add('hidden'); $('#verifyForm').classList.remove('hidden'); $('#verifyForm').dataset.token = token || ''; if(token) $('#verifyHint').textContent = 'Confirming your email address…'; showView('profile'); }

function wireAccountForms(){
  $('#accountForgotBtn').addEventListener('click', openForgotForm);

  $('#forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#forgotEmail').value.trim();
    if(!email) return;
    const hint = $('#forgotHint');
    hint.textContent = 'Sending…';
    try{
      /* Always the same response either way: the endpoint never reveals
         whether an address is registered. */
      const data = await apiFetch('/auth/forgot-password', { method:'POST', body:{ email } });
      hint.textContent = data.message || 'If that address has an account, a reset link is on its way.';
      hint.className = 'form-hint ok';
    }catch(err){
      hint.textContent = err.message || 'Could not send the reset email.';
      hint.className = 'form-hint err';
    }
  });

  $('#resetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#resetForm').dataset.token || readQueryToken('token');
    const newPassword = $('#resetPassword').value;
    const confirm = $('#resetConfirm').value;
    const hint = $('#resetHint');
    if(!token){ hint.textContent = 'This form needs the token from your reset email.'; hint.className = 'form-hint err'; return; }
    if(newPassword.length < 8){ hint.textContent = 'Password must be at least 8 characters.'; hint.className = 'form-hint err'; return; }
    if(newPassword !== confirm){ hint.textContent = 'Passwords do not match.'; hint.className = 'form-hint err'; return; }
    try{
      const data = await apiFetch('/auth/reset-password', { method:'POST', body:{ token, newPassword } });
      hint.textContent = data.message || 'Password changed. You can sign in now.';
      hint.className = 'form-hint ok';
      $('#resetPassword').value = ''; $('#resetConfirm').value = '';
      clearSession(); refreshAuthUI();
    }catch(err){
      hint.textContent = err.message || 'Could not reset your password.';
      hint.className = 'form-hint err';
    }
  });

  $('#accountVerifyBtn').addEventListener('click', async () => {
    try{
      const data = await apiFetch('/auth/resend-verification', { method:'POST' });
      toast(data.message || 'Verification email sent.');
    }catch(err){ toast(err.message || 'Could not send the verification email.'); }
  });

  $('#verifyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#verifyForm').dataset.token || readQueryToken('token');
    const hint = $('#verifyHint');
    if(!token){ hint.textContent = 'This form needs the token from your verification email.'; hint.className = 'form-hint err'; return; }
    try{
      const data = await apiFetch('/auth/verify-email', { method:'POST', body:{ token } });
      hint.textContent = data.message || 'Your email address is verified.';
      hint.className = 'form-hint ok';
      await loadAuthProfile();
    }catch(err){
      hint.textContent = err.message || 'That verification link is not valid.';
      hint.className = 'form-hint err';
    }
  });
}

(function initSparkle(){ const canvas=document.getElementById('bg-sparkle'); const ctx=canvas.getContext('2d'); let w,h,particles=[]; function resize(){ w=canvas.width=window.innerWidth; h=canvas.height=window.innerHeight; } function spawn(){ particles = Array.from({length: Math.round((w*h)/38000)}, ()=>({ x: Math.random()*w, y: Math.random()*h, r: Math.random()*1.4+0.3, a: Math.random(), speed: Math.random()*0.006+0.002, drift:(Math.random()-0.5)*0.15 })); } resize(); spawn(); window.addEventListener('resize', ()=>{ resize(); spawn(); }); const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; function frame(){ ctx.clearRect(0,0,w,h); particles.forEach(p=>{ p.a += p.speed; p.x += p.drift; const alpha=(Math.sin(p.a)+1)/2 * 0.8; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle=`rgba(200,170,255,${alpha.toFixed(2)})`; ctx.fill(); }); if(!reduceMotion) requestAnimationFrame(frame); } requestAnimationFrame(frame); })();
async function init(){ populateGenreFilter(); wireAccountForms();
  /* Arriving from an emailed link: ?token=... opens the matching form. */
  const qToken = readQueryToken('token');
  if(qToken){ if(window.location.hash === '#reset' || qToken.length > 40) openResetForm(qToken); else openVerifyForm(qToken); }
  if(state.token || localStorage.getItem(TOKEN_STORAGE_KEY)){ await loadAuthProfile(); if(isSignedIn()) await refreshUserData(); }
  await loadCatalog({ limit: 24, sort:'popular' }); refreshAuthUI(); showView(qToken ? 'profile' : 'home'); renderUploadSeriesSelect(); }
init();
