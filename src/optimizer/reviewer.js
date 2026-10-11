import { config, sampleSessionPlan } from "../config.js";
import { createLogger } from "../logger.js";
import { getDayStats } from "../sessionState.js";
import { reserveAction, finishAction } from "../activity.js";
import { isWeekendIst, istNow } from "../util/time.js";
import { inviteHoldReason, loadSharedDay } from "../inviteHold.js";
import { planSessionBudget } from "../sessionBudget.js";

function loadShared() {
  try { return loadSharedDay(); } catch { return null; }
}

const log = createLogger("optimizer");

function deny(reason) {
  return { allow: false, reason };
}

function allow(reason) {
  return { allow: true, reason };
}

export class Optimizer {
  constructor(state) {
    this.state = state;
    this.plan = null;
    this.notes = [];
  }

  note(message, extra) {
    this.notes.push({ at: new Date().toISOString(), message, extra });
    log.info(message, extra);
  }

  preflight() {
    const now = istNow();
    const day = getDayStats(this.state, now.dateKey);
    const last = this.state.lastSession;
    const plan = sampleSessionPlan();
    if (config.connectionTrial) {
      if (config.testRun) return { allow: false, reason: "A connection trial cannot be combined with browse-only test mode.", plan };
      if (!config.connectionsEnabled) return { allow: false, reason: "Enable connections before running a connection trial.", plan };
      plan.connectionTrial = true;
      plan.sessionMs = Math.min(plan.sessionMs, 4 * 60_000);
      plan.likeCap = 0;
      plan.followCap = 0;
      Object.assign(plan, { order: ["feed", "grow"], search: false, searchCompany: false, searchConnect: false, inviteCount: 1, feedVisits: 0, growVisits: 0 });
      this.note("Connection trial: short feed session, zero likes, at most one invitation. Normal production budgets apply.");
    }

    if (this.state.pause) return { allow: false, reason: `Profile paused: ${this.state.pause.reason}. Manual review and resume required.`, plan };

    this.note("Checking activity limits and profile state.");
    if (config.testRun) {
      plan.testRun = true;
      plan.likeCap = 0;
      plan.followCap = 0;
      Object.assign(plan, { order: ["feed"], search: false, searchCompany: false, searchConnect: false, inviteCount: 0, feedVisits: 0, growVisits: 0 });
      plan.sessionMs = Math.min(plan.sessionMs, 4 * 60_000);
      this.note("TEST_RUN: shortening the session so this is a pipeline check, not a full day slot.");
    }

    if (last?.checkpoint && !this.state.reviewedAt) {
      const cooldownUntil = new Date(last.at).getTime() + 48 * 3600 * 1000;
      if (Date.now() < cooldownUntil) {
        return { allow: false, reason: "Previous session hit a LinkedIn checkpoint. 48h cooldown.", plan };
      }
    }

    if ((day.infraFailures || 0) >= config.dailyInfraFailureLimit && !plan.testRun && !config.allowBlockedDay) {
      return { allow: false, reason: `Daily limit of ${config.dailyInfraFailureLimit} infrastructure failures reached; skipping this profile until IST midnight.`, plan };
    }
    if (day.aborted >= config.dailyFailureLimit && !plan.testRun && !config.allowBlockedDay) {
      return { allow: false, reason: `Daily limit of ${config.dailyFailureLimit} failed production sessions reached.`, plan };
    }
    if (day.sessions >= config.dailySessionLimit && !plan.testRun && !config.allowBlockedDay) {
      return { allow: false, reason: `Daily limit of ${config.dailySessionLimit} production sessions reached.`, plan };
    }
    if (config.allowBlockedDay && (day.aborted >= 2 || day.sessions >= 3)) {
      this.note("Operator overrode today's session/abort caps. This is not the default safety policy.", {
        aborted: day.aborted,
        sessions: day.sessions,
      });
    }

    if (day.likes >= config.dailyLikeBudget) {
      plan.likeCap = 0;
      this.note("Daily like budget already spent. This session is browse-only.", { budget: config.dailyLikeBudget });
    }

    if (last?.likes >= 3) {
      plan.likeCap = Math.min(plan.likeCap, 1);
      this.note("Last session hit the like cap. Cutting this session to at most 1 like.");
    }

    if (isWeekendIst()) {
      plan.likeCap = Math.min(plan.likeCap, 1);
      plan.sessionMs = Math.min(plan.sessionMs, 11 * 60_000);
      this.note("Weekend: shorter session and lower like cap.");
    }

    const remainingBudget = Math.max(0, config.dailyLikeBudget - day.likes);
    if (!plan.testRun) {
      plan.likeCap = Math.min(plan.likeCap, remainingBudget, config.likeCapPerSession);
    }

    if (!config.likesEnabled) {
      plan.likeCap = 0;
      this.note("LIKES_ENABLED=false. Browse only.");
    }

    if (config.verifyWarmupIgnored) {
      this.note("VERIFY_WARMUP is ignored for scheduled sessions; using the production plan.");
    }
    if (config.verifyWarmup && !plan.testRun && !plan.connectionTrial) {
      Object.assign(plan, {
        verify: true,
        followCap: Math.max(1, plan.followCap || 0),
        followRecommended: true,
      });
      this.note("VERIFY_WARMUP: feed checks only. Profile views and off-network connects stay off.");
    }

    const followsLeft = Math.max(0, config.follow.dailyBudget - (day.follows || 0));
    plan.followCap = Math.min(plan.followCap ?? 0, config.follow.hardCapPerSession, followsLeft);

    if (!config.connectionsEnabled) {
      plan.inviteCount = 0;
      plan.searchConnect = false;
    }
    const hold = inviteHoldReason(this.state, new Date(), loadShared());
    if (hold && (plan.inviteCount || plan.searchConnect)) {
      plan.inviteCount = 0;
      plan.searchConnect = false;
      this.note("Invites are held for this profile. Feed browsing continues without profile views.", { hold });
    }
    const minInvites = Number.parseInt(process.env.WARMUP_MIN_INVITES || "", 10);
    if (!hold && config.connectionsEnabled && !plan.testRun && Number.isInteger(minInvites) && minInvites > 0) {
      plan.inviteCount = Math.min(config.growInviteHardCap, Math.max(plan.inviteCount || 0, minInvites));
      if (!plan.order.includes("grow")) plan.order = ["feed", "grow"];
      this.note("This session will send at least one My Network invitation.", { inviteCount: plan.inviteCount });
    }
    // Profile and company pages stay closed. Invitations are only the My Network step,
    // and only after the feed, for the sampled count.
    plan.search = false;
    plan.searchCompany = false;
    plan.searchConnect = false;
    plan.feedVisits = 0;
    plan.growVisits = 0;
    // The sampled session length covers feed + My Network + the post-invite linger.
    const budget = planSessionBudget(plan);
    plan.feedMs = budget.feedMs;
    plan.growMs = budget.growMs;
    if (budget.trimmed && (plan.order || []).includes("grow")) {
      this.note("Session time budget: My Network gets fewer invitations so the whole session fits.", {
        sessionMinutes: Math.round(plan.sessionMs / 6000) / 10, requested: budget.requestedInvites, invites: budget.inviteCount,
      });
    }
    if ((plan.order || []).includes("grow")) plan.inviteCount = budget.inviteCount;
    const steps = (plan.order || ["feed"]).filter((step) => step === "feed" || (step === "grow" && plan.inviteCount > 0));
    plan.order = steps.includes("feed") ? steps : ["feed", ...steps];

    if (day.sessions === 0) {
      this.note("First session of the day. Do not like the top of the feed. Warm up the scroll first.");
    }

    this.note("Approved plan for the scenario builder.", {
      sessionMinutes: Math.round(plan.sessionMs / 6000) / 10,
      feedMinutes: Math.round(plan.feedMs / 6000) / 10,
      growMinutes: Math.round(plan.growMs / 6000) / 10,
      likeRate: Number(plan.likeRate.toFixed(3)),
      expandRate: Number(plan.expandRate.toFixed(3)),
      likeCap: plan.likeCap,
      followCap: plan.followCap,
      followRecommended: plan.followRecommended,
      skipFirstPosts: plan.skipFirstPosts,
      reverseScrollChance: plan.reverseScrollChance,
      order: plan.order,
      search: plan.search,
      searchCompany: plan.searchCompany,
      searchConnect: plan.searchConnect,
      verify: Boolean(plan.verify),
      inviteCount: plan.inviteCount,
      feedVisits: plan.feedVisits,
      growVisits: plan.growVisits,
      postViewChance: Number((plan.postViewChance ?? 0).toFixed(3)),
      videoWatchCap: plan.videoWatchCap ?? 0,
    });

    this.plan = plan;
    return {
      allow: true,
      reason: "Plan is conservative enough to run.",
      plan,
    };
  }

