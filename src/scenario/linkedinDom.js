export function feedDomHelpers() {
  function feedViewportHeight(innerHeight, clientHeight = 0, bodyHeight = 0) {
    if (Number.isFinite(innerHeight) && innerHeight >= 240) return innerHeight;
    const fallback = Math.max(Number(clientHeight) || 0, Number(bodyHeight) || 0);
    return fallback >= 240 ? fallback : 900;
  }

  function readablePostBox(box, viewportHeight) {
    const vh = feedViewportHeight(viewportHeight);
    const height = Number(box?.height) || 0;
    const top = Number(box?.top) || 0;
    const bottom = Number.isFinite(Number(box?.bottom)) ? Number(box.bottom) : top + height;
    return height >= 40 && bottom > 24 && top < vh + 200;
  }

  function feedPointerBounds(rootBox, innerWidth, innerHeight) {
    const left = Math.max(Number(rootBox?.left) || 0, 280);
    const minY = 120;
    const vh = feedViewportHeight(innerHeight);
    const vw = Number.isFinite(innerWidth) && innerWidth >= 320 ? innerWidth : 1280;
    return {
      minX: left + 72,
      maxX: Math.min(left + Math.min(Number(rootBox?.width) || 560, 560) - 36, vw - 80),
      minY,
      maxY: Math.max(minY + 80, vh - 96),
    };
  }

  function isMediaHit(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (["IMG", "PICTURE", "VIDEO", "CANVAS", "SOURCE"].includes(tag)) return true;
    if (el.getAttribute?.("role") === "img") return true;
    if (el.closest?.("figure, picture, video, [role='img']")) return true;
    const link = el.closest?.("a");
    return Boolean(link && link.querySelector?.("img, video, picture, canvas"));
  }

  function likeActionBand(viewportHeight) {
    const vh = feedViewportHeight(viewportHeight);
    return {
      minY: Math.round(vh * 0.62),
      maxY: Math.round(vh * 0.88),
    };
  }

  function seeNewPostsVisible(box, innerHeight) {
    const vh = feedViewportHeight(innerHeight);
    const width = Number(box?.width) || 0;
    const height = Number(box?.height) || 0;
    const top = Number(box?.top) || 0;
    const bottom = Number.isFinite(Number(box?.bottom)) ? Number(box.bottom) : top + height;
    return width > 24 && height > 12 && bottom > 8 && top < vh - 8;
  }

  return { feedViewportHeight, readablePostBox, feedPointerBounds, isMediaHit, likeActionBand, seeNewPostsVisible };
}

export function feedViewportHeight(innerHeight, clientHeight = 0, bodyHeight = 0) {
  return feedDomHelpers().feedViewportHeight(innerHeight, clientHeight, bodyHeight);
}

export function readablePostBox(box, viewportHeight) {
  return feedDomHelpers().readablePostBox(box, viewportHeight);
}

export function feedPointerBounds(rootBox, innerWidth, innerHeight) {
  return feedDomHelpers().feedPointerBounds(rootBox, innerWidth, innerHeight);
}

export function isMediaHit(el) {
  return feedDomHelpers().isMediaHit(el);
}

export function likeActionBand(viewportHeight) {
  return feedDomHelpers().likeActionBand(viewportHeight);
}

export function seeNewPostsVisible(box, innerHeight) {
  return feedDomHelpers().seeNewPostsVisible(box, innerHeight);
}

