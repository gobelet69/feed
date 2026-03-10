var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const method = req.method;
    let path = url.pathname;
    if (path.startsWith("/feed")) {
      path = path.substring(5) || "/";
    }
    if (path === "") path = "/";
    const cookie = req.headers.get("Cookie") || "";
    const sessionId = cookie.split(";").find((c) => c.trim().startsWith("sess="))?.split("=")[1];
    let user = null;
    if (sessionId) {
      user = await env.AUTH_DB.prepare("SELECT * FROM sessions WHERE id = ? AND expires > ?").bind(sessionId, Date.now()).first();
    }
    if (!user) {
      return new Response(null, {
        status: 302,
        headers: { "Location": `/auth/login?redirect=${encodeURIComponent(url.pathname)}` }
      });
    }
    if (path === "/api/feed/subscribe" && method === "POST") {
      const fd = await req.formData();
      const feed_id = fd.get("feed_id");
      await env.DB.prepare(
        "INSERT INTO user_feeds (user_id, feed_id, is_active, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id, feed_id) DO UPDATE SET is_active = 1"
      ).bind(user.username, feed_id, Date.now()).run();
      return new Response("OK");
    }
    if (path === "/api/feed/unsubscribe" && method === "POST") {
      const fd = await req.formData();
      const feed_id = fd.get("feed_id");
      await env.DB.prepare(
        "UPDATE user_feeds SET is_active = 0 WHERE user_id = ? AND feed_id = ?"
      ).bind(user.username, feed_id).run();
      return new Response("OK");
    }
    if (path === "/api/feed/add" && method === "POST") {
      const fd = await req.formData();
      const textRaw = fd.get("urls");
      if (!textRaw) return new Response("Missing URLs", { status: 400 });
      const lines = textRaw.split("\n").map((s) => s.trim()).filter((s) => s);
      if (lines.length === 0) return new Response("No valid URLs provided", { status: 400 });
      let addedCount = 0;
      const errors = [];
      for (const feedUrl of lines) {
        let existing = await env.DB.prepare("SELECT id FROM feeds WHERE url = ?").bind(feedUrl).first();
        let feed_id;
        if (existing) {
          feed_id = existing.id;
        } else {
          try {
            const rs = await fetchAndParseRSS(feedUrl);
            feed_id = crypto.randomUUID();
            let defaultName = lines.length === 1 ? fd.get("name") : "";
            let feedName = defaultName || rs.title || "Unknown Feed";
            let icon = fd.get("icon") || "\u{1F4F0}";
            await env.DB.prepare(
              "INSERT INTO feeds (id, name, url, icon, created_at) VALUES (?, ?, ?, ?, ?)"
            ).bind(feed_id, feedName, feedUrl, icon, Date.now()).run();
            for (const item of rs.items.slice(0, 15)) {
              await env.DB.prepare(
                "INSERT OR IGNORE INTO articles (id, feed_id, title, url, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
              ).bind(crypto.randomUUID(), feed_id, item.title, item.link, item.published_at, Date.now()).run();
            }
          } catch (err) {
            errors.push(`Failed ${feedUrl}: ${err.message}`);
            continue;
          }
        }
        await env.DB.prepare(
          "INSERT INTO user_feeds (user_id, feed_id, is_active, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(user_id, feed_id) DO UPDATE SET is_active = 1"
        ).bind(user.username, feed_id, Date.now()).run();
        addedCount++;
      }
      if (addedCount === 0 && errors.length > 0) {
        return new Response("Failed to add any feeds:\n" + errors.join("\n"), { status: 400 });
      }
      return new Response("OK");
    }
    if (path === "/api/feed/sync") {
      await this.processFeeds(env);
      return new Response("Sync Completed.");
    }
    if (path === "/" || path === "" || path === "/discover") {
      const isDiscover = path === "/discover";
      const { results: userFeeds } = await env.DB.prepare(
        "SELECT feed_id, is_active FROM user_feeds WHERE user_id = ?"
      ).bind(user.username).all();
      const subscribedFeedIds = userFeeds.filter((uf) => uf.is_active === 1).map((uf) => uf.feed_id);
      const userFeedMap = {};
      userFeeds.forEach((uf) => userFeedMap[uf.feed_id] = uf.is_active);
      const { results: allFeeds } = await env.DB.prepare("SELECT * FROM feeds ORDER BY name ASC").all();
      let articles = [];
      if (!isDiscover && subscribedFeedIds.length > 0) {
        const placeholders = subscribedFeedIds.map(() => "?").join(",");
        const query = `
                    SELECT a.id, a.title, a.url, a.published_at, f.name as feed_name, f.icon as feed_icon 
                    FROM articles a
                    JOIN feeds f ON a.feed_id = f.id
                    WHERE a.feed_id IN (${placeholders})
                    ORDER BY a.published_at DESC
                    LIMIT 200`;
        const { results } = await env.DB.prepare(query).bind(...subscribedFeedIds).all();
        articles = results;
      }
      return new Response(renderPage(user, allFeeds, userFeedMap, articles, isDiscover), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }
    return new Response("Not found", { status: 404 });
  },
  // Background CRON handler
  async scheduled(event, env, ctx) {
    ctx.waitUntil(this.processFeeds(env));
  },
  async processFeeds(env) {
    const { results: feeds } = await env.DB.prepare("SELECT id, url FROM feeds").all();
    for (const feed of feeds) {
      try {
        const rs = await fetchAndParseRSS(feed.url);
        for (const item of rs.items.slice(0, 15)) {
          await env.DB.prepare(
            "INSERT OR IGNORE INTO articles (id, feed_id, title, url, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(crypto.randomUUID(), feed.id, item.title, item.link, item.published_at, Date.now()).run();
        }
      } catch (err) {
        console.error(`Failed to fetch feed ${feed.url}: ${err.message}`);
      }
    }
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1e3;
    await env.DB.prepare("DELETE FROM articles WHERE published_at < ?").bind(thirtyDaysAgo).run();
  }
};
async function fetchAndParseRSS(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      "Accept": "application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const text = await res.text();
  let feedTitle = "";
  const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) feedTitle = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  const items = [];
  const itemRegex = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;
  while (match = itemRegex.exec(text)) {
    const itemHtml = match[1];
    let title = "";
    let link = "";
    let pubDateStr = "";
    const itemTitleMatch = itemHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (itemTitleMatch) title = itemTitleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&[^;]+;/gi, "$1").replace(/(<([^>]+)>)/gi, "").trim();
    const stdLinkMatch = itemHtml.match(/<link[^>]*>([^<]+)<\/link>/i);
    if (stdLinkMatch && stdLinkMatch[1].trim() !== "") {
      link = stdLinkMatch[1].trim();
    } else {
      const atomLinkMatch = itemHtml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      if (atomLinkMatch) link = atomLinkMatch[1];
    }
    const pubDateMatch = itemHtml.match(/<(?:pubdate|published|updated)[^>]*>([^<]+)<\/(?:pubdate|published|updated)>/i);
    if (pubDateMatch) pubDateStr = pubDateMatch[1].trim();
    let published_at = Date.now();
    if (pubDateStr) {
      const parsed = new Date(pubDateStr).getTime();
      if (!isNaN(parsed)) published_at = parsed;
    }
    if (title && link) {
      items.push({ title, link, published_at });
    }
  }
  return { title: feedTitle || "Feed", items };
}
__name(fetchAndParseRSS, "fetchAndParseRSS");
var CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
:root{
  --bg:#09090b;--card:#18181b;--card2:#27272a;--txt:#fafafa;--muted:#a1a1aa;
  --dim:#52525b;--p:#8b5cf6;--ph:#7c3aed;--s:#0ea5e9;--err:#ef4444;
  --good:#10b981;--border:rgba(255,255,255,0.08);--ring:rgba(139,92,246,0.4)
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--txt);min-height:100vh;line-height:1.6}
a{color:var(--p);text-decoration:none}
a:hover{color:#a78bfa}

/* HEADER */
header{display:flex;justify-content:space-between;align-items:center;height:64px;padding:0 24px;
  background:rgba(24,24,27,0.8);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);
  position:sticky;top:0;z-index:50}

