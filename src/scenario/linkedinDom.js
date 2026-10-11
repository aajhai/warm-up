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

  // LinkedIn paints this load-more control as "See new posts" / "New posts"
  // (English) or "नई पोस्ट देखें" / "नई पोस्ट" (Hindi). Match the button text
  // LinkedIn actually renders so a localized feed can still load the next posts.
  function isLoadMorePostsLabel(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (/^(see )?new posts$/i.test(text)) return true;
    if (/^नई पोस्ट( देखें)?$/u.test(text)) return true;
    return false;
  }

  function feedRoot() {
    const found = document.querySelector?.('[data-testid="mainFeed"]')
      || document.querySelector?.('[componentkey*="container-update-list"]')
      || document.querySelector?.("main")
      || document.body
      || null;
    if (!found || typeof found.querySelectorAll !== "function") return null;
    return found;
  }

  function reactionAlreadyGiven(el) {
    const label = labelOf(el);
    return el.getAttribute("aria-pressed") === "true"
      || /\bunlike\b/.test(label)
      || (/reaction button state:/.test(label) && !/no reaction/.test(label));
  }

  function isLikeControl(el) {
    if (!el) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName !== "BUTTON" && role !== "button") return false;
    const label = labelOf(el);
    if (!label) return false;
    // The chevron that opens the emoji picker sits next to Like. Never treat it as Like.
    if (/open reactions menu/.test(label)) return false;
    if (/comment|repost|share via|\bsend\b|celebrate|insightful|funny|follow|connect|add profile|premium/.test(label)) return false;
    // Current LinkedIn often labels the toggle "Reaction button state: no reaction 4"
    // with no "Like" token. Older builds still say "no reaction Like".
    if (!/\blike\b|\bunlike\b|reaction button state:/.test(label)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 24 && r.width <= 280 && r.height >= 16 && r.height <= 64;
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

  // A suggestions insert can carry a feed component key and still not be a post.
  // Keep a real update that has a like/comment bar even if its text mentions suggestions.
  function isSuggestionModule(el) {
    if (!el || hasSocialActionBar(el)) return false;
    const text = (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 280);
    if (!text) return false;
    return /suggestions for you|suggested for you|people you may know|आपके लिए सुझाव|recommendations for you/i.test(text);
  }

  // Comment wrappers carry a feed key too; the climb passes them and stops at the post.
  function cardRoot(el) {
    let best = el;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const key = feedUpdateKey(node);
      if (isPostSubcomponentKey(key)) continue;
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
    if (!root) return [];
    const keyed = [...root.querySelectorAll(
      '[componentkey^="update-card"], [componentkey*="FeedType_MAIN_FEED"], [componentkey*="MAIN_FEED_RELEVANCE"], [id*="FeedType_MAIN_FEED"], [id*="MAIN_FEED_RELEVANCE"], [role="listitem"]',
    )];
    const cards = keyed.filter((el) => {
      if (isPostSubcomponentKey(feedUpdateKey(el)) || insideSubcomponent(el)) return false;
      if (isSuggestionModule(el)) return false;
      const key = feedUpdateKey(el);
      if (looksLikeFeedUpdateKey(key)) return !isPeopleYouMayKnowPanel(el);
      if (isPeopleYouMayKnowPanel(el)) return false;
      return hasSocialActionBar(el);
    });
    const seen = new Set();
    const unique = [];
    for (const el of cards) {
      const rootCard = cardRoot(el);
      if (isPostSubcomponentKey(feedUpdateKey(rootCard))) continue;
      if (seen.has(rootCard)) continue;
      seen.add(rootCard);
      unique.push(rootCard);
    }
    unique.sort((a, b) => postScore(b) - postScore(a) || (a.getBoundingClientRect().top - b.getBoundingClientRect().top));
    const identities = new Set();
    return unique.filter((el) => {
      const id = postIdentity(el);
      if (identities.has(id)) return false;
      identities.add(id);
      return true;
    });
  }

  // Comment sections and inline comment boxes carry the post's feed key with a prefix or a
  // suffix. They are parts of a post, never a post of their own.
  function isPostSubcomponentKey(key) {
    return /commentsSection|CommentBox/.test(key || "");
  }

  // The post URN can sit before the marker ("<urn>-asyncInlineCommentBoxSlot0_x") or after it
  // ("<prefix>-asyncInlineCommentBoxSlot<urn>"). Take the last segment that holds a feed URN.
  // A comment inside a comment box or section is never a post of its own.
  function insideSubcomponent(el) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (isPostSubcomponentKey(feedUpdateKey(node))) return true;
    }
    return false;
  }

  function basePostKey(key) {
    const parts = String(key || "").split(/-?asyncInlineCommentBoxSlot|commentsSectionContainer/);
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const stripped = parts[i].replace(/^(?:expanded|update-card-focus)+/, "");
      const base = stripped.match(/^(.*?FeedType_[A-Z_]+)/);
      if (base) return base[1];
    }
    return String(key || "").replace(/^(?:expanded|update-card-focus)+/, "");
  }

  function postIdentity(el) {
    const key = el.getAttribute("componentkey") || el.id || "";
    if (key) return basePostKey(key);
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
        pressed: reactionAlreadyGiven(direct),
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

  function accessibleName(el) {
    return (el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function visibleText(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isFollowName(name) {
    const text = String(name || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 80 || /following|unfollow/i.test(text)) return false;
    return /^\+?\s*follow$/i.test(text) || /^follow\s+\S/i.test(text);
  }

  function isFollowishButton(el) {
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName !== "BUTTON" && role !== "button") return false;
    return /\bfollow(ing)?\b|unfollow/i.test(`${el.getAttribute("aria-label") || ""} ${visibleText(el)}`);
  }

  function isFollowControl(el) {
    if (!el) return false;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (el.tagName !== "BUTTON" && role !== "button") return false;
    const aria = el.getAttribute("aria-label") || "";
    const text = visibleText(el);
    if (/following|unfollow/i.test(`${aria} ${text}`)) return false;
    if (el.getAttribute("aria-pressed") === "true") return false;
    if (!isFollowName(aria || text)) return false;
    if (aria && text && !isFollowName(text)) return false;
    if (isLikeControl(el) || isCommentControl(el)) return false;
    if (el.closest("a, aside, nav, [role='dialog'], [aria-modal='true']")) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 24 && r.width <= 240 && r.height >= 16 && r.height <= 56;
  }

  function personProfileUrl(href) {
    if (!href) return null;
    let url;
    try { url = new URL(href, location.origin); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/in\/([^/?#]+)\/?$/i);
    return match ? `https://www.linkedin.com/in/${match[1].toLowerCase()}/` : null;
  }

  // Returns the single person a Follow control belongs to, or null when the
  // surrounding row names a company, several people, or is not an approved surface.
  function followContext(button) {
    const root = feedRoot();
    if (!root || root === document.body || !root.contains(button)) return null;
    let row = null;
    for (let node = button.parentElement, depth = 0; node && node !== root && depth < 8; node = node.parentElement, depth += 1) {
      const links = [...node.querySelectorAll("a[href]")];
      const people = new Set(links.map((a) => personProfileUrl(a.getAttribute("href"))).filter(Boolean));
      const company = links.some((a) => /\/(company|school|showcase)\//i.test(a.getAttribute("href") || ""));
      if (!people.size && !company) continue;
      if (company || people.size !== 1) return null;
      if ([...node.querySelectorAll("button, [role='button']")].filter(isFollowishButton).length !== 1) return null;
      row = { node, profileUrl: [...people][0] };
      break;
    }
    if (!row) return null;

    for (let node = row.node.parentElement; node && node !== root; node = node.parentElement) {
      if (hasSocialActionBar(node)) break;
      const head = visibleText(node).slice(0, 200);
      if (/recommended for you/i.test(head)) {
        return {
          profileUrl: row.profileUrl,
          source: "recommended",
          promoted: /promoted|sponsored/i.test(head),
        };
      }
      if ((node.getAttribute("role") || "").toLowerCase() === "listitem" || looksLikeFeedUpdateKey(feedUpdateKey(node))) break;
    }

    const card = postCards().find((el) => el.contains(button));
    if (!card) return null;
    const like = likeControl(card);
    if (!like?.button || sitsInSocialBar(button)) return null;
    const br = button.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const lr = like.button.getBoundingClientRect();
    if (br.top >= lr.top || br.top - cr.top > 180) return null;
    return {
      profileUrl: row.profileUrl,
      source: "suggested",
      promoted: /promoted|sponsored/i.test(visibleText(card).slice(0, 220)),
    };
  }

  function followButtons() {
    const root = feedRoot();
    if (!root || root === document.body) return [];
    const out = [];
    const seen = new Set();
    for (const button of root.querySelectorAll("button, [role='button']")) {
      if (!isFollowControl(button)) continue;
      const context = followContext(button);
      if (!context || context.promoted || seen.has(context.profileUrl)) continue;
      seen.add(context.profileUrl);
      out.push({ button, ...context });
    }
    return out;
  }

  function organizationUrl(href) {
    if (!href) return null;
    let url;
    try { url = new URL(href, location.origin); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(company|school|showcase)\/([^/?#]+)\/?$/i);
    if (!match) return null;
    return `https://www.linkedin.com/${match[1].toLowerCase()}/${decodeURIComponent(match[2]).toLowerCase()}/`;
  }

  function followButtonName(button) {
    const aria = (button.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const fromAria = aria.match(/^follow\s+(.+)$/i);
    if (fromAria) {
      const name = fromAria[1].replace(/\s+follow$/i, "").replace(/\s+/g, " ").trim();
      if (name && name.length <= 60 && !/[•|]|\balso follow\b/i.test(name)) return name;
    }
    const text = visibleText(button).replace(/\s+/g, " ").trim();
    const fromText = text.match(/^follow\s+(.+?)(?:\s+follow)?$/i);
    if (!fromText || text.length > 60) return "";
    return fromText[1].replace(/\s+follow$/i, "").replace(/\s+/g, " ").trim();
  }

  function skippedThinFollow(button) {
    if (!button) return true;
    const role = (button.getAttribute("role") || "").toLowerCase();
    if (button.tagName !== "BUTTON" && role !== "button") return true;
    const label = `${button.getAttribute("aria-label") || ""} ${visibleText(button)}`;
    if (/show more/i.test(label)) return true;
    if (/following|unfollow/i.test(label)) return true;
    if (button.getAttribute("aria-pressed") === "true") return true;
    return !isFollowName(button.getAttribute("aria-label") || visibleText(button));
  }

  function followPillBox(node) {
    if (!node?.getBoundingClientRect) return null;
    const r = node.getBoundingClientRect();
    if (!(r.width >= 8 && r.height >= 8 && r.width <= 220 && r.height <= 80)) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom };
  }

  function followWordNode(button) {
    const painted = [...button.querySelectorAll("span, strong")].find((node) => /^follow$/i.test(visibleText(node)));
    if (painted) return painted;
    if (/^follow$/i.test(visibleText(button))) return button;
    return null;
  }

  function followHitLabel(el) {
    if (!el) return "";
    return labelOf(el.closest("button, [role='button'], a") || el);
  }

  // A point is usable only when the painted element is the Follow button or
  // inside it. The right rail, a name link, More, and Connect are not.
  function followHitBlock(button, el) {
    if (!el) return "";
    if (el === button || button.contains(el)) return "";
    const host = el.closest("button, [role='button'], a, aside, section") || el;
    const label = followHitLabel(el);
    if (/people you may know/i.test(label)) return label;
    if (/invite\s+.+\s+to connect|\bconnect\b/i.test(label)) return label;
    if (isMoreControl(host) || /^more$/i.test(visibleText(host))) return label || "more";
    if (el.closest("aside, [role='complementary']")) return label || "right rail";
    const link = el.closest("a[href]");
    if (link && !button.contains(link) && isProfileHref(link.getAttribute("href"))) return label || "name link";
    return label || "not-follow";
  }

  function readFollowAim(button) {
    const word = followWordNode(button);
    const rect = followPillBox(button) || (word ? followPillBox(word) : null);
    if (!rect) return { ok: false, hitLabel: "", x: 0, y: 0, box: null };
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    const hit = hitAt(x, y);
    if (!hit.el) return { ok: false, hitLabel: "", x, y, box };
    const blocked = followHitBlock(button, hit.el);
    const onButton = hit.el === button || button.contains(hit.el);
    return {
      ok: Boolean(onButton && !blocked),
      hitLabel: blocked || followHitLabel(hit.el),
      x,
      y,
      box,
    };
  }

  // Scroll the Follow button into the viewport, then re-read the box. A large x
  // is not a reason to skip. A center that is still outside the viewport is.
  function aimThinFollow(button) {
    const target = followWordNode(button) || button;
    const vh = () => window.innerHeight || 900;
    try { target.scrollIntoView({ block: "center", inline: "nearest" }); } catch { /* ignore */ }
    let aim = readFollowAim(button);
    if (aim.box && (aim.y < 40 || aim.y > vh() - 20)) {
      const root = document.querySelector("main#workspace") || document.scrollingElement || document.documentElement;
      try { root.scrollBy(0, aim.y - vh() / 2); } catch { /* ignore */ }
      aim = readFollowAim(button);
    }
    if (!aim.box) return aim;
    if (aim.y < 40 || aim.y > vh() - 20) return { ...aim, ok: false, hitLabel: aim.hitLabel || "outside-viewport" };
    return aim;
  }

  function sameFollowName(a, b) {
    const left = String(a || "").toLowerCase().replace(/\s+/g, " ").trim();
    const right = String(b || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!left || !right) return false;
    return left === right || left.includes(right) || right.includes(left);
  }

  function promotedNear(button) {
    for (let node = button.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
      const otherFollows = [...node.querySelectorAll("button, [role='button']")].filter((el) => el !== button && !skippedThinFollow(el));
      if (otherFollows.length) break;
      if (/promoted|sponsored/i.test(visibleText(node).slice(0, 400))) return true;
    }
    return false;
  }

  // People and companies are both pressable on a thin feed. Healthy-feed
  // followCandidates stays people-only through followContext.
  function classifyThinFollow(button) {
    if (skippedThinFollow(button) || promotedNear(button)) return null;
    const aim = aimThinFollow(button);
    if (!aim.box) return null;
    const box = aim.box;
    const root = feedRoot();
    if (!root || root === document.body || !root.contains(button)) return null;
    const name = followButtonName(button);
    const label = accessibleName(button);
    const closest = button.closest("a[href]");
    if (closest && !/\/newsletters?\//i.test(closest.getAttribute("href") || "")) {
      const href = closest.getAttribute("href");
      const person = personProfileUrl(href);
      const org = organizationUrl(href);
      const linked = shortIdentityName(visibleText(closest));
      if (person) return { kind: "person", name: name || linked || "person", url: person, box, label, ok: aim.ok, hitLabel: aim.hitLabel, x: aim.x, y: aim.y };
      if (org) return { kind: "company", name: name || linked || "company", url: org, box, label, ok: aim.ok, hitLabel: aim.hitLabel, x: aim.x, y: aim.y };
    }
    const people = [];
    const orgs = [];
    for (let node = button.parentElement, depth = 0; node && node !== root && depth < 8; node = node.parentElement, depth += 1) {
      for (const link of node.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href");
        if (/\/newsletters?\//i.test(href || "")) continue;
        const person = personProfileUrl(href);
        const org = organizationUrl(href);
        const linked = shortIdentityName(visibleText(link));
        if (person && !people.some((item) => item.url === person)) people.push({ url: person, name: linked });
        if (org && !orgs.some((item) => item.url === org)) orgs.push({ url: org, name: linked });
      }
      if (people.length || orgs.length) break;
    }
    const namedPerson = people.find((item) => item.name && sameFollowName(item.name, name)) || (people.length === 1 && !orgs.length ? people[0] : null);
    const namedOrg = orgs.find((item) => item.name && sameFollowName(item.name, name)) || (orgs.length === 1 && !people.length ? orgs[0] : null);
    if (namedPerson && !namedOrg) return { kind: "person", name: name || namedPerson.name || "person", url: namedPerson.url, box, label, ok: aim.ok, hitLabel: aim.hitLabel, x: aim.x, y: aim.y };
    if (namedOrg && !namedPerson) return { kind: "company", name: name || namedOrg.name || "company", url: namedOrg.url, box, label, ok: aim.ok, hitLabel: aim.hitLabel, x: aim.x, y: aim.y };
    if (!name) return null;
    return { kind: "company", name, url: `https://www.linkedin.com/company/${encodeURIComponent(name.toLowerCase().replace(/\s+/g, "-"))}/`, box, label, ok: aim.ok, hitLabel: aim.hitLabel, x: aim.x, y: aim.y };
  }

  function shortIdentityName(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 60 || /[•|]|\balso follow\b|\bcompany\b/i.test(clean)) return "";
    return clean;
  }

  function thinFollowStatus(url) {
    const root = feedRoot();
    if (!root || !url) return "missing";
    for (const button of root.querySelectorAll("button, [role='button']")) {
      let href = "";
      const closest = button.closest("a[href]");
      if (closest) href = closest.getAttribute("href") || "";
      if (!href) {
        for (let node = button.parentElement, depth = 0; node && node !== root && depth < 6; node = node.parentElement, depth += 1) {
          const link = [...node.querySelectorAll("a[href]")].find((anchor) => {
            const id = personProfileUrl(anchor.getAttribute("href")) || organizationUrl(anchor.getAttribute("href"));
            return id === url;
          });
          if (link) {
            href = link.getAttribute("href") || "";
            break;
          }
        }
      }
      const id = personProfileUrl(href) || organizationUrl(href);
      if (id !== url) continue;
      const label = `${button.getAttribute("aria-label") || ""} ${visibleText(button)}`;
      if (/following|unfollow/i.test(label) || button.getAttribute("aria-pressed") === "true") return "following";
      if (/\bfollow\b/i.test(label)) return "follow";
    }
    return "missing";
  }

  function thinFollowRow(button, item) {
    return {
      kind: item.kind,
      name: item.name,
      url: item.url,
      label: item.label || accessibleName(button),
      tag: (button.tagName || "").toLowerCase(),
      x: item.x,
      y: item.y,
      hitLabel: item.hitLabel || "",
      box: item.box,
    };
  }

  function thinFeedFollowPlan() {
    const root = feedRoot();
    if (!root || root === document.body) return { ready: [], blocked: [] };
    const ready = [];
    const blocked = [];
    const seen = new Set();
    for (const button of root.querySelectorAll("button, [role='button']")) {
      const item = classifyThinFollow(button);
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      const row = thinFollowRow(button, item);
      if (item.ok) ready.push(row);
      else blocked.push(row);
    }
    ready.sort((a, b) => a.y - b.y || a.x - b.x);
    return { ready, blocked };
  }

  function thinFeedFollows() {
    return thinFeedFollowPlan().ready;
  }

  function followCandidates() {
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    return followButtons()
      .map(({ button, ...context }) => {
        const r = button.getBoundingClientRect();
        return { ...context, label: accessibleName(button), x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.top + r.height };
      })
      .filter((c) => c.top >= 150 && c.bottom <= vh - 130);
  }

  function locateFollow(profileUrl) {
    const match = followButtons().find((c) => c.profileUrl === profileUrl);
    if (!match) return null;
    const r = match.button.getBoundingClientRect();
    const x = r.x + r.width * 0.5;
    const y = r.y + r.height * 0.5;
    const hit = hitAt(x, y);
    if (!hit.el || (hit.el !== match.button && !match.button.contains(hit.el))) return null;
    if (isProfileHref(hit.href)) return null;
    return { x, y, label: accessibleName(match.button) };
  }

  function followState(profileUrl) {
    const root = feedRoot();
    for (const button of root.querySelectorAll("button, [role='button']")) {
      if (!isFollowishButton(button)) continue;
      const context = followContext(button);
      if (context?.profileUrl !== profileUrl) continue;
      const name = `${button.getAttribute("aria-label") || ""} ${visibleText(button)}`;
      if (/following|unfollow/i.test(name) || button.getAttribute("aria-pressed") === "true") return "following";
      return "follow";
    }
    return "missing";
  }

  function visitUrl(href) {
    if (!href) return null;
    let url;
    try { url = new URL(href, location.origin); } catch { return null; }
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    const match = url.pathname.match(/^\/(in|company)\/([^/?#]+)\/?$/i);
    return match ? `https://www.linkedin.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/` : null;
  }

  // Profile/company name links that can be opened for a read: the author link in a post
  // header, and the person name in a "Recommended for you" row. Ads, company rows in that
  // module, controls, and links without a visible name are excluded.
  function visitAnchors() {
    const root = feedRoot();
    if (!root || root === document.body) return [];
    const out = [];
    const seen = new Set();
    for (const card of postCards()) {
      const head = visibleText(card).slice(0, 220);
      if (/promoted|sponsored/i.test(head)) continue;
      const cr = card.getBoundingClientRect();
      const anchor = [...card.querySelectorAll("a[href]")].find((a) => {
        const url = visitUrl(a.getAttribute("href"));
        if (!url || !visibleText(a) || a.closest("button, [role='button']")) return false;
        return a.getBoundingClientRect().top - cr.top < 120;
      });
      const url = anchor && visitUrl(anchor.getAttribute("href"));
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ anchor, url, source: "post", kind: url.includes("/company/") ? "company" : "person" });
    }
    for (const button of root.querySelectorAll("button, [role='button']")) {
      if (!isFollowControl(button)) continue;
      const context = followContext(button);
      if (!context || context.source !== "recommended" || context.promoted || seen.has(context.profileUrl)) continue;
      let anchor = null;
      for (let node = button.parentElement, depth = 0; node && depth < 8 && !anchor; node = node.parentElement, depth += 1) {
        anchor = [...node.querySelectorAll("a[href]")].find((a) => personProfileUrl(a.getAttribute("href")) === context.profileUrl && visibleText(a)) || null;
      }
      if (!anchor) continue;
      seen.add(context.profileUrl);
      out.push({ anchor, url: context.profileUrl, source: "module", kind: "person" });
    }
    // Home right rail ("Add to your feed" and similar): name links to the right of the feed
    // column. The left rail (this account's own card) and promoted blocks are excluded.
    const feedRight = root.getBoundingClientRect().right;
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (root.contains(anchor) || anchor.closest("header, nav, button, [role='button'], [role='dialog'], [role='menu']")) continue;
      const url = visitUrl(anchor.getAttribute("href"));
      if (!url || seen.has(url) || !visibleText(anchor)) continue;
      if (anchor.getBoundingClientRect().left < feedRight - 4) continue;
      const block = anchor.closest("section, aside, li") || anchor.parentElement;
      if (/promoted|sponsored/i.test(visibleText(block).slice(0, 240))) continue;
      seen.add(url);
      out.push({ anchor, url, source: "home", kind: url.includes("/company/") ? "company" : "person" });
    }
    return out;
  }

  function visitTargets() {
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    return visitAnchors().map(({ anchor, ...rest }) => {
      const r = anchor.getBoundingClientRect();
      return { ...rest, x: r.x + Math.min(r.width / 2, 50), y: r.y + r.height / 2, top: r.top };
    }).filter((t) => t.y >= 150 && t.y <= vh - 130);
  }

  function locateVisit(url) {
    const match = visitAnchors().find((t) => t.url === url);
    if (!match) return null;
    const r = match.anchor.getBoundingClientRect();
    const x = r.x + Math.min(r.width / 2, 50);
    const y = r.y + r.height / 2;
    const hit = hitAt(x, y);
    if (!hit.el || !match.anchor.contains(hit.el) && hit.el !== match.anchor) return null;
    return { x, y, label: visibleText(match.anchor).slice(0, 80) };
  }

  function dialogOpen() {
    return [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], [aria-modal='true']")].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
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

  function isMuteLabel(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return /^(un)?mute( video)?$/i.test(text) || /^turn (on|off) sound$/i.test(text);
  }

  function videoPlayer(post) {
    return post.querySelector("video, .feed-shared-linkedin-video, .update-components-linkedin-video, .video-js, [data-test-id='video-player']");
  }

  function muteControl(post) {
    const player = videoPlayer(post);
    const scope = player?.parentElement || player || post;
    return [...scope.querySelectorAll("button, [role='button']")].find((el) => isMuteLabel(el.getAttribute("aria-label") || el.innerText || "")) || null;
  }

  function mapPost(el, vh) {
    const box = el.getBoundingClientRect();
    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    const like = likeControl(el);
    const more = moreControl(el);
    const video = videoPlayer(el);
    const mute = video ? muteControl(el) : null;
    const likeBox = like?.button ? like.button.getBoundingClientRect() : null;
    const moreBox = more ? more.getBoundingClientRect() : null;
    const muteBox = mute ? mute.getBoundingClientRect() : null;
    return {
      urn: postIdentity(el),
      top: box.top,
      height: box.height,
      midY: box.top + Math.min(Math.max(118, Math.min(box.height, 280) * 0.55), 420),
      midX: box.left + Math.min(box.width, 560) * 0.42,
      visible: helpers.readablePostBox(box, vh),
      promoted: /promoted|sponsored/i.test(text.slice(0, 220)),
      liked: Boolean(like?.pressed || (like?.button && reactionAlreadyGiven(like.button))),
      hasLike: Boolean(like?.button),
      hasMore: Boolean(more),
      hasVideo: Boolean(video),
      hasMute: Boolean(mute),
      muteLabel: mute ? (mute.getAttribute("aria-label") || mute.innerText || "").replace(/\s+/g, " ").trim() : null,
      muteX: muteBox ? muteBox.x + muteBox.width / 2 : null,
      muteY: muteBox ? muteBox.y + muteBox.height / 2 : null,
      likeX: likeBox ? likeBox.x + Math.min(Math.max(10, likeBox.width * 0.18), 18) : null,
      likeY: likeBox ? likeBox.y + likeBox.height * 0.55 : null,
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
    if (control === "mute") {
      const mute = muteControl(post);
      if (!mute) return null;
      const r = mute.getBoundingClientRect();
      // Player controls sit under the video surface until hover, so elementFromPoint
      // often hits the <video> instead of the button. The button box is the target.
      if (r.width < 8 || r.height < 8) return null;
      const vh = window.innerHeight || 900;
      if (r.bottom < 80 || r.top > vh - 40) return null;
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        label: mute.getAttribute("aria-label") || mute.innerText || "mute",
      };
    }
    const like = likeControl(post);
    if (!like?.button) return null;
    const r = like.button.getBoundingClientRect();
    // Bias left toward the Like label, away from the adjacent reactions-menu chevron.
    const x = r.x + Math.min(Math.max(10, r.width * 0.18), 18);
    const y = r.y + r.height * 0.55;
    const hit = hitAt(x, y);
    if (!hit.el) return null;
    if (helpers.isMediaHit(hit.el)) return null;
    if (isProfileHref(hit.href)) return null;
    if (/open reactions menu/.test(hit.label)) return null;
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
    if (kind === "visit") {
      if (hit.el.closest("button, [role='button']")) return { safe: false, reason: "control", label: hit.label };
      const anchor = hit.el.closest("a[href]");
      if (!anchor || visitUrl(anchor.getAttribute("href")) !== urn) return { safe: false, reason: "different-link", href: hit.href, label: hit.label };
      if (!visitAnchors().some((t) => t.anchor === anchor)) return { safe: false, reason: "not-approved-link", label: hit.label };
      return { safe: true, label: hit.label };
    }
    const host = hit.el.closest("button, [role='button']");
    if (kind === "thin-follow") {
      if (isMoreControl(host) || /^more$/i.test(visibleText(host || hit.el))) {
        return { safe: false, reason: "more", label: hit.label };
      }
      if (/people you may know/i.test(hit.label)) return { safe: false, reason: "not-thin-follow", label: hit.label };
      if (/invite\s+.+\s+to connect|\bconnect\b/i.test(hit.label)) return { safe: false, reason: "not-thin-follow", label: hit.label };
      if (!host || skippedThinFollow(host) || !(host === hit.el || host.contains(hit.el))) {
        if (isProfileHref(hit.href)) return { safe: false, reason: "profile-link", href: hit.href, label: hit.label };
        return { safe: false, reason: "not-thin-follow", label: hit.label };
      }
      return { safe: true, label: hit.label };
    }
    if (isProfileHref(hit.href)) return { safe: false, reason: "profile-link", href: hit.href, label: hit.label };
    if (kind === "follow") {
      if (!isFollowControl(host)) return { safe: false, reason: "not-follow-button", label: hit.label };
      const context = followContext(host);
      if (!context || context.promoted) return { safe: false, reason: "not-person-follow", label: hit.label };
      if (context.profileUrl !== urn) return { safe: false, reason: "different-person", label: hit.label };
      return { safe: true, label: hit.label };
    }
    if (urn) {
      const expected = findPost(urn);
      if (!expected || !expected.contains(hit.el)) return { safe: false, reason: "different-post" };
    }
    if (kind === "more") {
      if (!isMoreControl(host)) return { safe: false, reason: "not-more-button", label: hit.label };
      return { safe: true, label: hit.label };
    }
    if (kind === "mute") {
      const post = urn ? findPost(urn) : null;
      const mute = post ? muteControl(post) : null;
      if (mute) {
        const r = mute.getBoundingClientRect();
        if (r.width >= 8 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return { safe: true, label: labelOf(mute) };
        }
      }
      if (isMuteLabel(hit.label) || (host && isMuteLabel(labelOf(host)))) return { safe: true, label: hit.label };
      return { safe: false, reason: "not-mute-button", label: hit.label };
    }
    if (kind === "like") {
      if (helpers.isMediaHit(hit.el)) return { safe: false, reason: "media", label: hit.label };
      if (!isLikeControl(host)) return { safe: false, reason: "not-like-button", label: hit.label };
      if (!sitsInSocialBar(host)) return { safe: false, reason: "not-action-bar", label: hit.label };
      if (reactionAlreadyGiven(host)) return { safe: false, reason: "already-liked", label: hit.label };
      return { safe: true, label: hit.label };
    }
    if (kind === "see-new") {
      const owns = (node) => Boolean(node) && (
        isLoadMorePostsLabel(labelOf(node))
        || isLoadMorePostsLabel(node.innerText || "")
        || [...(node.querySelectorAll?.("button, a, [role='button']") || [])].some((child) => isLoadMorePostsLabel(labelOf(child)))
      );
      if (!owns(host) && !owns(hit.el)) {
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
    if (!root?.getBoundingClientRect) return null;
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
    return Boolean(like?.pressed || (like?.button && reactionAlreadyGiven(like.button)));
  }

  function inspect() {
    const root = feedRoot();
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const cards = postCards();
    const buttons = root ? [...root.querySelectorAll("button")] : [];
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
    const buttons = root ? [...root.querySelectorAll("button")] : [];
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

  function workspaceEl() {
    return document.querySelector("main#workspace") || document.querySelector("main");
  }

  function feedListEl() {
    return document.querySelector('[data-testid="mainFeed"]');
  }

  function isChromeRow(el) {
    const text = (el?.innerText || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (/^start a post\b/i.test(text) && text.length < 180) return true;
    if (/^sort by\b/i.test(text) && text.length < 48) return true;
    if (isLoadMorePostsLabel(text)) return true;
    return false;
  }

  function visibleUpdateCount(feed, vh) {
    if (!feed) return 0;
    const nodes = [...feed.querySelectorAll("[role='listitem'], [componentkey*='FeedType_MAIN_FEED'], [componentkey^='update-card']")];
    let count = 0;
    for (const el of nodes) {
      if (isChromeRow(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.height < 80 || box.width < 180) continue;
      if (box.bottom < 70 || box.top > vh - 30) continue;
      count += 1;
    }
    return count;
  }

  function columnState() {
    const workspace = workspaceEl();
    const feed = feedListEl();
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    const box = feed?.getBoundingClientRect?.() || null;
    const railText = [...document.querySelectorAll("main aside, #workspace aside")]
      .reduce((sum, el) => sum + (el.innerText || "").replace(/\s+/g, " ").trim().length, 0);
    return {
      top: workspace?.scrollTop || window.scrollY || 0,
      maxTop: workspace ? Math.max(0, (workspace.scrollHeight || 0) - (workspace.clientHeight || 0)) : 0,
      windowY: window.scrollY || 0,
      owner: workspace?.id === "workspace" ? "main#workspace" : "document",
      feedTop: box ? Math.round(box.top) : null,
      feedHeight: box ? Math.round(box.height) : 0,
      feedVisible: Boolean(box && box.height > 40 && box.bottom > 100 && box.top < vh - 40),
      visibleUpdates: visibleUpdateCount(feed, vh),
      railText,
    };
  }

  function viewportSize() {
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    const vw = Number(window.innerWidth) || Number(document.documentElement?.clientWidth) || 1280;
    return { vh, vw };
  }

  function laidOutBox(el) {
    const box = el?.getBoundingClientRect?.();
    if (!box) return null;
    const width = Number(box.width) || 0;
    const height = Number(box.height) || 0;
    const top = Number(box.top) || 0;
    const left = Number(box.left) || 0;
    const bottom = Number.isFinite(Number(box.bottom)) ? Number(box.bottom) : top + height;
    const right = Number.isFinite(Number(box.right)) ? Number(box.right) : left + width;
    return { width, height, top, left, bottom, right };
  }

  function boxInView(box, vh, vw) {
    if (!box || box.width <= 0 || box.height <= 0) return false;
    if (box.bottom <= 0 || box.top >= vh) return false;
    if (box.right <= 0 || box.left >= vw) return false;
    return true;
  }

  function elementShown(el) {
    try {
      const style = getComputedStyle(el);
      if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    } catch { /* a document without layout styles still reports its box */ }
    return true;
  }

  function classText(el) {
    return String(el?.getAttribute?.("class") || "").toLowerCase();
  }

  // complete === false means the browser is still fetching the image.
  // A complete image with naturalWidth 0 is broken. LinkedIn also keeps
  // "ghost" on a default avatar after it has painted. Neither may freeze a session.
  function imageSettled(img) {
    return Boolean(img) && img.tagName === "IMG" && img.complete !== false;
  }

  function markerSettled(el) {
    if (imageSettled(el)) return true;
    const imgs = typeof el.querySelectorAll === "function" ? [...el.querySelectorAll("img")] : [];
    return imgs.length > 0 && imgs.every((img) => img.complete !== false);
  }

  function countPendingImages(vh, vw) {
    let pending = 0;
    for (const img of document.querySelectorAll("img")) {
      if (img.complete !== false) continue;
      if (!elementShown(img)) continue;
      const box = laidOutBox(img);
      if (!box || box.width < 24 || box.height < 24) continue;
      if (!boxInView(box, vh, vw)) continue;
      pending += 1;
    }
    return pending;
  }

  function countLoadingMarkers(vh, vw) {
    const nodes = document.querySelectorAll('[aria-busy="true"], .artdeco-loader, [class*="skeleton"], [class*="Skeleton"], [class*="ghost"], [class*="Ghost"]');
    let count = 0;
    for (const el of nodes) {
      if (!elementShown(el)) continue;
      const box = laidOutBox(el);
      if (!box || box.width < 8 || box.height < 8) continue;
      if (!boxInView(box, vh, vw)) continue;
      const busy = el.getAttribute?.("aria-busy") === "true";
      const loader = el.matches?.(".artdeco-loader") || classText(el).includes("artdeco-loader");
      if (!busy && !loader) {
        const name = classText(el);
        if (!name.includes("skeleton") && !name.includes("ghost")) continue;
        if (markerSettled(el)) continue;
      }
      count += 1;
    }
    return count;
  }

  function railSnapshot() {
    const asides = [...document.querySelectorAll("main aside, #workspace aside")];
    let railText = 0;
    let railControls = 0;
    for (const el of asides) {
      railText += (el.innerText || "").replace(/\s+/g, " ").trim().length;
      railControls += el.querySelectorAll("a, button, img, [role='button']").length;
    }
    return { railText, railControls };
  }

  function feedLoadSnapshot() {
    const column = columnState();
    const { vh, vw } = viewportSize();
    const rails = railSnapshot();
    return {
      readyState: document.readyState || "complete",
      pendingImages: countPendingImages(vh, vw),
      skeletons: countLoadingMarkers(vh, vw),
      feedHeight: column.feedHeight || 0,
      railText: rails.railText,
      railControls: rails.railControls,
      visibleUpdates: column.visibleUpdates || 0,
      top: column.top || 0,
      maxTop: column.maxTop || 0,
    };
  }

  function wheelAnchor() {
    const feed = feedListEl();
    const box = feed?.getBoundingClientRect?.();
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    if (!box || box.width < 80) return null;
    const x = Math.round(box.left + Math.min(box.width * 0.62, box.width - 28));
    for (const y of [200, 280, 360, 460]) {
      if (y < 130 || y > vh - 70) continue;
      const el = document.elementFromPoint?.(x, y);
      if (!el) continue;
      if (el.closest?.("aside, img, video, iframe, canvas, figure, picture, [role='img']")) continue;
      return { x, y };
    }
    return { x, y: Math.max(180, Math.min(360, Math.round(vh * 0.4))) };
  }

  // LinkedIn paints the rails with position:sticky inside main#workspace and lazy-mounts
  // updates in [data-testid=mainFeed]. A jump that pushes that short list above the
  // viewport leaves the rails on screen and the center column blank.
  function healFeedColumn() {
    const workspace = workspaceEl();
    const feed = feedListEl();
    const before = columnState();
    if (!workspace || !feed) return { healed: false, ...before };
    if (before.feedVisible && before.visibleUpdates > 0) return { healed: false, ...before };
    const box = feed.getBoundingClientRect();
    const vh = helpers.feedViewportHeight(window.innerHeight, document.documentElement?.clientHeight, document.body?.clientHeight);
    let next = workspace.scrollTop || 0;
    if (!before.feedVisible && box.bottom < 140) next = Math.max(0, next - (140 - box.bottom));
    else if (!before.feedVisible && box.top > vh - 120) next = next + (box.top - 160);
    else if (before.visibleUpdates === 0 && next > 40) next = Math.max(0, next - Math.min(next, 360));
    if (!Number.isFinite(next) || Math.abs(next - (workspace.scrollTop || 0)) < 8) return { healed: false, ...before };
    const from = workspace.scrollTop || 0;
    workspace.scrollTop = next;
    return { healed: true, from, to: workspace.scrollTop, ...columnState(), top: workspace.scrollTop };
  }

  function pillBox(box) {
    const width = Number(box?.width) || 0;
    const height = Number(box?.height) || 0;
    if (width < 8 || height < 8 || width > 800 || height > 96) return null;
    return box;
  }

  function textBox(el) {
    const doc = el.ownerDocument || document;
    if (typeof doc.createRange !== "function") return null;
    const texts = [];
    const stack = [...(el.childNodes || [])];
    while (stack.length) {
      const node = stack.shift();
      if (node.nodeType === 3 && String(node.textContent || "").trim()) texts.push(node);
      else if (node.childNodes) stack.push(...node.childNodes);
    }
    for (const text of texts) {
      try {
        const range = doc.createRange();
        range.selectNodeContents(text);
        const box = pillBox(range.getBoundingClientRect());
        if (box) return { node: text.parentElement || el, box };
      } catch { /* a document without layout ranges has no text box */ }
    }
    return null;
  }

  // inspect() lists every feed button by labelOf. The visible pill is often the
  // button's parent: the button itself is an empty accessible node.
  function pressBox(el) {
    const own = pillBox(el.getBoundingClientRect());
    if (own) return { node: el, box: own };
    for (const child of el.querySelectorAll("*")) {
      const box = pillBox(child.getBoundingClientRect());
      if (box) return { node: child, box };
    }
    const fromText = textBox(el);
    if (fromText) return fromText;
    let parent = el.parentElement;
    while (parent && parent !== document.body && parent !== document.documentElement) {
      const box = pillBox(parent.getBoundingClientRect());
      if (box) return { node: parent, box };
      parent = parent.parentElement;
    }
    return null;
  }

  function findSeeNewPosts() {
    const vh = helpers.feedViewportHeight(
      window.innerHeight,
      document.documentElement?.clientHeight,
      document.body?.clientHeight,
    );
    const root = feedRoot();
    const matches = [...document.querySelectorAll("button, a, [role='button']")]
      .filter((el) => isLoadMorePostsLabel(labelOf(el)))
      .sort((a, b) => (root?.contains(a) ? 0 : 1) - (root?.contains(b) ? 0 : 1));
    for (const el of matches) {
      let target = pressBox(el);
      if (!target) continue;
      if (!helpers.seeNewPostsVisible(target.box, vh)) {
        const scroller = typeof target.node.scrollIntoView === "function" ? target.node : el;
        if (typeof scroller.scrollIntoView === "function") scroller.scrollIntoView({ block: "center", inline: "nearest" });
        const again = pressBox(el);
        if (again) target = again;
        if (!helpers.seeNewPostsVisible(target.box, vh)) {
          const workspace = workspaceEl();
          if (workspace && Number.isFinite(Number(target.box.top))) {
            workspace.scrollTop = (workspace.scrollTop || 0) + target.box.top - Math.round(vh * 0.4);
            const nudged = pressBox(el);
            if (nudged) target = nudged;
          }
        }
      }
      const box = target.box;
      if (!helpers.seeNewPostsVisible(box, vh)) continue;
      const round = (value) => Math.round(Number(value) || 0);
      return {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        label: (el.innerText || el.getAttribute("aria-label") || labelOf(el)).trim(),
        tag: String(target.node.tagName || "").toLowerCase(),
        box: {
          x: round(box.x),
          y: round(box.y),
          top: round(box.top),
          width: round(box.width),
          height: round(box.height),
        },
      };
    }
    return null;
  }

  function align(urn, control) {
    const post = findPost(urn);
    if (!post) return false;
    const target = control === "more" ? moreControl(post) : likeControl(post)?.button;
    if (!target) return false;
    target.scrollIntoView({ block: control === "like" ? "end" : "nearest", inline: "nearest" });
    return true;
  }

  return { collect, locate, isLiked, inspect, dump, reactionMenuOpen, mediaOverlayOpen, findSeeNewPosts, probe, pointerBounds, align, dismissBlockingModals, columnState, feedLoadSnapshot, wheelAnchor, healFeedColumn, followCandidates, thinFeedFollows, thinFeedFollowPlan, thinFollowStatus, locateFollow, followState, dialogOpen, visitTargets, locateVisit };
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

export async function readFeedColumn(page) {
  return runWorld(page, "columnState");
}

export async function readFeedLoadSnapshot(page) {
  return runWorld(page, "feedLoadSnapshot");
}

export async function feedWheelAnchor(page) {
  return runWorld(page, "wheelAnchor");
}

export async function healFeedColumn(page) {
  return runWorld(page, "healFeedColumn");
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

export async function findFollowCandidates(page) {
  return runWorld(page, "followCandidates");
}

export async function scanThinFeedFollows(page) {
  return runWorld(page, "thinFeedFollows");
}

export async function scanThinFeedFollowPlan(page) {
  return runWorld(page, "thinFeedFollowPlan");
}

export async function readThinFollowStatus(page, url) {
  return runWorld(page, "thinFollowStatus", url);
}

export async function locateFollow(page, profileUrl) {
  return runWorld(page, "locateFollow", profileUrl);
}

export async function followState(page, profileUrl) {
  return runWorld(page, "followState", profileUrl);
}

export async function dialogOpen(page) {
  return runWorld(page, "dialogOpen");
}

export async function findVisitTargets(page) {
  return runWorld(page, "visitTargets");
}

export async function locateVisit(page, url) {
  return runWorld(page, "locateVisit", url);
}
