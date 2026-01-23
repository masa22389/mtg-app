/* app.js - MTG Deck Builder (Scryfall)
   - Search (grid/list)
   - Prefer Japanese printing
   - Collapse same (latest printing)
   - Deck builder (Main/Side) with modal ops
   - Fix: Japanese partial search must be name-limited (no unrelated cards)
   - Fix: Furigana-in-parentheses Japanese name search (（） and () + spaces)
   - Deck sort: Type order / MV (CMC) / Name
*/

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ===== Version =====
  const APP_VERSION = "0.0.7";

  // ===== Search view mode (grid/list) =====
  const SEARCH_VIEW_KEY = "mtg_search_view";
  let searchView = localStorage.getItem(SEARCH_VIEW_KEY) || "grid";

  // ===== Storage keys (backward compatible) =====
  const STORE_KEYS = [
    "mtg_deck_store_tabs_v2",
    "mtg_deck_store_v2",
    "mtg_deck_store_v1",
    "mtg_deck_store",
    "mtg_deck_store_v0",
  ];
  const STORE_KEY = STORE_KEYS[0]; // always save into tabs_v2

  const state = {
    results: [],
    deck: newEmptyDeck(""),
    currentDeckName: "",
    openCard: null, // { board:"main"|"side", id:"..." }
    boardCollapsed: { main: false, side: false },
  };

  // =========================
  // View switching
  // =========================
  function setView(view) {
    const isSearch = view === "search";
    $("viewSearch").classList.toggle("active", isSearch);
    $("viewDeck").classList.toggle("active", !isSearch);

    $("tabSearch").setAttribute("aria-selected", String(isSearch));
    $("tabDeck").setAttribute("aria-selected", String(!isSearch));

    $("searchToolbar").style.display = isSearch ? "flex" : "none";

    const nextHash = isSearch ? "#search" : "#deck";
    if (location.hash !== nextHash) history.pushState(null, "", nextHash);
  }

  function syncViewFromHash() {
    const h = (location.hash || "").toLowerCase();
    if (h === "#deck") setView("deck");
    else setView("search");
  }

  $("tabSearch").onclick = () => setView("search");
  $("tabDeck").onclick = () => setView("deck");
  window.addEventListener("popstate", syncViewFromHash);
  window.addEventListener("hashchange", syncViewFromHash);

  function setStatus(msg) {
    $("status").textContent = msg;
    const ds = $("deckStatus");
    if (ds) ds.textContent = msg;
  }

  // =========================
  // Search view toggle
  // =========================
  function setSearchView(mode) {
    searchView = mode === "list" ? "list" : "grid";
    localStorage.setItem(SEARCH_VIEW_KEY, searchView);

    const isGrid = searchView === "grid";
    $("resultsGrid").style.display = isGrid ? "grid" : "none";
    $("resultsList").style.display = isGrid ? "none" : "flex";

    $("viewMode").value = searchView;
  }

  // =========================
  // Storage
  // =========================
  function loadStore() {
    for (const key of STORE_KEYS) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object" && obj.decks && typeof obj.decks === "object") {
          if (key !== STORE_KEY) localStorage.setItem(STORE_KEY, JSON.stringify(obj));
          if (!obj.version) obj.version = 2;
          return obj;
        }
      } catch {}
    }
    return { version: 2, decks: {} };
  }

  function saveStore(store) {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }

  function refreshDeckSelect() {
    const store = loadStore();
    const sel = $("deckSelect");
    sel.innerHTML = "";
    const names = Object.keys(store.decks).sort((a, b) => a.localeCompare(b, "ja"));

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "保存デッキを選択…";
    sel.appendChild(opt0);

    for (const n of names) {
      const opt = document.createElement("option");
      opt.value = n;
      opt.textContent = n;
      sel.appendChild(opt);
    }
  }

  function newEmptyDeck(name) {
    return { name, updatedAt: new Date().toISOString(), main: {}, side: {} };
  }

  function setCurrentDeckName(name) {
    state.currentDeckName = name || "";
    $("currentDeckName").textContent = state.currentDeckName ? state.currentDeckName : "（未保存）";
  }

  // =========================
  // Scryfall helpers
  // =========================
  function looksJapanese(s) {
    return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(s);
  }

  function isAdvancedQuery(s) {
    // If they typed "t:" "o:" etc or quotes/colon etc treat as advanced
    return (
      /(^|\s)(t:|c:|o:|oracle:|f:|format:|lang:|is:|set:|cn:|rarity:|type:|pow|tou|cmc)\b/i.test(
        s
      ) || /[:"]/g.test(s)
    );
  }

  function getCardImage(card) {
    if (card.image_uris?.normal) return card.image_uris.normal;
    if (Array.isArray(card.card_faces)) {
      for (const f of card.card_faces) if (f.image_uris?.normal) return f.image_uris.normal;
    }
    return "";
  }

  // 日本語があるときは printed_name を表示に使う
  function getDisplayName(card) {
    return card.printed_name || card.name || "";
  }

  function getDisplayType(card) {
    return card.printed_type_line || card.type_line || "";
  }

  // =========================
  // Deck sort helpers
  // =========================
  const TYPE_ORDER = ["Land", "Creature", "Instant", "Sorcery", "Artifact", "Enchantment", "Planeswalker"];

  function normalizeForSortName(s) {
    // 例: 量（りょう）子（し）… -> 量子…
    return String(s || "")
      .replace(/\s+/g, " ")
      .replace(/[（(][^）)]*[）)]/g, "") // 括弧内（ふりがな等）を除去
      .replace(/[・･]/g, "")
      .trim();
  }

  function primaryTypeOrder(typeLine) {
    // typeLine例: "Artifact Creature — Golem"
    const left = String(typeLine || "").split("—")[0] || "";
    const tokens = left.split(/\s+/).filter(Boolean);

    for (let i = 0; i < TYPE_ORDER.length; i++) {
      if (tokens.includes(TYPE_ORDER[i])) return i;
    }
    // Battle等は最後
    return TYPE_ORDER.length;
  }

  function normalizeCard(card) {
    const displayName = getDisplayName(card);
    const displayType = getDisplayType(card);

    return {
      id: card.id,
      oracle_id: card.oracle_id,
      name: displayName,
      sort_name: normalizeForSortName(displayName),
      type_order: primaryTypeOrder(displayType),
      en_name: card.name || "",
      set: (card.set || "").toUpperCase(),
      collector: card.collector_number || "",
      lang: card.lang || "",
      released_at: card.released_at || "",
      scryfall_uri: card.scryfall_uri,
      image: getCardImage(card),
      cmc: typeof card.cmc === "number" ? card.cmc : Number(card.cmc || 0),
      type_line: displayType,
    };
  }

  async function fetchSearch(q) {
    const url = new URL("https://api.scryfall.com/cards/search");
    url.searchParams.set("q", q);
    url.searchParams.set("unique", "prints");
    url.searchParams.set("order", $("order").value);

    const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data, status: res.status };
  }

  function dateKey(d) {
    return d && typeof d === "string" ? d : "";
  }

  function exactRank(name, query) {
    const a = (name || "").trim().toLowerCase();
    const q = (query || "").trim().toLowerCase();
    return a === q ? 0 : 1;
  }

  function pickBestPrint(cards, query, preferJa) {
    let best = null;
    for (const c of cards) {
      if (!best) {
        best = c;
        continue;
      }

      if (preferJa) {
        const aj = c.lang === "ja" ? 0 : 1;
        const bj = best.lang === "ja" ? 0 : 1;
        if (aj !== bj) {
          if (aj < bj) best = c;
          continue;
        }
      }

      const ad = dateKey(c.released_at);
      const bd = dateKey(best.released_at);
      if (ad !== bd) {
        if (ad > bd) best = c;
        continue;
      }

      const aName = c.printed_name || c.name || "";
      const bName = best.printed_name || best.name || "";
      const ae = exactRank(aName, query);
      const be = exactRank(bName, query);
      if (ae !== be) {
        if (ae < be) best = c;
        continue;
      }

      const aKey = ((c.set || "") + "|" + (c.collector_number || "") + "|" + (c.id || "")).toLowerCase();
      const bKey = ((best.set || "") + "|" + (best.collector_number || "") + "|" + (best.id || "")).toLowerCase();
      if (aKey > bKey) best = c;
    }
    return best;
  }

  function applyCollapseSame(rawCards, query, preferJa, collapseSame) {
    if (!collapseSame) return rawCards;
    const groups = new Map();
    for (const c of rawCards) {
      const k = c.oracle_id || c.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(c);
    }
    const picked = [];
    for (const arr of groups.values()) picked.push(pickBestPrint(arr, query, preferJa));
    return picked;
  }

  function sortResults(cards, query, preferJa) {
    const qLower = (query || "").trim().toLowerCase();
    cards.sort((a, b) => {
      const aname = (a.name || "").toLowerCase();
      const bname = (b.name || "").toLowerCase();

      const ae = aname === qLower ? 0 : 1;
      const be = bname === qLower ? 0 : 1;
      if (ae !== be) return ae - be;

      if (preferJa) {
        const aj = a.lang === "ja" ? 0 : 1;
        const bj = b.lang === "ja" ? 0 : 1;
        if (aj !== bj) return aj - bj;
      }

      if (aname !== bname) return aname.localeCompare(bname, "ja");

      const ad = dateKey(a.released_at);
      const bd = dateKey(b.released_at);
      if (ad !== bd) return bd.localeCompare(ad);

      return (a.set || "").localeCompare(b.set || "");
    });
    return cards;
  }

  // =========================
  // Japanese name regex (furigana parentheses)
  // =========================
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Input like "量子の" should match "量（りょう）子（し）の謎（なぞ）かけ屋（や）"
  // - supports () and （）
  // - allows optional spaces
  function buildFuriganaRegex(input) {
    const trimmed = String(input || "").trim();
    const chars = Array.from(trimmed).filter((ch) => ch !== " " && ch !== "　");
    if (chars.length === 0) return "";

    const BR = "(?:\\(|（)[^\\)）]*(?:\\)|）)";

    const parts = chars.map((ch) => {
      const c = escapeRegex(ch);
      return `${c}(?:\\s*${BR})?`;
    });

    return parts.join("\\s*");
  }

  function buildSimpleContainsRegex(input) {
    // simplest: escape as-is (keeps "、" etc)
    const s = String(input || "").trim();
    if (!s) return "";
    return escapeRegex(s);
  }

  async function searchCards(rawInput) {
    const s = rawInput.trim();
    if (!s) {
      state.results = [];
      renderResults();
      setStatus("検索ワードを入力してください");
      return;
    }

    const preferJa = $("preferJa").checked;
    const collapseSame = $("collapseSame").checked;

    setStatus("検索中…");

    const isJaInput = looksJapanese(s);

    // Advanced query: keep as-is (optionally try lang:ja first)
    if (isAdvancedQuery(s)) {
      const queries =
        preferJa && isJaInput && !/(^|\s)lang:/i.test(s)
          ? [`lang:ja ${s}`, s]
          : [s];

      for (const q of queries) {
        const r = await fetchSearch(q);
        const arr = Array.isArray(r.data?.data) ? r.data.data : [];
        if (arr.length > 0) {
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

    // =========================================================
    // IMPORTANT:
    // Japanese input must be NAME-LIMITED.
    // We DO NOT use: "lang:ja <text>" (too broad -> unrelated cards)
    // We DO NOT use: /cards/named?fuzzy=... (404 for partial Japanese)
    // =========================================================
    if (isJaInput) {
      const merged = new Map();
      const pushAll = (arr) => {
        for (const c of arr) merged.set(c.id, c);
      };

      // 1) simple contains (fast)
      //    "量子の" -> name:/量子の/
      const rx1 = buildSimpleContainsRegex(s);
      const q1 = `lang:ja name:/${rx1}/`;
      const r1 = await fetchSearch(q1);
      pushAll(Array.isArray(r1.data?.data) ? r1.data.data : []);

      // 2) furigana parentheses tolerant
      //    "量子の" -> name:/量(?:（…）)?子(?:（…）)?の/
      if (merged.size === 0) {
        const rx2 = buildFuriganaRegex(s);
        if (rx2) {
          const q2 = `lang:ja name:/${rx2}/`;
          const r2 = await fetchSearch(q2);
          pushAll(Array.isArray(r2.data?.data) ? r2.data.data : []);
        }
      }

      // 3) extra-loose fallback (only if still empty)
      if (merged.size === 0) {
        const rx2 = buildFuriganaRegex(s);
        if (rx2) {
          // allow any chars between tokens to absorb unexpected separators
          const rxLoose = rx2.replace(/\\s\*/g, ".*?");
          const q3 = `lang:ja name:/${rxLoose}/`;
          const r3 = await fetchSearch(q3);
          pushAll(Array.isArray(r3.data?.data) ? r3.data.data : []);
        }
      }

      if (merged.size > 0) {
        let rawCards = Array.from(merged.values());
        rawCards = applyCollapseSame(rawCards, s, preferJa, collapseSame);
        let cards = rawCards.map(normalizeCard);
        cards = sortResults(cards, s, preferJa);

        state.results = cards;
        renderResults();
        setStatus(`ヒット: ${cards.length}件`);
        return;
      }

      // Japanese input: do NOT fall back to broad search (prevents unrelated cards)
      state.results = [];
      renderResults();
      setStatus("見つかりませんでした（日本語入力はカード名に限定して検索しています）");
      return;
    }

    // Non-Japanese input (English etc): use normal search
    {
      const rAny = await fetchSearch(s);
      const arr = Array.isArray(rAny.data?.data) ? rAny.data.data : [];
      if (arr.length > 0) {
        let rawCards = arr;
        rawCards = applyCollapseSame(rawCards, s, preferJa, collapseSame);

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
      return;
    }
  }

  // =========================
  // Deck (Main/Side)
  // =========================
  function boardObj(board) {
    return board === "side" ? state.deck.side : state.deck.main;
  }

  function countBoard(obj) {
    return Object.values(obj).reduce((sum, x) => sum + (x.qty || 0), 0);
  }

  function listEntries(obj) {
    const arr = Object.values(obj);
    const mode = $("sortDeck")?.value || "name"; // "name" | "cmc" | "type"

    arr.sort((a, b) => {
      const aName = a.sort_name || normalizeForSortName(a.name || "");
      const bName = b.sort_name || normalizeForSortName(b.name || "");

      const aTypeOrder = (typeof a.type_order === "number") ? a.type_order : primaryTypeOrder(a.type_line || "");
      const bTypeOrder = (typeof b.type_order === "number") ? b.type_order : primaryTypeOrder(b.type_line || "");

      const aCmc = Number(a.cmc ?? 0);
      const bCmc = Number(b.cmc ?? 0);

      if (mode === "type") {
        // タイプ順 → MV → 名前
        if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder;
        if (aCmc !== bCmc) return aCmc - bCmc;
        const n = aName.localeCompare(bName, "ja");
        if (n !== 0) return n;
      } else if (mode === "cmc") {
        // MV → タイプ順 → 名前
        if (aCmc !== bCmc) return aCmc - bCmc;
        if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder;
        const n = aName.localeCompare(bName, "ja");
        if (n !== 0) return n;
      } else {
        // 名前 → タイプ順 → MV
        const n = aName.localeCompare(bName, "ja");
        if (n !== 0) return n;
        if (aTypeOrder !== bTypeOrder) return aTypeOrder - bTypeOrder;
        if (aCmc !== bCmc) return aCmc - bCmc;
      }

      return String(a.id || "").localeCompare(String(b.id || ""));
    });

    return arr;
  }

  function addToBoard(board, card, delta = 1) {
    const obj = boardObj(board);
    const cur = obj[card.id];
    if (cur) cur.qty += delta;
    else obj[card.id] = { ...card, qty: delta };

    state.deck.updatedAt = new Date().toISOString();
    renderDeck();
  }

  function changeQty(board, cardId, delta, keepZero = false) {
    const obj = boardObj(board);
    const it = obj[cardId];
    if (!it) return;

    it.qty += delta;

    if (it.qty <= 0) {
      if (keepZero) it.qty = 0;
      else delete obj[cardId];
    }

    state.deck.updatedAt = new Date().toISOString();
    renderDeck();

    if (state.openCard && state.openCard.board === board && state.openCard.id === cardId) {
      renderCardModal();
    }
  }

  function moveCard(from, to, cardId) {
    if (from === to) return;
    const a = boardObj(from);
    const b = boardObj(to);
    const it = a[cardId];
    if (!it) return;
    if ((it.qty || 0) <= 0) return;

    if (b[cardId]) b[cardId].qty += it.qty;
    else b[cardId] = it;
    delete a[cardId];

    state.deck.updatedAt = new Date().toISOString();
    renderDeck();

    if (state.openCard && state.openCard.id === cardId) {
      state.openCard.board = to;
      renderCardModal();
    }
  }

  function cleanupZeros() {
    for (const b of ["main", "side"]) {
      const obj = boardObj(b);
      for (const id of Object.keys(obj)) {
        if ((obj[id]?.qty ?? 0) <= 0) delete obj[id];
      }
    }
  }

  function clearBoards() {
    state.deck.main = {};
    state.deck.side = {};
    state.deck.updatedAt = new Date().toISOString();
    setCurrentDeckName("");
    renderDeck();
    setStatus("Main/Side を全消ししました");
  }

  // =========================
  // Render Search Results
  // =========================
  function renderResults() {
    const grid = $("resultsGrid");
    const list = $("resultsList");
    grid.innerHTML = "";
    list.innerHTML = "";

    for (const c of state.results) {
      // ---- grid card ----
      const wrap = document.createElement("div");
      wrap.className = "card";

      const img = document.createElement("img");
      img.loading = "lazy";
      img.alt = c.name;
      img.src = c.image || "";
      img.onerror = () => {
        img.style.display = "none";
      };

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

      // ---- list row ----
      const row = document.createElement("div");
      row.className = "row";

      const limg = document.createElement("img");
      limg.loading = "lazy";
      limg.alt = c.name;
      limg.src = c.image || "";
      limg.onerror = () => {
        limg.style.display = "none";
      };

      const rmeta = document.createElement("div");
      rmeta.className = "rmeta";

      const rname = document.createElement("div");
      rname.className = "rname";
      rname.textContent = c.name;

      const rsub = document.createElement("div");
      rsub.className = "rsub";
      rsub.textContent = `${c.set}${c.collector ? " #" + c.collector : ""}${c.lang ? " / " + c.lang : ""}${c.released_at ? " / " + c.released_at : ""}`;

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
      rmeta.append(rname, rsub, ractions);

      row.append(limg, rmeta);
      list.appendChild(row);
    }
  }

  // =========================
  // Render Deck
  // =========================
  function makeTile(boardName, it) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.title = `${it.qty}x ${it.name}`;

    const img = document.createElement("img");
    img.alt = it.name;
    img.src = it.image || "";
    img.loading = "lazy";
    img.onerror = () => {
      img.style.display = "none";
    };

    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = it.qty;

    tile.append(img, badge);

    tile.addEventListener("click", (e) => {
      e.preventDefault();
      openCardModal(boardName, it.id);
    });

    return tile;
  }

  function renderTiles(container, obj, boardName) {
    container.innerHTML = "";
    for (const it of listEntries(obj)) {
      container.appendChild(makeTile(boardName, it));
    }
  }

  function renderDeck() {
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
  }

  // =========================
  // Modals
  // =========================
  function showOverlay(id) {
    const ov = $(id);
    ov.classList.add("show");
    ov.setAttribute("aria-hidden", "false");
  }

  function hideOverlay(id) {
    const ov = $(id);
    ov.classList.remove("show");
    ov.setAttribute("aria-hidden", "true");
  }

  function openCardModal(board, cardId) {
    state.openCard = { board, id: cardId };
    renderCardModal();
    showOverlay("cardModalOverlay");
  }

  function closeCardModal() {
    cleanupZeros();
    state.openCard = null;
    hideOverlay("cardModalOverlay");
    renderDeck();
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderCardModal() {
    const body = $("cardModalBody");
    if (!state.openCard) {
      body.innerHTML = "";
      return;
    }
    const { board, id } = state.openCard;
    const obj = boardObj(board);
    const it = obj[id];

    const safe = it || { id, name: "(カード)", qty: 0, scryfall_uri: "#", image: "" };

    $("cardModalTitle").textContent = `${board === "main" ? "Main" : "Side"}のカード操作`;

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

    $("cmPlus").onclick = () => changeQty(board, id, +1, true);
    $("cmMinus").onclick = () => changeQty(board, id, -1, true);

    $("cmMove").onclick = () => {
      const to = board === "main" ? "side" : "main";
      moveCard(board, to, id);
    };

    $("cmOpen").onclick = () => {
      if (safe.scryfall_uri && safe.scryfall_uri !== "#") {
        window.open(safe.scryfall_uri, "_blank", "noopener,noreferrer");
      }
    };

    if ((safe.qty || 0) <= 0) $("cmMove").disabled = true;
  }

  function openSettingsModal() {
    $("deckName").value = state.currentDeckName || "";
    refreshDeckSelect();
    showOverlay("settingsModalOverlay");
  }

  function closeSettingsModal() {
    hideOverlay("settingsModalOverlay");
  }

  // =========================
  // Save / Load / Delete Deck
  // =========================
  function saveCurrentDeck() {
    const name = $("deckName").value.trim();
    if (!name) {
      setStatus("デッキ名を入力してください");
      return;
    }

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

  function loadDeckByName(name) {
    const store = loadStore();
    const d = store.decks[name];
    if (!d) {
      setStatus(`見つかりません: ${name}`);
      return;
    }

    state.deck = {
      name: d.name || name,
      updatedAt: d.updatedAt || new Date().toISOString(),
      main: d.main || {},
      side: d.side || {},
    };

    setCurrentDeckName(name);
    renderDeck();
    setStatus(`読み込みました: ${name}`);
  }

  function deleteDeckByName(name) {
    const store = loadStore();
    if (!store.decks[name]) {
      setStatus(`見つかりません: ${name}`);
      return;
    }
    delete store.decks[name];
    saveStore(store);

    refreshDeckSelect();
    setStatus(`削除しました: ${name}`);

    if (state.currentDeckName === name) {
      setCurrentDeckName("");
      state.deck = newEmptyDeck("");
      renderDeck();