.nav-links{display:flex;gap:4px;align-items:center}
.nav-link{padding:8px 16px;border-radius:20px;color:var(--muted);font-weight:600;font-size:0.9em;transition:all .2s;text-decoration:none}
.nav-link:hover{color:var(--txt);background:rgba(255,255,255,0.05)}
.nav-link.active{color:var(--bg);background:var(--txt)}

/* USER DROPDOWN */
.user-wrap{position:relative}
.user-btn{display:flex;align-items:center;gap:8px;color:var(--txt);font-size:0.9em;font-weight:500;
  padding:8px 13px;border-radius:9px;background:rgba(255,255,255,0.05);
  border:1px solid var(--border);cursor:pointer;transition:background .2s;font-family:inherit}
.user-btn:hover{background:rgba(255,255,255,0.09)}
.caret{opacity:.5;transition:transform .2s;margin-left:2px}
.user-wrap.open .caret{transform:rotate(180deg)}
.dd{display:none;position:absolute;right:0;top:calc(100% + 10px);
  background:#18181b;border:1px solid var(--border);border-radius:14px;
  min-width:200px;box-shadow:0 20px 56px rgba(0,0,0,.6);z-index:999;overflow:hidden}
.user-wrap.open .dd{display:block;animation:dd .15s ease-out}
@keyframes dd{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:translateY(0)}}
.dd-hdr{padding:14px 16px 10px;border-bottom:1px solid var(--border)}
.dd-name{font-weight:700;font-size:.95em;margin-bottom:2px}
.dd-sub{font-size:.75em;color:var(--muted)}
.ddl{display:flex;align-items:center;gap:10px;padding:11px 16px;color:var(--txt);
  text-decoration:none;font-size:.9em;font-weight:500;transition:background .15s}
