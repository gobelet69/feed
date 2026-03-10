/**
 * FEED — RSS Aggregator for top internet magazines
 * Route: 111iridescence.org/feed*
 */

export default {
    async fetch(req, env) {
        const url = new URL(req.url);
        const method = req.method;

        // Normalize path: strip /feed prefix
        let path = url.pathname;
        if (path.startsWith('/feed')) {
            path = path.substring(5) || '/';
        }
        if (path === '') path = '/';

        // SESSION MANAGEMENT — use global-auth DB

        const cookie = req.headers.get('Cookie') || '';
        const sessionId = cookie.split(';').find(c => c.trim().startsWith('sess='))?.split('=')[1];
        let user = null;
        if (sessionId) {
            user = await env.AUTH_DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires > ?')
                .bind(sessionId, Date.now()).first();
        }

        // PROTECTED — redirect to central auth if not logged in
        if (!user) {
            return new Response(null, {
                status: 302,
                headers: { 'Location': `/auth/login?redirect=${encodeURIComponent(url.pathname)}` }
            });
        }

        // ---------------- API ROUTES ----------------CRIBING & MANAGING FEEDS ────────────────────────────────

        if (path === '/api/feed/subscribe' && method === 'POST') {
            const fd = await req.formData();
            const feed_id = fd.get('feed_id');
            const list_name = fd.get('list_name') || 'Default';
            await env.DB.prepare(
                'INSERT INTO user_feeds (user_id, feed_id, list_name, is_active, created_at) VALUES (?, ?, ?, 1, ?) ' +
                'ON CONFLICT(user_id, feed_id) DO UPDATE SET is_active = 1, list_name = ?'
            ).bind(user.username, feed_id, list_name, Date.now(), list_name).run();
            return new Response('OK');
        }

        if (path === '/api/feed/unsubscribe' && method === 'POST') {
            const fd = await req.formData();
            const feed_id = fd.get('feed_id');
            await env.DB.prepare(
                'UPDATE user_feeds SET is_active = 0 WHERE user_id = ? AND feed_id = ?'
            ).bind(user.username, feed_id).run();
            return new Response('OK');
        }

        if (path === '/api/feed/move' && method === 'POST') {
            const fd = await req.formData();
            const feed_id = fd.get('feed_id');
            const list_name = fd.get('list_name') || 'Default';
            await env.DB.prepare(
                'UPDATE user_feeds SET list_name = ? WHERE user_id = ? AND feed_id = ?'
            ).bind(list_name, user.username, feed_id).run();
            return new Response('OK');
        }

        if (path === '/api/feed/add' && method === 'POST') {
            const fd = await req.formData();
            const textRaw = fd.get('urls');
            const list_name = fd.get('list_name') || 'Default';
            if (!textRaw) return new Response('Missing URLs', { status: 400 });

            // Split by newline, trim, filter empty lines
            const lines = textRaw.split('\n').map(s => s.trim()).filter(s => s);
            if (lines.length === 0) return new Response('No valid URLs provided', { status: 400 });

            let addedCount = 0;
            const errors = [];

            for (const feedUrl of lines) {
                // Ensure URL doesn't already exist
                let existing = await env.DB.prepare('SELECT id FROM feeds WHERE url = ?').bind(feedUrl).first();

                let feed_id;
                if (existing) {
                    feed_id = existing.id;
                } else {
                    try {
                        // Try to fetch it to get the title
                        const rs = await fetchAndParseRSS(feedUrl);
                        feed_id = crypto.randomUUID();
                        let defaultName = lines.length === 1 ? fd.get('name') : ''; // Only use custom name if 1 URL is passed
                        let feedName = defaultName || rs.title || 'Unknown Feed';
                        let icon = fd.get('icon') || '📰';

                        await env.DB.prepare(
                            'INSERT INTO feeds (id, name, url, icon, created_at) VALUES (?, ?, ?, ?, ?)'
                        ).bind(feed_id, feedName, feedUrl, icon, Date.now()).run();

                        // Instantly seed some articles so it's not empty
                        for (const item of rs.items.slice(0, 15)) {
                            await env.DB.prepare(
                                'INSERT OR IGNORE INTO articles (id, feed_id, title, url, image_url, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                            ).bind(crypto.randomUUID(), feed_id, item.title, item.link, item.image_url || null, item.published_at, Date.now()).run();
                        }
                    } catch (err) {
                        errors.push(`Failed ${feedUrl}: ${err.message}`);
                        continue; // Skip this one on failure, but continue the loop
                    }
                }

                // Auto subscribe user
                await env.DB.prepare(
                    'INSERT INTO user_feeds (user_id, feed_id, list_name, is_active, created_at) VALUES (?, ?, ?, 1, ?) ' +
                    'ON CONFLICT(user_id, feed_id) DO UPDATE SET is_active = 1, list_name = ?'
                ).bind(user.username, feed_id, list_name, Date.now(), list_name).run();

                addedCount++;
            }

            if (addedCount === 0 && errors.length > 0) {
                return new Response('Failed to add any feeds:\n' + errors.join('\n'), { status: 400 });
            }

            return new Response('OK');
        }

        // ── API: SYNC NOW (FOR MANUAL TESTING) ───────────────────────────────
        if (path === '/api/feed/sync') {
            // Trigger processing synchronously for demo purposes
            await this.processFeeds(env);
            return new Response('Sync Completed.');
        }

        // ── PAGE: DASHBOARD & DISCOVER ───────────────────────────────────────

        if (path === '/' || path === '' || path === '/discover') {
            const isDiscover = path === '/discover';

            // Get user's subscriptions
            const { results: userFeeds } = await env.DB.prepare(
                'SELECT feed_id, list_name, is_active FROM user_feeds WHERE user_id = ?'
            ).bind(user.username).all();

            const subscribedFeedIds = userFeeds.filter(uf => uf.is_active === 1).map(uf => uf.feed_id);
            const userFeedMap = {};
            const userListMap = {};
            userFeeds.forEach(uf => {
                userFeedMap[uf.feed_id] = uf.is_active;
                userListMap[uf.feed_id] = uf.list_name || 'Default';
            });

            // Get all feeds globally
            const { results: allFeeds } = await env.DB.prepare('SELECT * FROM feeds ORDER BY name ASC').all();

            // Render articles only if we are on Dashboard (and user is subscribed to some feeds)
            let articles = [];
            let allLists = [];
            let currentList = url.searchParams.get('list') || 'All';

            if (!isDiscover && subscribedFeedIds.length > 0) {
                let activeSubscriptions = userFeeds.filter(uf => uf.is_active === 1);
                allLists = ['All', ...new Set(activeSubscriptions.map(uf => uf.list_name || 'Default'))].sort();

                if (currentList !== 'All') {
                    activeSubscriptions = activeSubscriptions.filter(uf => (uf.list_name || 'Default') === currentList);
                }
                const filterIds = activeSubscriptions.map(uf => uf.feed_id);

                if (filterIds.length > 0) {
                    const placeholders = filterIds.map(() => '?').join(',');
                    const query = `
                        SELECT a.id, a.title, a.url, a.image_url, a.published_at, f.name as feed_name, f.icon as feed_icon 
                        FROM articles a
                        JOIN feeds f ON a.feed_id = f.id
                        WHERE a.feed_id IN (${placeholders})
                        ORDER BY a.published_at DESC
                        LIMIT 200`
                        ;
                    const { results } = await env.DB.prepare(query).bind(...filterIds).all();
                    articles = results;
                }
            }

            return new Response(renderPage(user, allFeeds, userFeedMap, userListMap, articles, isDiscover, allLists, currentList), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        return new Response('Not found', { status: 404 });
    },

    // Background CRON handler
    async scheduled(event, env, ctx) {
        ctx.waitUntil(this.processFeeds(env));
    },

    async processFeeds(env) {
        // Fetch all registered global feeds
        const { results: feeds } = await env.DB.prepare('SELECT id, url FROM feeds').all();

        for (const feed of feeds) {
            try {
                const rs = await fetchAndParseRSS(feed.url);
                for (const item of rs.items.slice(0, 15)) { // take top 15 from each
                    // Insert or ignore if URL already exists
                    await env.DB.prepare(
                        'INSERT OR IGNORE INTO articles (id, feed_id, title, url, image_url, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).bind(crypto.randomUUID(), feed.id, item.title, item.link, item.image_url || null, item.published_at, Date.now()).run();
                }
            } catch (err) {
                console.error(`Failed to fetch feed ${feed.url}: ${err.message}`);
            }
        }

        // Optimize: Delete articles older than 30 days to save D1 space
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        await env.DB.prepare('DELETE FROM articles WHERE published_at < ?').bind(thirtyDaysAgo).run();
    }
};

// ── UTILITIES ───────────────────────────────────────────────────────────────

async function fetchAndParseRSS(feedUrl) {
    const res = await fetch(feedUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/rss+xml, application/rdf+xml, application/atom+xml, application/xml, text/xml'
        }
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();

    // Very basic regex-based parser (works for simple RSS/Atom)
    let feedTitle = '';
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) feedTitle = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();

    const items = [];
    // match <item> or <entry>
    const itemRegex = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    let match;
    while ((match = itemRegex.exec(text))) {
        const itemHtml = match[1];
        let title = '';
        let link = '';
        let pubDateStr = '';
        let image_url = '';

        const itemTitleMatch = itemHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (itemTitleMatch) title = itemTitleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&[^;]+;/gi, '$1').replace(/(<([^>]+)>)/gi, "").trim();

        // extract link. RSS uses <link>url</link>, Atom uses <link href="url" />
        const stdLinkMatch = itemHtml.match(/<link[^>]*>([^<]+)<\/link>/i);
        // Sometimes RSS embeds CDATA inside link
        if (stdLinkMatch && stdLinkMatch[1].trim() !== '' && !stdLinkMatch[1].includes('href=')) {
            link = stdLinkMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        } else {
            const atomLinkMatch = itemHtml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
            if (atomLinkMatch) link = atomLinkMatch[1];
        }

        const pubDateMatch = itemHtml.match(/<(?:pubdate|published|updated)[^>]*>([^<]+)<\/(?:pubdate|published|updated)>/i);
        if (pubDateMatch) pubDateStr = pubDateMatch[1].trim();

        // --- IMAGE EXTRACTION ---
        // 1. Try <media:content url="..."> or <media:thumbnail url="...">
        const mediaMatch = itemHtml.match(/<media:(?:content|thumbnail)[^>]+url=["']([^"']+)["'][^>]*>/i);
        if (mediaMatch) {
            image_url = mediaMatch[1];
        } else {
            // 2. Try falling back to extracting the first <img src="..."> anywhere in the item string
            // Decode basic entities first because ATOM feeds often use &lt;img src=&quot;...&quot;&gt;
            const decodedHtml = itemHtml.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'");
            const imgMatch = decodedHtml.match(/<img[^>]+src=["']([^"']+)["']/i);

            if (imgMatch) {
                // Decode url &amp; entities
                image_url = imgMatch[1].replace(/&amp;/g, '&').replace(/&#038;/g, '&');
            }
        }

        let published_at = Date.now();
        if (pubDateStr) {
            const parsed = new Date(pubDateStr).getTime();
            if (!isNaN(parsed)) published_at = parsed;
        }

        if (title && link) {
            items.push({ title, link, image_url, published_at });
        }
    }
    return { title: feedTitle || 'Feed', items };
}

// ── HTML VIEWS ───────────────────────────────────────────────────────────────

const CSS = `
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
.article-card{display:flex;flex-direction:row;gap:16px;background:var(--card);border:1px solid var(--border);
  padding:16px;border-radius:16px;text-decoration:none;color:var(--txt);transition:all .2s;
  position:relative;overflow:hidden;align-items:center}
.article-card::before{content:'';position:absolute;top:0;left:0;width:3px;height:100%;
  background:transparent;transition:background .2s}
.article-card:hover{border-color:rgba(139,92,246,.4);transform:translateY(-2px);
  box-shadow:0 12px 32px rgba(0,0,0,.3);background:var(--card2)}
.article-card:hover::before{background:var(--p)}

.article-image-wrap{width:130px;height:90px;flex-shrink:0;border-radius:10px;overflow:hidden;
  background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;
  border:1px solid var(--border)}
.article-image{width:100%;height:100%;object-fit:cover;transition:transform .4s}
.article-card:hover .article-image{transform:scale(1.05)}

.article-content{display:flex;flex-direction:column;flex:1;min-width:0;justify-content:center;gap:6px}
.article-meta{display:flex;align-items:center;gap:8px;font-size:0.85em;color:var(--muted);font-weight:500}
.feed-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;
  background:rgba(255,255,255,0.1);border-radius:6px;font-size:14px}
.article-title{font-size:1.1em;font-weight:700;line-height:1.35;margin-bottom:2px}
.article-domain{font-size:0.8em;color:var(--dim)}

/* DISCOVER LIST & UX */
.feed-section-title{font-size:1.2em;font-weight:700;color:var(--txt);margin:32px 0 16px;display:flex;align-items:center;gap:8px}
.feed-list{display:flex;flex-direction:column;gap:12px;margin-bottom:48px}
.feed-row{background:var(--card);border:1px solid var(--border);padding:16px 20px;border-radius:16px;
  display:flex;align-items:center;justify-content:space-between;gap:24px;transition:all .2s}
.feed-row:hover{border-color:rgba(139,92,246,.3);background:var(--card2);transform:translateX(4px)}
.feed-info{display:flex;align-items:center;gap:16px;flex:1;min-width:0}
.feed-icon-large{font-size:1.8em;width:44px;height:44px;display:flex;align-items:center;
  justify-content:center;background:rgba(255,255,255,0.05);border-radius:12px;flex-shrink:0}
.feed-text{display:flex;flex-direction:column;min-width:0}
.feed-name{font-weight:700;font-size:1.1em;line-height:1.3;margin-bottom:2px}
.feed-url{font-size:0.85em;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace}
.feed-actions{display:flex;align-items:center;gap:12px;flex-shrink:0}
.btn-toggle[data-active="true"]{background:var(--p);color:#fff;border-color:var(--p)}
.btn-toggle[data-active="false"]{background:transparent;color:var(--txt);border:1px solid var(--border)}

.list-badge{font-size:0.85em;color:var(--muted);background:rgba(255,255,255,0.05);padding:6px 14px;border-radius:20px;display:flex;align-items:center;gap:6px;cursor:pointer;transition:all .2s;border:1px solid transparent;font-weight:600}
.list-badge:hover{background:rgba(139,92,246,0.1);color:#a78bfa;border-color:rgba(139,92,246,0.3)}
.list-tabs{display:flex;gap:8px;margin-bottom:24px;overflow-x:auto;padding-bottom:8px}
.list-tabs::-webkit-scrollbar{display:none}
.list-tab{padding:8px 16px;border-radius:20px;background:rgba(255,255,255,0.03);color:var(--muted);font-size:0.9em;font-weight:600;text-decoration:none;transition:all .2s;white-space:nowrap;border:1px solid var(--border)}
.list-tab:hover{background:rgba(255,255,255,0.08);color:var(--txt)}
.list-tab.active{background:var(--txt);color:var(--bg);border-color:var(--txt)}

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
    return (s || '').replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function timeAgo(ms) {
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 60) return `${min} min ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const d = Math.floor(hr / 24);
    return `${d} day${d !== 1 ? 's' : ''} ago`;
}

function renderHeader(username, isDiscover) {
    const id = 'cuw';
    return `
  <div style="display:flex;align-items:center;gap:32px;">
    <a href="/feed" style="text-decoration:none;display:flex;align-items:center;gap:12px;">
      <span style="width:36px;height:36px;background:linear-gradient(135deg,#8b5cf6,#10b981);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.9em;color:#fff;box-shadow:0 0 20px rgba(139,92,246,.4)">111</span>
      <div style="display:flex;flex-direction:column;line-height:1.2">
        <span style="font-weight:800;font-size:1.15em;color:#fff;letter-spacing:-.02em">Feed<span style="color:#8b5cf6">.</span></span>
      </div>
    </a>
    <div class="nav-links">
      <a href="/feed" class="nav-link ${!isDiscover ? 'active' : ''}">My Feed</a>
      <a href="/feed/discover" class="nav-link ${isDiscover ? 'active' : ''}">Manage Feeds</a>
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
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign Out
      </a>
    </div>
  </div>
  <script>document.addEventListener('click',e=>{const w=document.getElementById('${id}');if(w&&!w.contains(e.target))w.classList.remove('open');});</script>`;
}

function renderPage(user, allFeeds, userFeedMap, userListMap, articles, isDiscover, allLists, currentList) {
    let mainHtml = '';

    if (isDiscover) {
        // Group Active Feeds by List Name
        const groupedSubscriptions = {};
        const unsubscribedFeeds = [];

        allFeeds.forEach(f => {
            if (userFeedMap[f.id] === 1) {
                const list = userListMap[f.id] || 'Default';
                if (!groupedSubscriptions[list]) groupedSubscriptions[list] = [];
                groupedSubscriptions[list].push(f);
            } else {
                unsubscribedFeeds.push(f);
            }
        });

        const renderFeedRow = (f, isActive) => `
          <div class="feed-row">
            <div class="feed-info">
              <div class="feed-icon-large">${esc(f.icon)}</div>
              <div class="feed-text">
                <div class="feed-name">${esc(f.name)}</div>
                <div class="feed-url">${esc(f.url.replace(/^https?:\/\//, ''))}</div>
              </div>
            </div>
            <div class="feed-actions">
              ${isActive ? `<span class="list-badge" onclick="moveFeed('${f.id}', '${esc(userListMap[f.id])}')">${esc(userListMap[f.id])} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span>` : ''}
              <button class="btn btn-toggle" data-active="${isActive}" onclick="toggleFeed('${f.id}', ${isActive})">
                ${isActive ? 'Subscribed' : 'Subscribe'}
              </button>
            </div>
          </div>`;

        mainHtml = `
        <div class="top-bar">
          <div>
            <h1 class="page-title">Manage Feeds</h1>
            <p class="page-sub">Organize your reading list and discover top RSS feeds across 111iridescence.</p>
          </div>
          <button class="btn btn-primary" onclick="openAddModal()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add New RSS Source
          </button>
        </div>
        
        <!-- SUBSCRIBED FEEDS GROUPED BY LIST -->
        ${Object.keys(groupedSubscriptions).sort().map(listName => `
            <div class="feed-section-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" color="var(--p)"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${esc(listName)} List
            </div>
            <div class="feed-list">
              ${groupedSubscriptions[listName].map(f => renderFeedRow(f, true)).join('')}
            </div>
        `).join('')}

        ${Object.keys(groupedSubscriptions).length === 0 ? '<p style="color:var(--muted);margin-bottom:48px">You have no active subscriptions. Browse below to add some!</p>' : ''}

        <!-- UNSUBSCRIBED / GLOBAL FEEDS -->
        ${unsubscribedFeeds.length > 0 ? `
            <div class="feed-section-title" style="margin-top:24px;opacity:0.8">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
              Discover Global Feeds
            </div>
            <div class="feed-list">
              ${unsubscribedFeeds.map(f => renderFeedRow(f, false)).join('')}
            </div>
        ` : ''}
        `;
    } else {
        const hasSubscriptions = Object.values(userFeedMap).some(v => v === 1);

        if (!hasSubscriptions) {
            mainHtml = `
            <div class="empty-state">
              <div class="empty-icon">📰</div>
              <div class="empty-title">Your feed is empty</div>
              <div class="empty-sub">You aren't subscribed to any RSS streams yet. Head over to Manage Feeds to discover articles.</div>
              <a href="/feed/discover" class="btn btn-primary">Discover Feeds</a>
            </div>`;
        } else if (articles.length === 0) {
            mainHtml = `
            <div class="empty-state">
              <div class="empty-icon">⏳</div>
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
            
            <div class="list-tabs">
              ${allLists.map(l => `<a href="?list=${encodeURIComponent(l)}" class="list-tab ${l === currentList ? 'active' : ''}">${esc(l)}</a>`).join('')}
            </div>

            <div style="display:flex;flex-direction:column;gap:16px;">
              ${articles.map((a, i) => `
              <div class="article-group" style="animation-delay:${i * 0.04}s">
                <a class="article-card" href="${esc(a.url)}" target="_blank" rel="noopener">
                  ${a.image_url ? `
                  <div class="article-image-wrap">
                    <img src="${esc(a.image_url)}" class="article-image" alt="Cover Image" loading="lazy" onerror="this.style.display='none'">
                  </div>` : ''}
                  
                  <div class="article-content">
                    <div class="article-meta">
                      <span class="feed-icon">${esc(a.feed_icon)}</span>
                      <span style="color:var(--txt)">${esc(a.feed_name)}</span>
                      <span>•</span>
                      <span>${timeAgo(a.published_at)}</span>
                    </div>
                    <h2 class="article-title">${esc(a.title)}</h2>
                    <div class="article-domain">${esc(new URL(a.url).hostname.replace('www.', ''))}</div>
                  </div>
                </a>
              </div>`).join('')}
            </div>`;
        }
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Feed — 111iridescence</title>
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
          <label>List / Category Name (Optional)</label>
          <input type="text" name="list_name" placeholder="Default" value="Default">
        </div>
        <div class="form-group">
          <label>Custom Name (Optional - Only applies if adding 1 Feed)</label>
          <input type="text" name="name" placeholder="Leave blank to auto-detect">
        </div>
        <div class="form-group">
          <label>Emoji Icon (Optional)</label>
          <input type="text" name="icon" placeholder="📰" value="📰" maxlength="2">
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

    async function moveFeed(feedId, currentList) {
      const newList = prompt('Enter new list name:', currentList);
      if (newList !== null && newList.trim() !== '' && newList !== currentList) {
        const fd = new FormData();
        fd.append('feed_id', feedId);
        fd.append('list_name', newList.trim());
        const r = await fetch(BASE + '/api/feed/move', { method: 'POST', body: fd });
        if (r.ok) location.reload(); else alert('Error moving feed');
      }
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
  </script>
</body>
</html>`;
}