  gateExpand({ post, stats }) {
    const plan = this.plan;
    if (!plan) return deny("No plan.");
    if (!post.hasMore) return deny("No More control on this post.");
    if (post.promoted) return deny("Do not expand ads.");
    const rate = stats.expanded / Math.max(stats.postsSeen, 1);
    if (rate >= plan.expandRate) return deny("Already at 30-40% expand target for this session.");
    if (Math.random() > 0.9) return deny("This post was not selected for expansion.");
    this.note("Allowing More expand.", { urn: post.urn, expanded: stats.expanded + 1, postsSeen: stats.postsSeen });
    return allow("Expand, wait, then decide on like.");
  }

  gateLike({ post, stats, elapsedMs, remainingMs }) {
    const plan = this.plan;
    if (!plan) return deny("No plan. Builder started without optimizer approval.");
    if (plan.likeCap <= 0) return deny("This session is browse-only.");
    if ((stats.likeAttempts ?? stats.likes) >= plan.likeCap) return deny("Session like cap reached.");
    if (elapsedMs < plan.warmupMs) return deny("Still in the browsing-only opening period.");
    if (remainingMs < plan.windDownMs) return deny("Wind-down. No new engagement near session end.");
    if (stats.postsSeen < plan.skipFirstPosts) return deny("Too close to the top of the feed.");
    if (post.promoted) return deny("Promoted/sponsored. Skip.");
    if (post.liked) return deny("Already reacted.");
    if (!post.hasLike) return deny("Like control is not clearly available.");
    if (post.textLen < 40) return deny("Post is below the minimum content length for a like.");
    if (stats.lastLikeAt && Date.now() - stats.lastLikeAt < plan.minMsBetweenLikes) {
      return deny("Minimum interval between likes has not elapsed.");
    }
    const attempts = stats.likeAttempts ?? stats.likes ?? 0;
    if (attempts > 0) {
      const prospectiveRate = (attempts + 1) / Math.max(stats.postsSeen, 1);
      if (prospectiveRate > plan.likeRate) return deny("Would exceed the 2-5% like rate.");
    }
    const allowOdds = post.didExpand ? 0.55 : 0.38;
    if (Math.random() > allowOdds) return deny("Post was not selected for a like.");

    this.note("Allowing one like.", { urn: post.urn, likes: stats.likes + 1, postsSeen: stats.postsSeen, expanded: Boolean(post.didExpand) });
    return allow("Passes rate, cap, warmup, spacing, and content checks.");
  }

