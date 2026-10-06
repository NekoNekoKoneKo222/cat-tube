'use strict';
const view = document.querySelector('#view');
const notice = document.querySelector('#notice');
const state = { history: read('history', []), favorites: read('favorites', []), playlists: read('playlists', []), settings: read('settings', { autoplay: false }) };
function read(name, fallback) { try { return JSON.parse(localStorage.getItem('catTube:' + name)) || fallback; } catch { return fallback; } }
function save(name) { localStorage.setItem('catTube:' + name, JSON.stringify(state[name])); }
function setNotice(text) { notice.textContent = text || ''; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; }
function button(text, click, secondary = false) { const node = el('button', secondary ? 'secondary' : '', text); node.type = 'button'; node.addEventListener('click', click); return node; }
async function api(resource, params = {}) {
  const query = new URLSearchParams(params);
  const response = await fetch('/api/youtube/' + resource + '?' + query);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '取得に失敗しました');
  return data;
}
function card(item) {
  const id = item.id?.videoId || item.snippet?.resourceId?.videoId || item.id;
  const kind = item.id?.channelId ? 'channel' : item.id?.playlistId ? 'playlist' : 'watch';
  const link = el('a', 'video-card'); link.href = '#' + kind + '/' + encodeURIComponent(kind === 'channel' ? item.id.channelId : kind === 'playlist' ? item.id.playlistId : id);
  const img = el('img'); img.src = item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '';
  img.alt = ''; img.loading = 'lazy'; link.append(img);
  const body = el('div', 'body'); body.append(el('h3', '', item.snippet?.title || 'タイトルなし'), el('p', '', item.snippet?.channelTitle || '')); link.append(body);
  return link;
}
async function search(q, options = {}) {
  view.replaceChildren(el('h1', '', options.shorts ? 'Shorts' : '検索結果'));
  if (!options.shorts) {
    const tabs = el('div','tabs');
    for (const [label,type] of [['動画','video'],['チャンネル','channel'],['プレイリスト','playlist']]) tabs.append(button(label,()=>search(q,{type}),type!==options.type));
    view.append(tabs);
  }
  const grid = el('div', 'grid'); view.append(grid);
  try {
    const data = await api('search', { q, ...options });
    if (!data.items?.length) grid.append(el('p', 'muted', '結果がありません。'));
    else data.items.forEach(item => grid.append(card(item)));
    if (data.nextPageToken) view.append(button('もっと見る', async () => {
      try { const next = await api('search', { q, ...options, pageToken: data.nextPageToken }); next.items?.forEach(item => grid.append(card(item))); }
      catch (error) { setNotice(error.message); }
    }));
  } catch (error) { setNotice(error.message); }
}
async function channel(id) {
  view.replaceChildren(el('h1','','チャンネル'));
  try { const data=await api('channels',{id}); const item=data.items?.[0]; if(!item)throw new Error('チャンネルがありません');
    view.replaceChildren(el('h1','',item.snippet.title),el('p','muted',item.snippet.description||''),el('h2','','動画'));
    const grid=el('div','grid');view.append(grid);const videos=await api('search',{q:item.snippet.title,channelId:id});videos.items?.forEach(x=>grid.append(card(x)));
  } catch(error){setNotice(error.message);}
}
async function playlist(id) {
  view.replaceChildren(el('h1','','プレイリスト'));
  try { const data=await api('playlists',{id}); const item=data.items?.[0];if(!item)throw new Error('プレイリストがありません');
    view.replaceChildren(el('h1','',item.snippet.title),el('p','muted',item.snippet.description||''));
    const grid=el('div','grid');view.append(grid);const videos=await api('playlistItems',{id});videos.items?.forEach(x=>grid.append(card(x)));
  } catch(error){setNotice(error.message);}
}
async function watch(id) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return view.replaceChildren(el('p', '', '動画IDが不正です。'));
  const wrap = el('div', 'watch'), left = el('section'), right = el('aside', 'panel');
  const iframe = el('iframe', 'player'); iframe.title = '動画プレイヤー'; iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture'; iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin'; iframe.src = 'https://www.youtube-nocookie.com/embed/' + id;
  left.append(iframe); wrap.append(left, right); view.replaceChildren(wrap);
  try {
    const data = await api('videos', { id }); const video = data.items?.[0];
    if (!video) throw new Error('動画が見つかりません');
    left.append(el('h1', '', video.snippet.title), el('p', 'muted', video.snippet.channelTitle));
    const actions = el('div', 'actions');
    actions.append(button(state.favorites.some(x => x.id === id) ? 'お気に入り解除' : 'お気に入り追加', () => {
      state.favorites = state.favorites.some(x => x.id === id) ? state.favorites.filter(x => x.id !== id) : [{ id, title: video.snippet.title }, ...state.favorites]; save('favorites'); route();
    }));
    actions.append(button('プレイリストに追加', () => {
      const name = prompt('プレイリスト名'); if (!name?.trim()) return;
      let list = state.playlists.find(x => x.name === name.trim());
      if (!list) { list = { name: name.trim().slice(0, 60), videos: [] }; state.playlists.push(list); }
      if (!list.videos.some(x => x.id === id)) list.videos.push({ id, title: video.snippet.title });
      save('playlists'); setNotice('保存しました。');
    }, true));
    left.append(actions, el('p', '', video.snippet.description || ''));
    state.history = [{ id, title: video.snippet.title }, ...state.history.filter(x => x.id !== id)].slice(0, 1000); save('history');
    right.append(el('h2', '', '関連動画'));
    const related = await api('search', { q: video.snippet.title.split(/\s+/).slice(0, 4).join(' ') });
    related.items?.filter(x => x.id?.videoId !== id).slice(0, 8).forEach(x => right.append(card(x)));
  } catch (error) { setNotice(error.message); }
}
function library() {
  view.replaceChildren(el('h1', '', 'ライブラリ'));
  const tabs = el('div', 'tabs'); view.append(tabs);
  const content = el('div', 'panel'); view.append(content);
  for (const [label, key] of [['履歴', 'history'], ['お気に入り', 'favorites'], ['プレイリスト', 'playlists']]) {
    tabs.append(button(label, () => {
      tabs.querySelectorAll('button').forEach(b => b.classList.remove('active')); tabs.querySelectorAll('button').forEach(b => { if (b.textContent === label) b.classList.add('active'); });
      content.replaceChildren();
      if (!state[key].length) content.append(el('p', 'muted', 'まだ項目がありません。'));
      state[key].forEach(item => {
        const row = el('div', 'row');
        const link = el('a', '', item.title || item.name); link.href = key === 'playlists' ? '#local-playlist/' + encodeURIComponent(item.name) : '#watch/' + item.id;
        row.append(link); if (key !== 'playlists') row.append(button('削除', () => { state[key] = state[key].filter(x => x.id !== item.id); save(key); library(); }, true)); content.append(row);
      });
    }, true));
  }
  tabs.firstChild.click();
}
function localPlaylist(name) {
  const list = state.playlists.find(x => x.name === name);
  view.replaceChildren(el('h1', '', name));
  if (!list) return view.append(el('p', '', 'プレイリストがありません。'));
  list.videos.forEach(item => { const row = el('div', 'row'); const a = el('a', '', item.title); a.href = '#watch/' + item.id; row.append(a); view.append(row); });
}
function settings() {
  view.replaceChildren(el('h1', '', '設定'));
  const panel = el('div', 'panel'), label = el('label', 'field', '次の動画を自動再生');
  const check = el('input'); check.type = 'checkbox'; check.checked = !!state.settings.autoplay;
  check.addEventListener('change', () => { state.settings.autoplay = check.checked; save('settings'); });
  label.append(check); panel.append(label, button('視聴履歴を削除', () => { state.history = []; save('history'); setNotice('履歴を削除しました。'); }, true)); view.append(panel);
}
async function route() {
  setNotice(''); const [page, arg] = location.hash.slice(1).split('/');
  document.querySelectorAll('.sidebar nav a').forEach(a => a.classList.toggle('active', a.hash === '#' + (page || 'home')));
  if (page === 'watch') return watch(decodeURIComponent(arg || ''));
  if (page === 'channel') return channel(decodeURIComponent(arg || ''));
  if (page === 'playlist') return playlist(decodeURIComponent(arg || ''));
  if (page === 'library') return library();
  if (page === 'settings') return settings();
  if (page === 'local-playlist') return localPlaylist(decodeURIComponent(arg || ''));
  if (page === 'shorts') return search('shorts', { duration: 'short', shorts: true });
  if (page === 'search') return search(new URLSearchParams(location.search).get('q') || '猫');
  view.replaceChildren(el('section', 'hero'));
  view.firstChild.append(el('h1', '', '見たい動画を探そう'), el('p', '', '検索から動画、チャンネル、プレイリストへ進めます。'));
  view.append(el('h2', '', 'おすすめの検索'));
  const options = el('div', 'actions'); ['猫', '音楽', 'ゲーム'].forEach(q => options.append(button(q, () => { document.querySelector('#search-input').value = q; location.hash = '#search'; search(q); }, true))); view.append(options);
}
document.querySelector('#search-form').addEventListener('submit', e => { e.preventDefault(); const q = document.querySelector('#search-input').value.trim(); if (!q) return; history.replaceState(null, '', '?q=' + encodeURIComponent(q) + '#search'); search(q); });
document.querySelector('#menu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));
window.addEventListener('hashchange', route); route();
