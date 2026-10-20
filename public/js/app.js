'use strict';
(() => {
  const app = document.querySelector('#app');
  const searchInput = document.querySelector('#searchInput');
  const serverLabel = document.querySelector('#serverLabel');
  const keys = { favorites:'cattube.favorites.v2', history:'cattube.history.v2' };
  let epoch = 0, activeVideo = null, selectedServer = '', videoServers = [], lastStatus = [], toastTimer;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const videoId = s => /^[\w-]{11}$/.test(s || '') ? s : '';
  const channelId = s => /^UC[\w-]{22}$/.test(s || '') ? s : '';
  const num = n => Number(n || 0).toLocaleString('ja-JP');
  const length = n => { n = Number(n)||0;return (n>=3600 ? Math.floor(n/3600)+':'+String(Math.floor(n%3600/60)).padStart(2,'0') : Math.floor(n/60))+':'+String(n%60).padStart(2,'0'); };
  const ago = unix => { if (!unix) return ''; const d = Math.max(0,Date.now()/1000-Number(unix));return d<86400?'今日':d<2592000?Math.floor(d/86400)+'日前':d<31536000?Math.floor(d/2592000)+'か月前':Math.floor(d/31536000)+'年前'; };
  const store = name => { try { const a=JSON.parse(localStorage.getItem(keys[name])||'[]');return Array.isArray(a)?a:[]; } catch {return [];} };
  const save = (name,items) => {try{localStorage.setItem(keys[name],JSON.stringify(items));}catch{toast('保存できませんでした');}};
  const rec = v => ({videoId:v.videoId,title:v.title,author:v.author,authorId:v.authorId,viewCount:v.viewCount,published:v.published,lengthSeconds:v.lengthSeconds});
  const thumb = (id,server) => (server||selectedServer||'https://inv.nadeko.net')+'/vi/'+id+'/mqdefault.jpg';
  const isFavorite = id => store('favorites').some(v=>v.videoId===id);
  function toast(msg){const el=document.querySelector('#toast');el.textContent=msg;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),3000);}
  async function request(url){const r=await fetch(url,{headers:{Accept:'application/json'}});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||'通信エラーが発生しました');return data;}
  function useServer(result){if(!result.instance)return;selectedServer=result.instance;serverLabel.textContent=new URL(selectedServer).host+(result.cached?' · CACHE':' · '+result.latencyMs+'ms');}
  function nav(name){document.querySelectorAll('[data-nav]').forEach(el=>el.classList.toggle('active',el.dataset.nav===name));}
  function skeleton(title){app.innerHTML='<div class="page-heading"><div><span class="eyebrow">CAT TUBE</span><h1>'+esc(title)+'</h1></div></div><div class="skeleton-grid">'+Array(8).fill('<div class="skeleton-card"><div></div><span></span><span></span></div>').join('')+'</div>';}
  function fail(err){const external=(lastStatus.filter(s=>s.websiteStatus==='ok').sort((a,b)=>(a.websiteLatencyMs||Infinity)-(b.websiteLatencyMs||Infinity))[0]||lastStatus[0]);const q=new URLSearchParams((location.hash.split('?')[1]||''));const query=(q.get('q')||'').trim().slice(0,120);const safe=external?external.url:'';app.innerHTML='<div class="message-panel"><div class="message-icon"></div><h2>接続できませんでした</h2><p>'+esc(err.message||err)+'</p><button class="primary-button" data-action="retry">もう一度試す</button><a href="#/servers" class="muted-link">サーバーの状態を見る</a>'+(safe?'<a class="muted-link" href="'+esc(safe+'/search?q='+encodeURIComponent(query||'動画'))+'" target="_blank" rel="noopener noreferrer">Invidious の検索ページを開く</a>':'')+'</div>';}
  function empty(title,note){return '<div class="empty-state"><div>CT</div><h3>'+esc(title)+'</h3><p>'+esc(note)+'</p></div>';}
  function card(v,instance){const id=videoId(v.videoId);if(!id)return '';const cid=channelId(v.authorId);return '<article class="video-card"><a class="thumb" href="#/watch/'+id+'"><img loading="lazy" data-video-id="'+id+'" src="'+esc(thumb(id,instance))+'" alt="">'+(v.lengthSeconds?'<span class="duration">'+length(v.lengthSeconds)+'</span>':v.liveNow?'<span class="duration">LIVE</span>':'')+'</a><div class="card-details"><a href="#/watch/'+id+'" class="video-title">'+esc(v.title||'タイトルなし')+'</a><div class="card-meta">'+(cid?'<a href="#/channel/'+cid+'">':'<span>')+esc(v.author||'不明')+(cid?'</a>':'</span>')+'<span>'+[v.viewCount!=null?num(v.viewCount)+' 回視聴':'',ago(v.published)].filter(Boolean).join(' · ')+'</span></div></div></article>';}
  function grid(items,server){return '<div class="video-grid">'+(items||[]).map(v=>card(v,server)).join('')+'</div>';}
  function heading(label,title,note){return '<div class="page-heading"><div><span class="eyebrow">'+esc(label)+'</span><h1>'+esc(title)+'</h1>'+(note?'<p>'+esc(note)+'</p>':'')+'</div></div>';}
  async function home(type='default'){
    nav(type==='default'?'home':type);skeleton('動画を探す');const token=++epoch;
    try{const result=await request('/cat/trending?type='+encodeURIComponent(type));if(token!==epoch)return;useServer(result);
      const choices=[['default','すべて'],['music','音楽'],['gaming','ゲーム'],['movies','映画']];
      app.innerHTML='<div class="hero"><div class="hero-copy"><span class="hero-badge"> YOUR WINDOW TO VIDEO</span><h1>好きな動画に、<br><em>もっと自由に。</em></h1><p>動画を見つける、新しい場所。Invidious の検索結果を同時取得し、最速の有効なページから動画を表示。</p><div class="hero-foot"><span class="live-dot"></span> FASTEST SERVER WINS <span class="hero-line"></span> CAT TUBE 2.0</div></div><div class="hero-art">CT<span></span></div></div>'+
      '<div class="section-header"><div><span class="eyebrow">EXPLORE WHAT\'S TRENDING</span><h2>いま注目の動画 </h2></div><span class="result-count">'+(result.data||[]).length+' videos</span></div>'+
      '<div class="category-row">'+choices.map(([id,name])=>'<a class="category-pill '+(id===type?'selected':'')+'" href="'+(id==='default'?'#/':'#/trending/'+id)+'">'+name+'</a>').join('')+'</div>'+
      ((result.data||[]).length?grid(result.data,result.instance):empty('まだ動画がありません','別のカテゴリを試してください'));
    }catch(e){if(token===epoch)fail(e);}
  }
  async function search(q,page=1){
    nav('');skeleton('検索結果');const token=++epoch;
    try{const result=await request('/cat/search?q='+encodeURIComponent(q)+'&page='+page);if(token!==epoch)return;useServer(result);searchInput.value=q;
      const items=result.data||[], vids=items.filter(x=>videoId(x.videoId)), channels=items.filter(x=>x.type==='channel'&&channelId(x.authorId));
      app.innerHTML=heading('SEARCH RESULTS','「'+q+'」の検索結果',vids.length+' 本の動画')+
      (channels.length?'<div class="channels-row">'+channels.slice(0,3).map(x=>'<a class="channel-chip" href="#/channel/'+channelId(x.authorId)+'">CT <strong>'+esc(x.author)+'</strong> <small>チャンネルを見る </small></a>').join('')+'</div>':'')+
      (vids.length?grid(vids,result.instance):empty('見つかりませんでした','キーワードを変えてください'))+
      '<div class="pagination">'+(page>1?'<a class="page-button" href="#/search?q='+encodeURIComponent(q)+'&page='+(page-1)+'"> 前へ</a>':'')+
      '<span>ページ '+page+'</span><a class="page-button" href="#/search?q='+encodeURIComponent(q)+'&page='+(page+1)+'">次へ </a></div>';
    }catch(e){if(token===epoch)fail(e);}
  }
  let switchingVideoServer = false;
  let failedVideoServers = new Set();

  function watchUrl() {
    return selectedServer + '/watch?v=' + videoId(activeVideo?.videoId);
  }
  function validStream(format) {
    try {
      const url = new URL(format.url);
      const id = videoId(activeVideo?.videoId);
      // Invidious Companion may provide an absolute HTTPS media URL on a
      // different origin than the HTML page. The backend has already checked
      // the media path and video ID against the fetched video page.
      return url.protocol === 'https:' && !url.username && !url.password &&
        ['/latest_version', '/videoplayback'].includes(url.pathname) &&
        url.searchParams.get('id') === id &&
        (url.origin === new URL(selectedServer).origin || !!url.searchParams.get('check')) &&
        /^(video\/mp4|video\/webm|video\/ogg|application\/vnd\.apple\.mpegurl|application\/x-mpegurl)$/.test(format.type || '')
        ? url.href : '';
    } catch { return ''; }
  }
  function player() {
    if (!activeVideo) return '';
    const sources = (activeVideo.formatStreams || []).map(format => {
      const src = validStream(format);
      return src ? '<source src="' + esc(src) + '" type="' + esc(format.type) + '">' : '';
    }).filter(Boolean);
    if (!sources.length) {
      return '<div class="video-unavailable"><strong>HTML5 動画の再生ソースを取得できませんでした</strong>' +
        '<p>サーバーの動画ページから再生 URL を取得できませんでした。利用可能な配信元がない場合、他のサーバーでも再生できないことがあります。</p>' +
        '<button class="primary-button" data-action="next-server">別サーバーを試す</button></div>';
    }
    return '<video id="nativePlayer" class="video-element" controls playsinline preload="metadata" ' +
      'poster="' + esc(thumb(activeVideo.videoId, selectedServer)) + '" ' +
      'aria-label="' + esc(activeVideo.title) + '">' + sources.join('') +
      'このブラウザは HTML5 video をサポートしていません。</video>';
  }
  function updatePlayer() {
    const target = document.querySelector('#videoPlayer');
    if (target) target.innerHTML = player();
    const label = document.querySelector('#currentInstance');
    if (label) label.textContent = selectedServer ? new URL(selectedServer).host : '未選択';
    const external = document.querySelector('#externalPlayer');
    if (external && selectedServer) external.href = watchUrl();
  }
  async function nextVideoServer(auto = false) {
    if (switchingVideoServer || !activeVideo) return;
    const id = videoId(activeVideo.videoId);
    const currentEpoch = epoch;
    const options = videoServers.filter(url => url !== selectedServer && !failedVideoServers.has(url));
    if (!options.length) {
      toast('試せる Invidious サーバーがありません');
      return;
    }
    switchingVideoServer = true;
    const label = document.querySelector('#currentInstance');
    if (label) label.textContent = '別サーバーから取得中';
    try {
      for (const server of options) {
        try {
          const result = await request('/cat/videos/' + id + '?instance=' + encodeURIComponent(server));
          if (currentEpoch !== epoch || activeVideo?.videoId !== id) return;
          if (!(result.data?.formatStreams || []).length) throw new Error('再生ソースがありません');
          selectedServer = result.instance;
          activeVideo = { ...activeVideo, ...result.data };
          updatePlayer();
          toast('HTML5 再生先を変更しました: ' + new URL(server).host);
          return;
        } catch (error) {
          failedVideoServers.add(server);
        }
      }
      if (currentEpoch === epoch) {
        if (label) label.textContent = '再生できるサーバーなし';
        toast('他のサーバーからも HTML5 再生ソースを取得できませんでした');
      }
    } finally {
      switchingVideoServer = false;
    }
  }
  async function watch(id){
    nav('');skeleton('動画を準備中');const token=++epoch;activeVideo=null;switchingVideoServer=false;failedVideoServers=new Set();
    try{const result=await request('/cat/videos/'+id);if(token!==epoch)return;useServer(result);activeVideo=result.data;
      videoServers=(result.videoServers||[result.instance,...lastStatus.map(x=>x.url)]).filter((x,i,a)=>x&&a.indexOf(x)===i);
      save('history',[rec(activeVideo),...store('history').filter(x=>x.videoId!==id)].slice(0,60));
      const v=activeVideo,cid=channelId(v.authorId),related=v.recommendedVideos||[];
      app.innerHTML='<div class="watch-layout"><section class="watch-primary"><div id="videoPlayer" class="player-frame">'+player()+'</div>'+
      '<div class="player-options"><div class="playing-instance"><span class="live-dot"></span> 再生サーバー: <strong id="currentInstance">'+esc(new URL(selectedServer).host)+'</strong></div>'+
      '<div class="player-actions"><span class="soft-button selected">HTML5 VIDEO</span><button class="soft-button" data-action="next-server">別サーバーで再生</button></div></div>'+
      '<h1 class="watch-title">'+esc(v.title)+'</h1><div class="watch-actions"><div class="watch-channel"><span class="channel-avatar">CT</span><div>'+
      (cid?'<a class="watch-author" href="#/channel/'+cid+'">'+esc(v.author)+'</a>':'<strong>'+esc(v.author)+'</strong>')+
      '<small>'+ (v.subCount?num(v.subCount)+' 人の登録者':'クリエイター')+'</small></div></div>'+
      '<button class="primary-button" data-action="favorite">'+(isFavorite(id)?'保存済み':'お気に入りに保存')+'</button></div>'+
      '<div class="description-box"><strong>'+num(v.viewCount)+' 回視聴 · '+esc(ago(v.published))+'</strong><p>'+esc(String(v.description||'').slice(0,1600))+'</p></div>'+
      '<p class="watch-note">動画は HTML5 video で再生しています。再生エラー時は他のサーバーから再生ソースを取得します。'+esc(result.warning||'')+'<a id="externalPlayer" href="'+esc(watchUrl())+'" target="_blank" rel="noopener noreferrer">元の Invidious 動画ページを開く</a></p></section>'+
      '<aside class="watch-aside"><div class="aside-title"><span class="eyebrow">UP NEXT</span><h2>次に見る動画</h2></div>'+
      (related.length?related.filter(x=>videoId(x.videoId)).slice(0,20).map(x=>'<a class="related-card" href="#/watch/'+videoId(x.videoId)+'"><div class="related-thumb"><img data-video-id="'+videoId(x.videoId)+'" loading="lazy" src="'+esc(thumb(x.videoId,selectedServer))+'" alt="">'+(x.lengthSeconds?'<span class="duration">'+length(x.lengthSeconds)+'</span>':'')+'</div><div><strong>'+esc(x.title)+'</strong><small>'+esc(x.author)+'</small></div></a>').join(''):'<p class="muted">おすすめ動画がありません</p>')+'</aside></div>';
    }catch(e){if(token===epoch)fail(e);}
  }
  async function channel(id){
    nav('');skeleton('チャンネル');const token=++epoch;
    try{const result=await request('/cat/channels/'+id);if(token!==epoch)return;useServer(result);const v=result.data;
      app.innerHTML='<div class="channel-banner"></div><div class="channel-header"><span class="big-avatar">CT</span><div><span class="eyebrow">CREATOR CHANNEL</span><h1>'+esc(v.author)+'</h1><p>'+(v.subCount?num(v.subCount)+' 人の登録者':'')+'</p></div></div>'+
      '<div class="section-header"><h2>最新の動画</h2></div>'+((v.latestVideos||[]).length?grid(v.latestVideos,result.instance):empty('まだ動画がありません','チャンネルの動画を取得できませんでした'));
    }catch(e){if(token===epoch)fail(e);}
  }
  function library(kind){
    ++epoch;const name=kind==='history'?'history':'favorites';nav(name);const items=store(name);
    app.innerHTML=heading('YOUR SPACE',name==='history'?'視聴履歴':'お気に入り',items.length+' 本 · このブラウザに保存')+
    '<div class="category-row"><a class="category-pill '+(name==='favorites'?'selected':'')+'" href="#/library/favorites">お気に入りに保存</a><a class="category-pill '+(name==='history'?'selected':'')+'" href="#/library/history">履歴 視聴履歴</a>'+
    (items.length?'<button class="outline-button" data-list="'+name+'" data-action="clear">すべて削除</button>':'')+'</div>'+
    (items.length?grid(items):empty('まだ動画がありません',name==='history'?'動画を再生すると履歴が残ります':'動画ページでハートを押すと保存されます'));
  }
  function servers(){
    ++epoch;nav('');
    const lines = lastStatus.map(s => {
      const searchStatus = s.searchStatus === 'ok' ? '検索成功' : s.searchStatus === 'error' ? '検索失敗' : '未検査';
      const videoStatus = s.videoStatus === 'ok' ? '動画ページ取得成功' : s.videoStatus === 'error' ? '動画ページ取得失敗' : '未検査';
      const state = s.searchStatus === 'ok' ? 'good' : 'bad';
      const searchTime = s.searchLatencyMs == null ? '未測定' : s.searchLatencyMs + 'ms';
      const videoTime = s.videoLatencyMs == null ? '未測定' : s.videoLatencyMs + 'ms';
      return '<article class="server-card"><span class="status-dot '+state+'"></span><h3>'+esc(new URL(s.url).host)+'</h3>' +
        '<p>検索ページ：'+searchStatus+'</p><strong>'+searchTime+'</strong>' +
        '<p>動画ページ：'+videoStatus+'（'+videoTime+'）</p>' +
        (s.lastHttpStatus ? '<p>HTTP '+s.lastHttpStatus+'</p>' : '') +
        (s.lastError ? '<p class="server-error">'+esc(s.lastError)+'</p>' : '') +
        (s.cooldownSeconds ? '<p>再試行まで '+s.cooldownSeconds+' 秒</p>' : '') + '</article>';
    });
    app.innerHTML=heading('SERVER STATUS','サーバーステータス','Invidious の通常の HTML ページを取得した結果') +
      '<div class="server-explanation"><div><strong>FASTEST VALID HTML WINS</strong><p>各 Invidious サーバーの検索結果ページや動画ページを同時取得し、最も早く有効な HTML を返した接続先を使用します。外部 API は使いません。検索ページの応答速度と実際の動画ストリーミング速度は異なります。</p></div></div>' +
      '<div class="category-row"><button class="outline-button" data-action="refresh">検索接続を再検査</button></div>' +
      '<div class="server-grid">'+lines.join('')+'</div>';
  }
  async function updateStatus(){serverLabel.textContent='検索ページを確認中';try{const r=await request('/cat/instances?refresh=1');lastStatus=r.instances||[];if(!selectedServer){const ok=lastStatus.filter(s=>s.searchStatus==='ok').length;serverLabel.textContent=ok?ok+' 台の検索ページが利用可能':'検索ページ応答なし · '+lastStatus.length+' 台を検査';}}catch(e){serverLabel.textContent='サーバー診断エラー';toast(e.message);}}
  function route(){
    const raw=location.hash.slice(1)||'/', [path,query='']=raw.split('?'),p=path.split('/').filter(Boolean);
    window.scrollTo(0,0);
    if(!p.length)return home();
    if(p[0]==='trending')return home(['music','gaming','movies'].includes(p[1])?p[1]:'default');
    if(p[0]==='search'){const a=new URLSearchParams(query),q=(a.get('q')||'').slice(0,120).trim();return q?search(q,Math.min(20,Math.max(1,Number(a.get('page'))||1))):home();}
    if(p[0]==='watch'&&videoId(p[1]))return watch(p[1]);
    if(p[0]==='channel'&&channelId(p[1]))return channel(p[1]);
    if(p[0]==='library')return library(p[1]);
    if(p[0]==='servers')return servers();
    ++epoch;app.innerHTML=empty('ページがありません','ホームへ戻ってください');
  }
  document.querySelector('#searchForm').addEventListener('submit',e=>{e.preventDefault();const q=searchInput.value.trim();if(q)location.hash='/search?q='+encodeURIComponent(q);});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();searchInput.focus();}});
  document.querySelector('#serverButton').addEventListener('click',()=>location.hash='/servers');
  document.addEventListener('click',e=>{
    const el=e.target.closest('[data-action],[data-mode]');if(!el)return;
    if(el.dataset.mode) return;
    if(el.dataset.action==='retry')route();
    if(el.dataset.action==='next-server') nextVideoServer();
    if(el.dataset.action==='favorite'&&activeVideo){const items=store('favorites'),id=activeVideo.videoId,exists=isFavorite(id);save('favorites',exists?items.filter(x=>x.videoId!==id):[rec(activeVideo),...items].slice(0,200));el.textContent=exists?'お気に入りに保存':'保存済み';toast(exists?'削除しました':'お気に入りに追加しました');}
    if(el.dataset.action==='clear'){if(confirm('保存された一覧を削除しますか？')){save(el.dataset.list,[]);library(el.dataset.list);}}
    if(el.dataset.action==='refresh')updateStatus().then(servers);
  });
  // Native HTML5 video can fail independently from the successful HTML request.
  document.addEventListener('error', event => {
    if (!event.target?.matches?.('video#nativePlayer') || !activeVideo) return;
    failedVideoServers.add(selectedServer);
    toast('動画ストリームの読み込みに失敗したため別サーバーを試します');
    nextVideoServer(true);
  }, true);
  document.addEventListener('error',e=>{const img=e.target;if(img.matches&&img.matches('img[data-video-id]')&&!img.dataset.fallback){img.dataset.fallback='1';img.src='https://i.ytimg.com/vi/'+img.dataset.videoId+'/mqdefault.jpg';}},true);
  window.addEventListener('hashchange',route);
  updateStatus().then(()=>{if(location.hash.startsWith('#/servers'))servers();});
  route();
})();
