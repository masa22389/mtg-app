(() => {
  const $ = (id) => document.getElementById(id);

  // ===== Version =====
  const APP_VERSION = "0.0.3";

  // ===== Search view mode (grid/list) =====
  const SEARCH_VIEW_KEY = "mtg_search_view";
  let searchView = localStorage.getItem(SEARCH_VIEW_KEY) || "grid";

  // ===== Storage keys (backward compatible) =====
  const STORE_KEYS = [
    "mtg_deck_store_tabs_v2",
    "mtg_deck_store_v2",
    "mtg_deck_store_v1",
    "mtg_deck_store",
    "mtg_deck_store_v0"
  ];
  const STORE_KEY = STORE_KEYS[0];

  const state = {
    results: [],
    deck: newEmptyDeck(""),
    currentDeckName: "",
    openCard: null,
    boardCollapsed: { main:false, side:false }
  };

  /* ===== View switching ===== */
  function setView(view){
    const isSearch = view === "search";
    $("viewSearch").classList.toggle("active", isSearch);
    $("viewDeck").classList.toggle("active", !isSearch);

    $("tabSearch").setAttribute("aria-selected", String(isSearch));
    $("tabDeck").setAttribute("aria-selected", String(!isSearch));

    $("searchToolbar").style.display = isSearch ? "flex" : "none";

    const nextHash = isSearch ? "#search" : "#deck";
    if (location.hash !== nextHash) history.pushState(null, "", nextHash);
  }
  function syncViewFromHash(){
    const h = (location.hash || "").toLowerCase();
    if (h === "#deck") setView("deck");
    else setView("search");
  }
  $("tabSearch").onclick = () => setView("search");
  $("tabDeck").onclick = () => setView("deck");
  window.addEventListener("popstate", syncViewFromHash);
  window.addEventListener("hashchange", syncViewFromHash);

  function setStatus(msg){
    $("status").textContent = msg;
    const ds = $("deckStatus");
    if (ds) ds.textContent = msg;
  }

  /* ===== Search view toggle ===== */
  function setSearchView(mode){
    searchView = (mode === "list") ? "list" : "grid";
    localStorage.setItem(SEARCH_VIEW_KEY, searchView);

    const isGrid = searchView === "grid";
    $("resultsGrid").style.display = isGrid ? "grid" : "none";
    $("resultsList").style.display = isGrid ? "none" : "flex";

    $("viewMode").value = searchView;
    $("viewMode").options[0].textContent = "表示（グリッド）";
    $("viewMode").options[1].textContent = "表示（リスト）";
  }

  /* ===== Storage ===== */
  function loadStore(){
    for (const key of STORE_KEYS){
      try{
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && obj.decks && typeof obj.decks === "object"){
          if (key !== STORE_KEY){
            localStorage.setItem(STORE_KEY, JSON.stringify(obj));
          }
          if (!obj.version) obj.version = 2;
          return obj;
        }
      }catch{}
    }
    return { version:2, decks:{} };
  }
  function saveStore(store){ localStorage.setItem(STORE_KEY, JSON.stringify(store)); }

  function refreshDeckSelect(){
    const store = loadStore();
    const sel = $("deckSelect");
    sel.innerHTML = "";
    const names = Object.keys(store.decks).sort((a,b)=>a.localeCompare(b));

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "保存デッキを選択…";
    sel.appendChild(opt0);

    for (const n of names){
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }
  }

  function newEmptyDeck(name){
    return { name, updatedAt: new Date().toISOString(), main:{}, side:{} };
  }

  function setCurrentDeckName(name){
    state.currentDeckName = name || "";
    $("currentDeckName").textContent = state.currentDeckName ? state.currentDeckName : "（未保存）";
  }

  /* ===== Scryfall ===== */
  function looksJapanese(s){ return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(s); }
  function isAdvancedQuery(s){
    return /(^|\s)(t:|c:|o:|oracle:|f:|format:|lang:|is:|set:|cn:|rarity:|type:|pow|tou|cmc)\b/i.test(s) || /[:"]/g.test(s);
  }

  function getCardImage(card){
    if (card.image_uris?.normal) return card.image_uris.normal;
    if (Array.isArray(card.card_faces)) {
      for (const f of card.card_faces) if (f.image_uris?.normal) return f.image_uris.normal;
    }
    return "";
  }

  // 表示名：日本語版がある時は printed_name を優先
  function getDisplayName(card){
    return card.printed_name || card.name || "";
  }

  function getDisplayType(card){
    return card.printed_type_line || card.type_line || "";
  }

  function normalizeCard(card){
    return {
      id: card.id,
      oracle_id: card.oracle_id,
      name: getDisplayName(card),
      en_name: card.name || "",
      set: (card.set || "").toUpperCase(),
      collector: card.collector_number || "",
      lang: card.lang || "",
      released_at: card.released_at || "",
      scryfall_uri: card.scryfall_uri,
      image: getCardImage(card),
      cmc: typeof card.cmc === "number" ? card.cmc : Number(card.cmc || 0),
      type_line: getDisplayType(card)
    };
  }

  async function fetchSearch(q){
    const url = new URL("https://api.scryfall.com/cards/search");
    url.searchParams.set("q", q);
    url.searchParams.set("unique", "prints");
    url.searchParams.set("order", $("order").value);
    const res = await fetch(url.toString(), { headers:{ "Accept":"application/json" } });
    const data = await res.json().catch(()=>({}));
    return { ok: res.ok, data, status: res.status };
  }

  function dateKey(d){ return (d && typeof d === "string") ? d : ""; }

  function exactRank(name, query){
    const a = (name||"").trim().toLowerCase();
    const q = (query||"").trim().toLowerCase();
    return a === q ? 0 : 1;
  }

  function pickBestPrint(cards, query, preferJa){
    let best = null;
    for (const c of cards){
      if (!best){ best = c; continue; }
      if (preferJa){
        const aj = (c.lang === "ja") ? 0 : 1;
        const bj = (best.lang === "ja") ? 0 : 1;
        if (aj !== bj){ if (aj < bj) best = c; continue; }
      }
      const ad = dateKey(c.released_at);
      const bd = dateKey(best.released_at);
      if (ad !== bd){ if (ad > bd) best = c; continue; }

      const aName = (c.printed_name || c.name || "");
      const bName = (best.printed_name || best.name || "");
      const ae = exactRank(aName, query);
      const be = exactRank(bName, query);
      if (ae !== be){ if (ae < be) best = c; continue; }

      const aKey = ((c.set||"") + "|" + (c.collector_number||"") + "|" + (c.id||"")).toLowerCase();
      const bKey = ((best.set||"") + "|" + (best.collector_number||"") + "|" + (best.id||"")).toLowerCase();
      if (aKey > bKey) best = c;
    }
    return best;
  }

  function applyCollapseSame(rawCards, query, preferJa, collapseSame){
    if (!collapseSame) return rawCards;
    const groups = new Map();
    for (const c of rawCards){
      const k = c.oracle_id || c.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const picked = [];
    for (const arr of groups.values()) picked.push(pickBestPrint(arr, query, preferJa));
    return picked;
  }

  function sortResults(cards, query, preferJa){
    const qLower = (query||"").trim().toLowerCase();
    cards.sort((a,b)=>{
      const aname = (a.name||"").toLowerCase();
      const bname = (b.name||"").toLowerCase();
      const ae = aname === qLower ? 0 : 1;
      const be = bname === qLower ? 0 : 1;
      if (ae !== be) return ae - be;

      if (preferJa){
        const aj = (a.lang === "ja") ? 0 : 1;
        const bj = (b.lang === "ja") ? 0 : 1;
        if (aj !== bj) return aj - bj;
      }

      if (aname !== bname) return aname.localeCompare(bname);

      const ad = dateKey(a.released_at);
      const bd = dateKey(b.released_at);
      if (ad !== bd) return bd.localeCompare(ad);

      return (a.set||"").localeCompare(b.set||"");
    });
    return cards;
  }

  // ===== ここが重要修正①：ふりがな括弧（全角（ ）も）に対応する =====
  function escapeRegex(s){
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function buildFuriganaRegex(input){
    // 「（ ）」全角も「( )」半角も許容
    const chars = Array.from(input.trim()).filter(ch => ch !== " " && ch !== "　");
    const after = String.raw`(?:[（(][^）)]*[）)])?`;
    const parts = chars.map(ch => `${escapeRegex(ch)}${after}`);
    return parts.join(String.raw`\s*`);
  }

  async function searchCards(rawInput){
    const s = rawInput.trim();
    if (!s){
      state.results = [];
      renderResults();
      setStatus("検索ワードを入力してください");
      return;
    }

    const preferJa = $("preferJa").checked;
    const collapseSame = $("collapseSame").checked;

    setStatus("検索中…");

    if (isAdvancedQuery(s)){
      const queries = (preferJa && looksJapanese(s) && !/(^|\s)lang:/i.test(s))
        ? [`lang:ja ${s}`, s]
        : [s];

      for (const q of queries){
        const r = await fetchSearch(q);
        const arr = Array.isArray(r.data?.data) ? r.data.data : [];
        if (arr.length > 0){
          let rawCards = arr;
          rawCards = applyCollapseSame(rawCards, s, preferJa, collapseSame);
          let cards = rawCards.map(normalizeCard);
          cards = sortResults(cards, s, preferJa);
          state.results = cards;
          renderResults();
          setStatus(`ヒット: ${cards.length}件`);
          return;
        }
      }

      state.results = [];
      renderResults();
      setStatus("見つかりませんでした");
      return;
    }

    const merged = new Map();
    const pushAll = (arr)=>{ for (const c of arr) merged.set(c.id, c); };

    let jaHitCount = 0;
    if (preferJa){
      const rJa = await fetchSearch(`lang:ja ${s}`);
      const jaArr = Array.isArray(rJa.data?.data) ? rJa.data.data : [];
      jaHitCount = jaArr.length;
      pushAll(jaArr);

      // ★ふりがな括弧入り printed_name 用のフォールバック
      if (jaHitCount === 0 && looksJapanese(s)){
        const rx = buildFuriganaRegex(s);
        const rRx = await fetchSearch(`lang:ja name:/${rx}/`);
        const rxArr = Array.isArray(rRx.data?.data) ? rRx.data.data : [];
        pushAll(rxArr);
      }
    }

    const rAny = await fetchSearch(s);
    pushAll(Array.isArray(rAny.data?.data) ? rAny.data.data : []);

    if (merged.size > 0){
      let rawCards = Array.from(merged.values());

      rawCards = applyCollapseSame(rawCards, s, preferJa, collapseSame);

      if (preferJa){
        const bestByOracle = new Map();
        for (const c of rawCards){
          const key = c.oracle_id || c.id;
          const cur = bestByOracle.get(key);
          if (!cur) { bestByOracle.set(key, c); continue; }
          const curJ = (cur.lang === "ja") ? 1 : 0;
          const cJ = (c.lang === "ja") ? 1 : 0;
          if (cJ > curJ) bestByOracle.set(key, c);
        }
        if (collapseSame){
          rawCards = Array.from(bestByOracle.values());
        }
      }

      let cards = rawCards.map(normalizeCard);
      cards = sortResults(cards, s, preferJa);

      state.results = cards;
      renderResults();
      setStatus(`ヒット: ${cards.length}件`);
      return;
    }

    state.results = [];
    renderResults();
    setStatus("見つかりませんでした");
  }

  /* ===== Deck (Main/Side) ===== */
  function boardObj(board){ return board === "side" ? state.deck.side : state.deck.main; }

  function countBoard(obj){
    return Object.values(obj).reduce((sum,x)=>sum+(x.qty||0),0);
  }

  function listEntries(obj){
    const arr = Object.values(obj);
    const mode = $("sortDeck")?.value || "name";
    arr.sort((a,b)=>{
      if (mode === "cmc"){
        const ac = Number(a.cmc ?? 0);
        const bc = Number(b.cmc ?? 0);
        if (ac !== bc) return ac - bc;
      } else if (mode === "type"){
        const at = (a.type_line||"");
        const bt = (b.type_line||"");
        if (at !== bt) return at.localeCompare(bt);
      }
      return (a.name||"").localeCompare(b.name||"");
    });
    return arr;
  }

  // ===== 重要修正②：デッキ側も「日本語印刷があるなら日本語に寄せる」(旧デッキ救済も) =====
  const jaPrintCache = new Map(); // oracle_id -> normalizedCard (lang:ja)
  let deckJaEnrichTimer = null;

  async function fetchLatestJaPrintByOracle(oracleId){
    if (!oracleId) return null;
    if (jaPrintCache.has(oracleId)) return jaPrintCache.get(oracleId);

    try{
      // oracleid: はScryfallの検索演算子
      const url = new URL("https://api.scryfall.com/cards/search");
      url.searchParams.set("q", `oracleid:${oracleId} lang:ja`);
      url.searchParams.set("unique", "prints");
      url.searchParams.set("order", "released");
      url.searchParams.set("dir", "desc");

      const res = await fetch(url.toString(), { headers:{ "Accept":"application/json" } });
      const data = await res.json().catch(()=>({}));
      const arr = Array.isArray(data?.data) ? data.data : [];
      if (!arr.length) { jaPrintCache.set(oracleId, null); return null; }

      const best = normalizeCard(arr[0]); // 最新印刷（desc）
      jaPrintCache.set(oracleId, best);
      return best;
    }catch{
      jaPrintCache.set(oracleId, null);
      return null;
    }
  }

  function scheduleDeckJaEnrichment(){
    if (deckJaEnrichTimer) clearTimeout(deckJaEnrichTimer);
    deckJaEnrichTimer = setTimeout(async ()=>{
      // deck内で「日本語があれば置換したい」候補を探す
      const targets = [];
      for (const boardName of ["main","side"]){
        const obj = boardObj(boardName);
        for (const id of Object.keys(obj)){
          const it = obj[id];
          if (!it) continue;
          if (!it.oracle_id) continue;
          if (it.lang === "ja") continue;
          // 英語表示のままっぽいやつを日本語化
          targets.push({ boardName, id, oracle_id: it.oracle_id });
        }
      }

      // 1回で全部取りに行くと重いので、最大5件ずつ
      const batch = targets.slice(0, 5);
      if (!batch.length) return;

      let changed = false;
      for (const t of batch){
        const ja = await fetchLatestJaPrintByOracle(t.oracle_id);
        if (!ja) continue;
        const obj = boardObj(t.boardName);
        const it = obj[t.id];
        if (!it) continue;

        // 同じカードとして扱うので qty は維持
        it.name = ja.name || it.name;
        it.lang = "ja";
        it.image = ja.image || it.image;
        it.scryfall_uri = ja.scryfall_uri || it.scryfall_uri;
        it.set = ja.set || it.set;
        it.collector = ja.collector || it.collector;
        changed = true;
      }

      if (changed){
        state.deck.updatedAt = new Date().toISOString();
        renderDeck();
      }

      // まだ残ってそうならもう一周
      scheduleDeckJaEnrichment();
    }, 250);
  }

  function addToBoard(board, card, delta=1){
    const obj = boardObj(board);
    const cur = obj[card.id];
    if (cur) cur.qty += delta;
    else obj[card.id] = { ...card, qty: delta };
    state.deck.updatedAt = new Date().toISOString();
    renderDeck();
    scheduleDeckJaEnrichment();
  }

  function changeQty(board, cardId, delta, keepZero=false){
    const obj = boardObj(board);
    const it = obj[cardId];
    if (!it) return;

    it.qty += delta;

    if (it.qty <= 0){
      if (keepZero) it.qty = 0;
      else delete obj[cardId];
    }

    state.deck.updatedAt = new Date().toISOString();
    renderDeck();

    if (state.openCard && state.openCard.board === board && state.openCard.id === cardId){
      renderCardModal();
    }
  }

  function moveCard(from, to, cardId){
    if (from === to) return;
    const a = boardObj(from);
    const b = boardObj(to);
    const it = a[cardId];
    if (!it) return;
    if ((it.qty||0) <= 0) return;

    if (b[cardId]) b[cardId].qty += it.qty;
    else b[cardId] = it;
    delete a[cardId];

    state.deck.updatedAt = new Date().toISOString();
    renderDeck();

    if (state.openCard && state.openCard.id === cardId){
      state.openCard.board = to;
      renderCardModal();
    }
  }

  function cleanupZeros(){
    for (const b of ["main","side"]){
      const obj = boardObj(b);
      for (const id of Object.keys(obj)){
        if ((obj[id]?.qty ?? 0) <= 0) delete obj[id];
      }
    }
  }

  function clearBoards(){
    state.deck.main = {};
    state.deck.side = {};
    state.deck.updatedAt = new Date().toISOString();
    setCurrentDeckName("");
    renderDeck();
    setStatus("Main/Side を全消ししました");
  }

  /* ===== Render ===== */
  function renderResults(){
    const grid = $("resultsGrid");
    const list = $("resultsList");
    grid.innerHTML = "";
    list.innerHTML = "";

    for (const c of state.results){
      const wrap = document.createElement("div");
      wrap.className = "card";

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = c.name;
      img.src = c.image || "";
      img.onerror = () => { img.style.display = "none"; };

      const meta = document.createElement("div");
      meta.className = "meta";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = c.name;

      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `${c.set}${c.collector ? " #" + c.collector : ""}${c.lang ? " / " + c.lang : ""}${c.released_at ? " / " + c.released_at : ""}`;

      const actions = document.createElement("div");
      actions.className = "actions";

      const btnMain = document.createElement("button");
      btnMain.textContent = "Mainに追加";
      btnMain.onclick = () => addToBoard("main", c, 1);

      const btnSide = document.createElement("button");
      btnSide.textContent = "Sideに追加";
      btnSide.onclick = () => addToBoard("side", c, 1);

      const btnOpen = document.createElement("button");
      btnOpen.textContent = "詳細";
      btnOpen.onclick = () => window.open(c.scryfall_uri, "_blank", "noopener,noreferrer");

      actions.append(btnMain, btnSide, btnOpen);
      meta.append(name, sub, actions);
      wrap.append(img, meta);
      grid.appendChild(wrap);

      const row = document.createElement("div");
      row.className = "row";

      const limg = document.createElement("img");
      limg.loading = "lazy";
      limg.alt = c.name;
      limg.src = c.image || "";
      limg.onerror = () => { limg.style.display = "none"; };

      const rmeta = document.createElement("div");
      rmeta.className = "rmeta";

      const rname = document.createElement("div");
      rname.className = "rname";
      rname.textContent = c.name;

      const ractions = document.createElement("div");
      ractions.className = "ractions";

      const lMain = document.createElement("button");
      lMain.textContent = "Main";
      lMain.onclick = () => addToBoard("main", c, 1);

      const lSide = document.createElement("button");
      lSide.textContent = "Side";
      lSide.onclick = () => addToBoard("side", c, 1);

      const lOpen = document.createElement("button");
      lOpen.textContent = "詳細";
      lOpen.onclick = () => window.open(c.scryfall_uri, "_blank", "noopener,noreferrer");

      ractions.append(lMain, lSide, lOpen);

      const rsub = document.createElement("div");
      rsub.className = "rsub";
      rsub.textContent = `${c.set}${c.collector ? " #" + c.collector : ""}${c.lang ? " / " + c.lang : ""}${c.released_at ? " / " + c.released_at : ""}`;

      rmeta.append(rname, rsub, ractions);

      row.append(limg, rmeta);
      list.appendChild(row);
    }
  }

  function makeTile(boardName, it){
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.title = `${it.qty}x ${it.name}`;

    const img = document.createElement("img");
    img.alt = it.name;
    img.src = it.image || "";
    img.loading = "lazy";
    img.onerror = () => { img.style.display = "none"; };

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = it.qty;

    tile.append(img, badge);

    tile.addEventListener("click", (e)=>{
      e.preventDefault();
      openCardModal(boardName, it.id);
    });

    return tile;
  }

  function renderTiles(container, obj, boardName){
    container.innerHTML = "";
    for (const it of listEntries(obj)){
      container.appendChild(makeTile(boardName, it));
    }
  }

  function renderDeck(){
    const mc = countBoard(state.deck.main);
    const sc = countBoard(state.deck.side);

    $("mainCount").textContent = mc;
    $("sideCount").textContent = sc;
    $("mainCountTop").textContent = mc;
    $("sideCountTop").textContent = sc;

    $("mainBody").style.display = state.boardCollapsed.main ? "none" : "block";
    $("sideBody").style.display = state.boardCollapsed.side ? "none" : "block";
    $("toggleMain").textContent = state.boardCollapsed.main ? "▶" : "▼";
    $("toggleSide").textContent = state.boardCollapsed.side ? "▶" : "▼";

    renderTiles($("mainTiles"), state.deck.main, "main");
    renderTiles($("sideTiles"), state.deck.side, "side");

    // 旧デッキの英語名を日本語に寄せる（あれば）
    scheduleDeckJaEnrichment();
  }

  /* ===== Modals ===== */
  function showOverlay(id){
    const ov = $(id);
    ov.classList.add("show");
    ov.setAttribute("aria-hidden","false");
  }
  function hideOverlay(id){
    const ov = $(id);
    ov.classList.remove("show");
    ov.setAttribute("aria-hidden","true");
  }

  function openCardModal(board, cardId){
    state.openCard = { board, id: cardId };
    renderCardModal();
    showOverlay("cardModalOverlay");
  }

  function closeCardModal(){
    cleanupZeros();
    state.openCard = null;
    hideOverlay("cardModalOverlay");
    renderDeck();
  }

  function renderCardModal(){
    const body = $("cardModalBody");
    if (!state.openCard){
      body.innerHTML = "";
      return;
    }
    const { board, id } = state.openCard;
    const obj = boardObj(board);
    const it = obj[id];

    const safe = it || { id, name:"(カード)", qty:0, scryfall_uri:"#", image:"" };

    $("cardModalTitle").textContent = `${board === "main" ? "Main" : "Side"}のカード操作`;

    // 要望：カード名の下の「USG #174 / ja / ...」の1行は出さない
    body.innerHTML = `
      <div class="cardModalRow">
        <img src="${safe.image || ""}" alt="">
        <div class="cardModalMeta">
          <div class="big">${safe.qty}x ${escapeHtml(safe.name || "")}</div>

          <div class="btnGrid">
            <button id="cmPlus">+1</button>
            <button id="cmMinus">-1</button>
            <button id="cmMove" class="btnWide">${board === "main" ? "Sideへ移動" : "Mainへ移動"}</button>
            <button id="cmOpen" class="btnWide">Scryfall</button>
          </div>
        </div>
      </div>
    `;

    $("cmPlus").onclick  = () => changeQty(board, id, +1, true);
    $("cmMinus").onclick = () => changeQty(board, id, -1, true);

    $("cmMove").onclick = () => {
      const to = board === "main" ? "side" : "main";
      moveCard(board, to, id);
    };

    $("cmOpen").onclick = () => {
      if (safe.scryfall_uri && safe.scryfall_uri !== "#") window.open(safe.scryfall_uri, "_blank", "noopener,noreferrer");
    };

    if ((safe.qty||0) <= 0) $("cmMove").disabled = true;
  }

  function openSettingsModal(){
    $("deckName").value = state.currentDeckName || "";
    refreshDeckSelect();
    showOverlay("settingsModalOverlay");
  }
  function closeSettingsModal(){
    hideOverlay("settingsModalOverlay");
  }

  /* ===== Save/Load/Delete ===== */
  function saveCurrentDeck(){
    const name = $("deckName").value.trim();
    if (!name){ setStatus("デッキ名を入力してください"); return; }

    const store = loadStore();
    const toSave = structuredClone(state.deck);
    toSave.name = name;
    toSave.updatedAt = new Date().toISOString();

    store.decks[name] = toSave;
    saveStore(store);

    setCurrentDeckName(name);
    setStatus(`保存しました: ${name}`);
    refreshDeckSelect();
  }

  function loadDeckByName(name){
    const store = loadStore();
    const d = store.decks[name];
    if (!d){ setStatus(`見つかりません: ${name}`); return; }

    state.deck = {
      name: d.name || name,
      updatedAt: d.updatedAt || new Date().toISOString(),
      main: d.main || {},
      side: d.side || {}
    };
    setCurrentDeckName(name);
    renderDeck();
    setStatus(`読み込みました: ${name}`);
  }

  function deleteDeckByName(name){
    const store = loadStore();
    if (!store.decks[name]){ setStatus(`見つかりません: ${name}`); return; }
    delete store.decks[name];
    saveStore(store);
    refreshDeckSelect();
    setStatus(`削除しました: ${name}`);
    if (state.currentDeckName === name){
      setCurrentDeckName("");
      state.deck = newEmptyDeck("");
      renderDeck();
    }
  }

  function newDeck(){
    state.deck = newEmptyDeck("");
    setCurrentDeckName("");
    renderDeck();
    setStatus("新規デッキを作成しました");
  }

  /* ===== helpers ===== */
  function escapeHtml(s){
    return String(s)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  /* ===== events ===== */
  $("btnSearch").onclick = () => searchCards($("q").value);
  $("btnClear").onclick = () => { $("q").value=""; state.results=[]; renderResults(); setStatus("クリアしました"); };
  $("q").addEventListener("keydown", (e)=>{ if (e.key==="Enter") searchCards($("q").value); });

  $("order").addEventListener("change", ()=>{ if ($("q").value.trim()) searchCards($("q").value); });
  $("preferJa").addEventListener("change", ()=>{ if ($("q").value.trim()) searchCards($("q").value); });
  $("collapseSame").addEventListener("change", ()=>{ if ($("q").value.trim()) searchCards($("q").value); });

  $("viewMode").addEventListener("change", ()=> setSearchView($("viewMode").value));

  $("toggleMain").onclick = () => { state.boardCollapsed.main = !state.boardCollapsed.main; renderDeck(); };
  $("toggleSide").onclick = () => { state.boardCollapsed.side = !state.boardCollapsed.side; renderDeck(); };

  $("btnClearBoards").onclick = () => {
    if (!confirm("Main/Side を全消しします。よろしいですか？")) return;
    clearBoards();
  };

  $("btnOpenSettings").onclick = openSettingsModal;

  $("closeCardModal").onclick = closeCardModal;
  $("closeSettingsModal").onclick = closeSettingsModal;

  $("cardModalOverlay").addEventListener("click", (e)=>{
    if (e.target === $("cardModalOverlay")) closeCardModal();
  });
  $("settingsModalOverlay").addEventListener("click", (e)=>{
    if (e.target === $("settingsModalOverlay")) closeSettingsModal();
  });

  $("btnSaveDeck").onclick = saveCurrentDeck;
  $("btnNewDeck").onclick = () => {
    if (!confirm("新規デッキを作成します（未保存の変更は失われます）。よろしいですか？")) return;
    newDeck();
  };
  $("btnLoadDeck").onclick = () => {
    const name = $("deckSelect").value;
    if (!name){ setStatus("読み込むデッキを選択してください"); return; }
    loadDeckByName(name);
    closeSettingsModal();
  };
  $("btnDeleteDeck").onclick = () => {
    const name = $("deckSelect").value || state.currentDeckName;
    if (!name){ setStatus("削除するデッキを選択してください"); return; }
    if (!confirm(`デッキ「${name}」を削除します。よろしいですか？`)) return;
    deleteDeckByName(name);
  };
  $("btnCleanupZeros").onclick = () => {
    cleanupZeros();
    renderDeck();
    setStatus("0枚カードを掃除しました");
  };

  $("sortDeck").addEventListener("change", renderDeck);

  /* ===== init ===== */
  $("verBadge").textContent = `ver ${APP_VERSION}`;
  loadStore();
  refreshDeckSelect();

  setCurrentDeckName("");
  renderResults();
  renderDeck();
  setStatus("待機中");
  setSearchView(searchView);
  syncViewFromHash();

})();