.ddl:hover{background:rgba(255,255,255,.05);color:var(--txt)}
.dd-sep{height:1px;background:var(--border);margin:4px 0}
.ddl.out{color:var(--err)!important}
.ddl.out:hover{background:rgba(239,68,68,.08)!important}

/* MAIN */
main{padding:40px 24px 80px;max-width:800px;margin:0 auto}
.top-bar{margin-bottom:32px;display:flex;justify-content:space-between;align-items:center}
.page-title{font-size:2.4em;font-weight:800;color:#fff;letter-spacing:-.04em;line-height:1.2}
.page-sub{font-size:1.05em;color:var(--muted);margin-top:6px}

/* BUTTONS */
button,input[type=submit]{cursor:pointer;font-family:inherit}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 18px;border-radius:10px;
  font-size:.9em;font-weight:600;border:none;transition:all .2s;cursor:pointer}
.btn-primary{background:var(--p);color:#fff}
.btn-primary:hover{background:var(--ph);transform:translateY(-1px);box-shadow:0 4px 14px rgba(139,92,246,.35)}
.btn-outline{background:transparent;color:var(--txt);border:1px solid var(--border)}
.btn-outline:hover{background:rgba(255,255,255,0.05)}
.btn-ghost{background:rgba(255,255,255,.05);color:var(--muted);border:1px solid transparent}
.btn-ghost:hover{background:rgba(255,255,255,.1);color:var(--txt)}

/* ARTICLES LIST */
.article-group{margin-bottom:16px;animation:slideUp .4s ease-out backwards}
.article-card{display:flex;flex-direction:column;gap:10px;background:var(--card);border:1px solid var(--border);
  padding:20px;border-radius:16px;text-decoration:none;color:var(--txt);transition:all .2s;
  position:relative;overflow:hidden}
.article-card::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:transparent;transition:background .2s}
.article-card:hover{border-color:rgba(139,92,246,.4);transform:translateY(-2px);
  box-shadow:0 12px 32px rgba(0,0,0,.3)}