  reserveLike(post) {
    return reserveAction(this.state, "like", post.urn, { limit: this.plan.likeCap });
  }

  finishLike(id, confirmed) {
    finishAction(this.state, id, confirmed);
  }

  gateFollow({ candidate, stats, elapsedMs, remainingMs, roll = Math.random() }) {
    const plan = this.plan;
    if (!plan) return deny("No plan.");
    const cap = Math.min(plan.followCap ?? 0, config.follow.hardCapPerSession);
    if (cap <= 0) return deny("This session does not follow anyone.");
    if ((stats.followAttempts || 0) >= cap) return deny("Session follow cap reached.");
    if (!candidate?.profileUrl || !/\/in\/[^/]+\/$/.test(candidate.profileUrl)) return deny("Follow target is not a person profile.");
    if (candidate.promoted) return deny("Do not follow from ads.");
    if (candidate.source === "recommended") {
      if (!plan.followRecommended) return deny("Recommended for you module skipped this session.");
      if ((stats.recommendedFollows || 0) >= 1) return deny("Already followed one person from Recommended for you.");
    } else if (candidate.source !== "suggested") {
      return deny("Follow control is not in an approved feed surface.");
    }
    if (elapsedMs < plan.warmupMs) return deny("Still in the browsing-only opening period.");
    if (remainingMs < plan.windDownMs) return deny("Wind-down. No new engagement near session end.");
    if (stats.lastFollowAt && Date.now() - stats.lastFollowAt < plan.minMsBetweenFollows) return deny("Minimum interval between follows has not elapsed.");
    if (stats.lastLikeAt && Date.now() - stats.lastLikeAt < 30_000) return deny("Just liked a post.");
    if (!plan.verify && roll > config.follow.pickChance) return deny("Person was not selected for a follow.");
    this.note("Allowing one follow.", { source: candidate.source, profileUrl: candidate.profileUrl, attempts: (stats.followAttempts || 0) + 1 });
    return allow("Passes session cap, surface, warmup, and spacing checks.");
  }