export function feedDomWorld(helpers = feedDomHelpers()) {
  function labelOf(el) {
    return `${el.getAttribute("aria-label") || ""} ${el.innerText || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function feedRoot() {
    return (
      document.querySelector('[data-testid="mainFeed"]') ||
      document.querySelector('[componentkey*="container-update-list"]') ||
      document.querySelector("main") ||
      document.body
    );
  }

  function isLikeControl(el) {
    if (!el) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName !== "BUTTON" && role !== "button") return false;
    const label = labelOf(el);
    if (!label) return false;
    if (/comment|repost|share via|\bsend\b|celebrate|insightful|funny|follow|connect|add profile|premium/.test(label)) return false;
    if (!/\blike\b|\bunlike\b/.test(label)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 24 && r.width <= 220 && r.height >= 16 && r.height <= 64;
  }

  function isCommentControl(el) {
    return el.tagName === "BUTTON" && /\bcomment\b/.test(labelOf(el)) && !/see more comments|view more comments/.test(labelOf(el));
  }

  function sitsInSocialBar(button) {
    const r = button.getBoundingClientRect();
    let row = button.parentElement;
    for (let depth = 0; row && depth < 8; depth += 1, row = row.parentElement) {
      const comments = [...row.querySelectorAll("button, [role='button']")].filter(isCommentControl);
      if (!comments.length) continue;
      const cr = comments[0].getBoundingClientRect();
      if (Math.abs(cr.top - r.top) < 32 && Math.abs(cr.height - r.height) < 32) return true;
    }
    return false;
  }

  function feedUpdateKey(el) {
    return `${el.getAttribute("componentkey") || ""} ${el.id || ""}`;
  }

  function looksLikeFeedUpdateKey(key) {
    return /update-card|FeedType_MAIN_FEED|MAIN_FEED_RELEVANCE/i.test(key || "");
  }

  function hasSocialActionBar(el) {
    const buttons = [...el.querySelectorAll("button, [role='button']")];
    const likes = buttons.filter(isLikeControl);
    const comments = buttons.filter(isCommentControl);
    if (likes.length && comments.length) return true;
    const labels = buttons.map(labelOf).join(" ");
    if (/open control menu for post by/.test(labels)) return true;
    const text = (el.innerText || "").toLowerCase();
    return /\bcomment\b/.test(text) && (/\blike\b/.test(text) || /\brepost\b/.test(text) || /reaction button state:/.test(text));
  }

  function isPeopleYouMayKnowPanel(el) {
    const text = (el.innerText || "").slice(0, 800).toLowerCase();
    if (!text) return false;
    if (hasSocialActionBar(el) || looksLikeFeedUpdateKey(feedUpdateKey(el))) return false;
    return /people you may know|invite .+ to connect|discover more/.test(text)
      && !/\breaction button state:|open control menu for post by/.test(text);
  }

  function cardRoot(el) {
    let best = el;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const key = feedUpdateKey(node);
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (looksLikeFeedUpdateKey(key) || role === "listitem") best = node;
      if (looksLikeFeedUpdateKey(key)) break;
    }
    return best;
  }

  function postScore(el) {
    const key = feedUpdateKey(el);
    let score = 0;
    if (looksLikeFeedUpdateKey(key)) score += 8;
    if (hasSocialActionBar(el)) score += 6;
    if (/open control menu for post by/.test([...el.querySelectorAll("button, [role='button']")].map(labelOf).join(" "))) score += 4;
    if (isPeopleYouMayKnowPanel(el)) score -= 20;
    const box = el.getBoundingClientRect?.() || { height: 0, top: 0 };
    if ((Number(box.height) || 0) >= 80) score += 2;
    return score;
  }

  function postCards() {
    const root = feedRoot();
    const keyed = [...root.querySelectorAll(
      '[componentkey^="update-card"], [componentkey*="FeedType_MAIN_FEED"], [componentkey*="MAIN_FEED_RELEVANCE"], [id*="FeedType_MAIN_FEED"], [id*="MAIN_FEED_RELEVANCE"], [role="listitem"]',
    )];
    const cards = keyed.filter((el) => {
      const key = feedUpdateKey(el);
      if (looksLikeFeedUpdateKey(key)) return !isPeopleYouMayKnowPanel(el);
      if (isPeopleYouMayKnowPanel(el)) return false;
      return hasSocialActionBar(el);
    });
    const seen = new Set();
    const unique = [];
    for (const el of cards) {
      const rootCard = cardRoot(el);
      if (seen.has(rootCard)) continue;
      seen.add(rootCard);
      unique.push(rootCard);
    }
    unique.sort((a, b) => postScore(b) - postScore(a) || (a.getBoundingClientRect().top - b.getBoundingClientRect().top));
    return unique;
  }

  function postIdentity(el) {
    const key = el.getAttribute("componentkey") || el.id || "";
    if (key) return key;
    const named = el.querySelector("[data-urn], [data-id^='urn:li']");
    if (named) return named.getAttribute("data-urn") || named.getAttribute("data-id");
    return `t:${(el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)}`;
  }

  function isProfileHref(href) {
    if (!href) return false;
    return /\/in\/|\/company\/|\/school\/|\/mwlite\/|\/messaging\/|\/jobs\/view\//i.test(href);
  }

  function isMoreControl(node) {
    if (!node) return false;
    const role = (node.getAttribute("role") || "").toLowerCase();
    if (node.tagName !== "BUTTON" && role !== "button") return false;
    const label = labelOf(node);
    const text = (node.innerText || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!label && !text) return false;
    if (/see more comments|see more replies|view more comments|more comments|see translation|follow|connect|more actions|control menu|dismiss|reactions/.test(label)) return false;
    if (text.length > 24) return false;
    const r = node.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.width > 140 || r.height > 40) return false;
    return /^(… ?more|\.{2,3} ?more|see more|more)$/i.test(text) || /^(… ?more|\.{2,3} ?more|see more)$/i.test(label);
  }

  function moreControl(el) {
    const matches = [...el.querySelectorAll("button, [role='button']")].filter(isMoreControl);
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    return matches[0];
  }

  function likeControl(el) {
    const buttons = [...el.querySelectorAll("button, [role='button']")];
    const bar = buttons.find((button) => isLikeControl(button) && sitsInSocialBar(button));
    const direct = bar || buttons.find(isLikeControl);
    if (direct) {
      return {
        button: direct,
        label: labelOf(direct),
        pressed: direct.getAttribute("aria-pressed") === "true" || /unlike/.test(labelOf(direct)) || (/reaction button state:/.test(labelOf(direct)) && !/no reaction/.test(labelOf(direct))),
      };
    }
    const commentIdx = buttons.findIndex((button) => isCommentControl(button));
    if (commentIdx >= 2 && /reactions menu/.test(labelOf(buttons[commentIdx - 1] || document.body))) {
      const like = buttons[commentIdx - 2];
      const r = like.getBoundingClientRect();
      if (r.height > 64 || r.width > 220) return null;
      return {
        button: like,
        label: labelOf(like),
        pressed: like.getAttribute("aria-pressed") === "true",
      };
    }
    return null;
  }

  function dismissBlockingModals() {
    let dismissed = false;
    const buttons = [...document.querySelectorAll("button, [role='button']")];
    for (const button of buttons) {
      const label = labelOf(button);
      if (!/close modal dialog|^dismiss$|^close$/i.test(label)) continue;
      const r = button.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      try { button.click(); dismissed = true; } catch { /* ignore */ }
    }
    const dialog = document.querySelector("[role='dialog'][aria-modal='true'], [aria-modal='true']");
    if (dialog) {
      const closer = [...dialog.querySelectorAll("button, [role='button']")].find((el) => /close modal dialog|close|dismiss/i.test(labelOf(el)));
      if (closer) {
        try { closer.click(); dismissed = true; } catch { /* ignore */ }
      }
    }
    return dismissed;
  }

  function mapPost(el, vh) {
    const box = el.getBoundingClientRect();
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    const like = likeControl(el);
    const more = moreControl(el);
    const likeBox = like?.button ? like.button.getBoundingClientRect() : null;
    const moreBox = more ? more.getBoundingClientRect() : null;
    return {
      urn: postIdentity(el),
      top: box.top,
      height: box.height,
      midY: box.top + Math.min(Math.max(118, Math.min(box.height, 280) * 0.55), 420),
      midX: box.left + Math.min(box.width, 560) * 0.42,
      visible: helpers.readablePostBox(box, vh),
      promoted: /promoted|sponsored/i.test(text.slice(0, 220)),
      liked: Boolean(like?.pressed || (like?.label || "").includes("unlike") || (/reaction button state:/.test(like?.label || "") && !/no reaction/.test(like?.label || ""))),
      hasLike: Boolean(like?.button),
      hasMore: Boolean(more),
      likeX: likeBox ? likeBox.x + Math.min(likeBox.width * 0.28, 22) : null,
      likeY: likeBox ? likeBox.y + likeBox.height * 0.72 : null,
      moreX: moreBox ? moreBox.x + moreBox.width / 2 : null,
      moreY: moreBox ? moreBox.y + moreBox.height / 2 : null,
      textLen: text.length,
      stable: true,
      score: postScore(el),
    };
  }

  function collect({ reveal = false } = {}) {
    dismissBlockingModals();
    const vh = helpers.feedViewportHeight(
      window.innerHeight,
      document.documentElement?.clientHeight,
      document.body?.clientHeight,
    );
    let cards = postCards();
    let mapped = cards.map((el) => mapPost(el, vh));
    let visible = mapped.filter((post) => post.visible);
    if (visible.length || !reveal || !cards.length) return visible;

    const ranked = [...cards].sort((a, b) => postScore(b) - postScore(a) || (a.getBoundingClientRect().top - b.getBoundingClientRect().top));
    const best = ranked[0];
    try {
      best.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {
      try { best.scrollIntoView(true); } catch { /* ignore */ }
    }
    // Re-query after scroll — LinkedIn may remount feed cards.
    cards = postCards();
    mapped = cards.map((el) => mapPost(el, vh));
    return mapped.filter((post) => post.visible);
  }

  function findPost(urn) {
    return postCards().find((el) => postIdentity(el) === urn) || null;
  }

  function hitAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { el: null, href: "", label: "" };
    const link = el.closest("a");
    return {
      el,
      href: link?.getAttribute("href") || "",
      label: labelOf(el.closest("button, [role='button'], a") || el),
    };
  }

  function locate(urn, control) {
    const post = findPost(urn);
    if (!post) return null;
    if (control === "more") {
      const more = moreControl(post);
      if (!more) return null;
      const r = more.getBoundingClientRect();
      const x = r.x + r.width * 0.55;
      const y = r.y + r.height * 0.5;
      const hit = hitAt(x, y);
      if (!hit.el || (!more.contains(hit.el) && hit.el !== more)) return null;
      if (isProfileHref(hit.href)) return null;
      return { x, y, label: (more.innerText || more.getAttribute("aria-label") || "").trim() };
    }
    const like = likeControl(post);
    if (!like?.button) return null;
    const r = like.button.getBoundingClientRect();
    const x = r.x + Math.min(r.width * 0.28, 22);
    const y = r.y + r.height * 0.72;
    const hit = hitAt(x, y);
    if (!hit.el) return null;
    if (helpers.isMediaHit(hit.el)) return null;
    if (isProfileHref(hit.href)) return null;
    const host = hit.el.closest("button, [role='button']");
    if (host !== like.button && !like.button.contains(hit.el) && !isLikeControl(host)) return null;
    return {
      x,
      y,
      label: like.button.getAttribute("aria-label") || like.label,
      pressed: like.pressed,
    };
  }

  function probe(x, y, kind, urn) {
    const hit = hitAt(x, y);
    if (!hit.el) return { safe: false, reason: "empty" };
    if (isProfileHref(hit.href)) return { safe: false, reason: "profile-link", href: hit.href, label: hit.label };
    const host = hit.el.closest("button, [role='button']");
    if (urn) {
      const expected = findPost(urn);
      if (!expected || !expected.contains(hit.el)) return { safe: false, reason: "different-post" };
    }
    if (kind === "more") {
      if (!isMoreControl(host)) return { safe: false, reason: "not-more-button", label: hit.label };
      return { safe: true, label: hit.label };
    }
    if (kind === "like") {
      if (helpers.isMediaHit(hit.el)) return { safe: false, reason: "media", label: hit.label };
      if (!isLikeControl(host)) return { safe: false, reason: "not-like-button", label: hit.label };
      if (!sitsInSocialBar(host)) return { safe: false, reason: "not-action-bar", label: hit.label };
      if (host.getAttribute("aria-pressed") === "true" || /unlike/.test(labelOf(host))) return { safe: false, reason: "already-liked" };
      return { safe: true, label: hit.label };
    }
    if (kind === "see-new") {
      if (!/^see new posts$/i.test((host?.innerText || hit.label || "").replace(/\s+/g, " ").trim())) {
        return { safe: false, reason: "not-see-new-posts", label: hit.label };
      }
      return { safe: true, label: hit.label };
    }
    if (kind === "home") {
      if (!/\/feed\//i.test(hit.href) && !/\bhome\b/i.test(hit.label)) {
        return { safe: false, reason: "not-home", href: hit.href, label: hit.label };
      }
      return { safe: true, label: hit.label };
    }
    return { safe: false, reason: "unsigned-click", label: hit.label };
  }

  function pointerBounds() {
    const root = feedRoot();
    const r = root.getBoundingClientRect();
    return helpers.feedPointerBounds(
      { left: r.left, width: r.width },
      window.innerWidth,
      helpers.feedViewportHeight(
        window.innerHeight,
        document.documentElement?.clientHeight,
        document.body?.clientHeight,
      ),
    );
  }

  function isLiked(urn) {
    const post = findPost(urn);
    if (!post) return false;
    const like = likeControl(post);
    return Boolean(like?.pressed || (like?.label || "").includes("unlike") || (/reaction button state:/.test(like?.label || "") && !/no reaction/.test(like?.label || "")));
  }

  function inspect() {
    const root = feedRoot();
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const cards = postCards();
    const buttons = [...root.querySelectorAll("button")];
    return {
      title: document.title,
      readyState: document.readyState,
      iframeCount: document.querySelectorAll("iframe").length,
      textSample: text.slice(0, 280),
      likeButtons: buttons.filter(isLikeControl).length,
      commentButtons: buttons.filter(isCommentControl).length,
      cssPosts: document.querySelectorAll("div.feed-shared-update-v2, div[data-urn^='urn:li:activity']").length,
      socialPosts: cards.length,
      feedTestId: Boolean(document.querySelector('[data-testid="mainFeed"]')),
      buttonLabels: buttons.slice(0, 30).map(labelOf).filter(Boolean).slice(0, 20),
      counts: {
        feedShared: document.querySelectorAll("div.feed-shared-update-v2").length,
        activityUrn: document.querySelectorAll("div[data-urn^='urn:li:activity'], div[data-id^='urn:li:activity']").length,
        occludable: document.querySelectorAll("div.occludable-update").length,
        viewName: document.querySelectorAll("div[data-view-name*='update']").length,
        articles: document.querySelectorAll("article").length,
        main: document.querySelectorAll("main").length,
        updateCards: document.querySelectorAll('[componentkey^="update-card"]').length,
        listItems: document.querySelectorAll('[data-testid="mainFeed"] [role="listitem"]').length,
      },
    };
  }

  function describe(el, depth = 8) {
    const chain = [];
    let node = el;
    for (let i = 0; i < depth && node && node.nodeType === 1; i += 1) {
      chain.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || "",
        className: String(node.className || "").slice(0, 180),
        viewName: node.getAttribute?.("data-view-name") || "",
        urn: node.getAttribute?.("data-urn") || node.getAttribute?.("data-id") || "",
        componentkey: (node.getAttribute?.("componentkey") || "").slice(0, 120),
        role: node.getAttribute?.("role") || "",
        testId: node.getAttribute?.("data-testid") || "",
      });
      node = node.parentElement;
    }
    return chain;
  }

  function dump() {
    const root = feedRoot();
    const cards = postCards();
    const buttons = [...root.querySelectorAll("button")];
    const likes = buttons.filter(isLikeControl);
    const comments = buttons.filter(isCommentControl);
    return {
      url: location.href,
      title: document.title,
      feedTestId: Boolean(document.querySelector('[data-testid="mainFeed"]')),
      likeButtons: likes.length,
      commentButtons: comments.length,
      cssPosts: document.querySelectorAll("div.feed-shared-update-v2").length,
      socialPosts: cards.length,
      viewNames: [],
      buttonLabels: buttons.map(labelOf).filter(Boolean).slice(0, 40),
      likeChains: likes.slice(0, 1).map((el) => describe(el, 10)),
      commentChains: comments.slice(0, 1).map((el) => describe(el, 10)),
      firstCard: cards[0] ? {
        urn: postIdentity(cards[0]),
        componentkey: cards[0].getAttribute("componentkey") || "",
        role: cards[0].getAttribute("role") || "",
        text: (cards[0].innerText || "").replace(/\s+/g, " ").trim().slice(0, 240),
      } : null,
    };
  }

  function reactionMenuOpen() {
    const text = (document.body?.innerText || "").slice(0, 4000);
    return /celebrate|insightful|funny/.test(text) && Boolean(document.querySelector("[role='tooltip'], [role='menu']"));
  }

  function mediaOverlayOpen() {
    const dialog = document.querySelector("[role='dialog'], [aria-modal='true']");
    if (dialog && dialog.querySelector("img, video, picture")) return true;
    return Boolean(document.querySelector(".media-lightbox, .feed-shared-lightbox, [data-test-id='image-viewer']"));
  }

  function findSeeNewPosts() {
    const vh = helpers.feedViewportHeight(
      window.innerHeight,
      document.documentElement?.clientHeight,
      document.body?.clientHeight,
    );
    const matches = [...document.querySelectorAll("button, a")].filter((el) => {
      const label = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
      if (!/^see new posts$/i.test(label)) return false;
      return helpers.seeNewPostsVisible(el.getBoundingClientRect(), vh);
    });
    if (!matches.length) return null;
    matches.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return Math.abs((ra.top + ra.bottom) / 2 - vh / 2) - Math.abs((rb.top + rb.bottom) / 2 - vh / 2);
    });
    const match = matches[0];
    const r = match.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (match.innerText || "").trim() };
  }

  function align(urn, control) {
    const post = findPost(urn);
    if (!post) return false;
    const target = control === "more" ? moreControl(post) : likeControl(post)?.button;
    if (!target) return false;
    target.scrollIntoView({ block: control === "like" ? "end" : "nearest", inline: "nearest" });
    return true;
  }

  return { collect, locate, isLiked, inspect, dump, reactionMenuOpen, mediaOverlayOpen, findSeeNewPosts, probe, pointerBounds, align, dismissBlockingModals };
}

async function runWorld(page, method, ...args) {
  return page.evaluate((worldSrc, helpersSrc, name, callArgs) => {
    const helpers = (0, eval)(`(${helpersSrc})`)();
    const world = (0, eval)(`(${worldSrc})`)(helpers);
    return world[name](...callArgs);
  }, feedDomWorld.toString(), feedDomHelpers.toString(), method, args);
}

export async function collectPosts(page, options = {}) {
  return runWorld(page, "collect", options);
}

export async function dismissBlockingModals(page) {
  return runWorld(page, "dismissBlockingModals");
}

export async function locateControl(page, urn, kind) {
  return runWorld(page, "locate", urn, kind);
}

export async function alignControl(page, urn, kind) {
  return runWorld(page, "align", urn, kind);
}

export async function postIsLiked(page, urn) {
  return runWorld(page, "isLiked", urn);
}

export async function reactionMenuOpen(page) {
  return runWorld(page, "reactionMenuOpen");
}

export async function mediaOverlayOpen(page) {
  return runWorld(page, "mediaOverlayOpen");
}

export async function findSeeNewPosts(page) {
  return runWorld(page, "findSeeNewPosts");
}

export async function inspectFeed(page) {
  return runWorld(page, "inspect");
}

export async function dumpFeedDom(page) {
  return runWorld(page, "dump");
}

export async function probePoint(page, x, y, kind, urn) {
  return runWorld(page, "probe", x, y, kind, urn);
}

export async function pointerBounds(page) {
  return runWorld(page, "pointerBounds");
}