.article-card:hover::before{background:var(--p)}
.article-meta{display:flex;align-items:center;gap:8px;font-size:0.85em;color:var(--muted);font-weight:500}
.feed-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  background:rgba(255,255,255,0.1);border-radius:6px;font-size:14px}
.article-title{font-size:1.15em;font-weight:700;line-height:1.4}
.article-domain{font-size:0.8em;color:var(--dim)}

/* DISCOVER LIST */
.discover-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(300px, 1fr));gap:16px}
.feed-card{background:var(--card);border:1px solid var(--border);padding:24px;border-radius:16px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;transition:all .2s}
.feed-card:hover{border-color:var(--border);background:var(--card2)}
.feed-info{display:flex;align-items:center;gap:16px;flex:1;min-width:0}
.feed-icon-large{font-size:2em;width:48px;height:48px;display:flex;align-items:center;
  justify-content:center;background:rgba(255,255,255,0.05);border-radius:12px;flex-shrink:0}
.feed-text{display:flex;flex-direction:column;min-width:0}
.feed-name{font-weight:700;font-size:1.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.feed-url{font-size:0.8em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.btn-toggle[data-active="true"]{background:var(--p);color:#fff;border-color:var(--p)}
.btn-toggle[data-active="false"]{background:transparent;color:var(--txt);border:1px solid var(--border)}

/* MODALS & FORMS */
input[type=text],input[type=url],textarea{
  background:rgba(0,0,0,.3);border:1px solid var(--border);color:var(--txt);
  padding:12px 16px;border-radius:12px;font-family:inherit;font-size:.95em;
  transition:all .2s;width:100%}
input:focus,textarea:focus{outline:none;border-color:var(--p);box-shadow:0 0 0 3px var(--ring)}

.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.8);
  z-index:1000;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(6px)}
.modal-bg.open{display:flex;animation:fadeIn .2s ease-out}
@keyframes fadeIn{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
.modal-box{background:#18181b;border:1px solid var(--border);border-radius:24px;
  padding:32px;width:100%;max-width:480px;box-shadow:0 28px 72px rgba(0,0,0,.7)}
.modal-title{font-size:1.4em;font-weight:800;margin-bottom:8px}
.modal-sub{font-size:0.9em;color:var(--muted);margin-bottom:24px}
.form-group{margin-bottom:20px}
.form-group label{display:block;font-size:.85em;font-weight:600;color:var(--muted);
  margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em}
.btn-row{display:flex;gap:12px;margin-top:32px}
.btn-row .btn{flex:1;justify-content:center}

.empty-state{text-align:center;padding:80px 20px;color:var(--muted)}
.empty-icon{font-size:3.5em;margin-bottom:16px}
.empty-title{font-size:1.4em;font-weight:700;color:var(--txt);margin-bottom:8px}
.empty-sub{font-size:.95em;max-width:400px;margin:0 auto 24px}

@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
`;
function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
__name(esc, "esc");
function timeAgo(ms) {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 6e4);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const d = Math.floor(hr / 24);
  return `${d} day${d !== 1 ? "s" : ""} ago`;
}
__name(timeAgo, "timeAgo");
function renderHeader(username, isDiscover) {
  const id = "cuw";
  return `
  <div style="display:flex;align-items:center;gap:32px;">
    <a href="/feed" style="text-decoration:none;display:flex;align-items:center;gap:12px;">
      <span style="width:36px;height:36px;background:linear-gradient(135deg,#8b5cf6,#10b981);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.9em;color:#fff;box-shadow:0 0 20px rgba(139,92,246,.4)">111</span>
      <div style="display:flex;flex-direction:column;line-height:1.2">
        <span style="font-weight:800;font-size:1.15em;color:#fff;letter-spacing:-.02em">Feed<span style="color:#8b5cf6">.</span></span>
      </div>
    </a>
    <div class="nav-links">
      <a href="/feed" class="nav-link ${!isDiscover ? "active" : ""}">My Feed</a>
      <a href="/feed/discover" class="nav-link ${isDiscover ? "active" : ""}">Manage Feeds</a>
    </div>
  </div>
  <div class="user-wrap" id="${id}">
    <button class="user-btn" onclick="document.getElementById('${id}').classList.toggle('open')">
      ${esc(username)}
      <svg class="caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
    </button>
    <div class="dd">
      <div class="dd-hdr">
        <div class="dd-name">${esc(username)}</div>
        <div class="dd-sub">111 Feed</div>
      </div>
      <a href="/auth/account" class="ddl">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>
        Account Preferences
      </a>
      <div class="dd-sep"></div>
      <a href="/auth/logout" class="ddl out">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </a>
    </div>
  </div>
  <script>document.addEventListener('click',e=>{const w=document.getElementById('${id}');if(w&&!w.contains(e.target))w.classList.remove('open');});<\/script>`;
}
__name(renderHeader, "renderHeader");
function renderPage(user, allFeeds, userFeedMap, articles, isDiscover) {
  let mainHtml = "";
  if (isDiscover) {
    mainHtml = `
        <div class="top-bar">
          <div>
            <h1 class="page-title">Manage Feeds</h1>
            <p class="page-sub">Discover and subscribe to top RSS feeds globally across 111iridescence.</p>
          </div>
          <button class="btn btn-primary" onclick="openAddModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add New RSS Source
          </button>
        </div>
        
        <div class="discover-grid">
          ${allFeeds.length === 0 ? '<p style="color:var(--muted)">No feeds exist globally yet. Be the first to add one!</p>' : ""}
          ${allFeeds.map((f) => {
      const isActive = userFeedMap[f.id] === 1;
      return `
              <div class="feed-card">
                <div class="feed-info">
                  <div class="feed-icon-large">${esc(f.icon)}</div>
                  <div class="feed-text">
                    <div class="feed-name">${esc(f.name)}</div>
                    <div class="feed-url">${esc(f.url.replace(/^https?:\/\//, ""))}</div>
                  </div>
                </div>
                <button class="btn btn-toggle" data-active="${isActive}" onclick="toggleFeed('${f.id}', ${isActive})">
                  ${isActive ? "Subscribed" : "Subscribe"}
                </button>
              </div>`;
    }).join("")}
        </div>
        `;
  } else {
    const hasSubscriptions = Object.values(userFeedMap).some((v) => v === 1);
    if (!hasSubscriptions) {
      mainHtml = `
            <div class="empty-state">
              <div class="empty-icon">\u{1F4F0}</div>
              <div class="empty-title">Your feed is empty</div>
              <div class="empty-sub">You aren't subscribed to any RSS streams yet. Head over to Manage Feeds to discover articles.</div>
              <a href="/feed/discover" class="btn btn-primary">Discover Feeds</a>
            </div>`;
    } else if (articles.length === 0) {
      mainHtml = `
            <div class="empty-state">
              <div class="empty-icon">\u23F3</div>
              <div class="empty-title">Waiting for articles...</div>
              <div class="empty-sub">We're fetching the latest articles from your subscriptions. They will appear here shortly.</div>
              <button class="btn btn-outline" onclick="forceSync()" id="sync-btn">Force Sync Now</button>
            </div>`;
    } else {
      mainHtml = `
            <div class="top-bar">
              <div>
                <h1 class="page-title">Your Feed</h1>
                <p class="page-sub">The latest articles from your subscribed sources.</p>
              </div>
            </div>
            
            <div style="display:flex;flex-direction:column;gap:16px;">
              ${articles.map((a, i) => `
              <div class="article-group" style="animation-delay:${i * 0.04}s">
                <a class="article-card" href="${esc(a.url)}" target="_blank" rel="noopener">
                  <div class="article-meta">
                    <span class="feed-icon">${esc(a.feed_icon)}</span>
                    <span style="color:var(--txt)">${esc(a.feed_name)}</span>
                    <span>\u2022</span>
                    <span>${timeAgo(a.published_at)}</span>
                  </div>
                  <h2 class="article-title">${esc(a.title)}</h2>
                  <div class="article-domain">${esc(new URL(a.url).hostname.replace("www.", ""))}</div>
                </a>
              </div>`).join("")}
            </div>`;
    }
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Feed \u2014 111iridescence</title>
  <style>${CSS}</style>
</head>
<body>
  <header>${renderHeader(user.username, isDiscover)}</header>
  <main>${mainHtml}</main>

  <!-- ADD FEED MODAL -->
  <div class="modal-bg" id="add-modal" onclick="if(event.target===this)closeModals()">
    <div class="modal-box">
      <h2 class="modal-title">Bulk Import Global RSS Feeds</h2>
      <p class="modal-sub">Add one or multiple valid RSS/Atom links (one URL per line). You will be auto-subscribed to all of them.</p>
      <form onsubmit="event.preventDefault();submitFeed(this)">
        <div class="form-group">
          <label>RSS Feed URLs</label>
          <textarea name="urls" rows="4" placeholder="https://news.ycombinator.com/rss&#10;https://www.theverge.com/rss/index.xml" required autofocus style="resize:vertical"></textarea>
        </div>
        <div class="form-group">
          <label>Custom Name (Optional - Only applies if adding 1 Feed)</label>
          <input type="text" name="name" placeholder="Leave blank to auto-detect">
        </div>
        <div class="form-group">
          <label>Emoji Icon (Optional)</label>
          <input type="text" name="icon" placeholder="\u{1F4F0}" value="\u{1F4F0}" maxlength="2">
        </div>
        <div class="btn-row">
          <button type="submit" class="btn btn-primary" id="add-submit-btn">Add & Subscribe</button>
          <button type="button" class="btn btn-ghost" onclick="closeModals()">Cancel</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    const BASE = '/feed';

    function closeModals() {
      document.querySelectorAll('.modal-bg').forEach(m => m.classList.remove('open'));
    }

    function openAddModal() {
      document.getElementById('add-modal').classList.add('open');
    }

    async function toggleFeed(feedId, currentlyActive) {
      const endpoint = currentlyActive ? '/api/feed/unsubscribe' : '/api/feed/subscribe';
      const fd = new FormData();
      fd.append('feed_id', feedId);
      
      const r = await fetch(BASE + endpoint, { method: 'POST', body: fd });
      if (r.ok) location.reload(); else alert('Error updating subscription');
    }

    async function submitFeed(form) {
      const btn = document.getElementById('add-submit-btn');
      btn.textContent = 'Adding...';
      btn.disabled = true;
      
      const fd = new FormData(form);
      const r = await fetch(BASE + '/api/feed/add', { method: 'POST', body: fd });
      
      if (r.ok) {
        location.reload();
      } else {
        alert(await r.text());
        btn.textContent = 'Add & Subscribe';
        btn.disabled = false;
      }
    }

    async function forceSync() {
      const btn = document.getElementById('sync-btn');
      btn.textContent = 'Syncing...';
      btn.disabled = true;
      
      await fetch(BASE + '/api/feed/sync');
      location.reload();
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
  <\/script>
</body>
</html>`;
}
__name(renderPage, "renderPage");

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-FbjHge/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-FbjHge/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