  reserveFollow(candidate) {
    return reserveAction(this.state, "follow", candidate.profileUrl, { limit: Math.min(this.plan.followCap, config.follow.hardCapPerSession) });
  }

  finishFollow(id, confirmed) {
    finishAction(this.state, id, confirmed);
  }

  postflight(result) {
    const now = istNow();
    const run = this.state.currentRun;
    const day = getDayStats(this.state, run?.dayKey || now.dateKey);
    day.postsSeen += result.postsSeen;
    if (result.aborted) {
      if (result.failureKind === "operator") {
        if (!this.plan?.testRun) day.sessions = Math.max(0, day.sessions - 1);
      } else if (this.plan?.testRun) day.testFailures = (day.testFailures || 0) + 1;
      else if (result.failureKind === "infra") {
        day.infraFailures = (day.infraFailures || 0) + 1;
        day.sessions = Math.max(0, day.sessions - 1);
      }
      else day.aborted += 1;
    }

    this.state.lastSession = {
      at: new Date().toISOString(),
      dateKey: now.dateKey,
      likes: result.likes,
      postsSeen: result.postsSeen,
      expanded: result.expanded || 0,
      durationMs: result.durationMs,
      aborted: result.aborted,
      checkpoint: result.checkpoint,
      connections: result.connections || 0,
      follows: result.follows || 0,
      reason: result.reason || null,
      failureKind: result.failureKind || null,
      testRun: Boolean(this.plan?.testRun),
      reasons: result.deniedReasons,
    };
    const outcome = !result.aborted ? "completed" : result.failureKind === "operator" ? "interrupted" : "failed";
    this.state.history.push({ ...run, ...this.state.lastSession, outcome });
    this.state.history = this.state.history.slice(-200);
    this.state.currentRun = null;
    this.state.optimizerNotes = [...(this.state.optimizerNotes || []), ...this.notes].slice(-80);

    if (result.checkpoint) {
      this.note("HARD STOP guidance: do not rerun until a human has opened this profile manually.");
    } else if (result.likes === 0 && result.postsSeen > 20) {
      this.note("Session completed without likes; future sessions retain their usual engagement checks.");
    } else if (result.likes >= 3) {
      this.note("Session like cap reached; the next session will have a lower like cap.");
    }

    this.note("Session closed.", {
      likes: result.likes,
      postsSeen: result.postsSeen,
      expanded: result.expanded,
      seeNewPosts: result.seeNewPosts,
      durationMin: Math.round(result.durationMs / 6000) / 10,
      aborted: result.aborted,
    });
  }

}
