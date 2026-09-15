import { config, sampleSessionPlan } from "../config.js";
import { createLogger } from "../logger.js";
import { getDayStats } from "../sessionState.js";
import { reserveAction, finishAction } from "../activity.js";
import { randomInt } from "../util/random.js";
import { isWeekendIst, istNow } from "../util/time.js";

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
      this.note("Connection trial: short feed session, zero likes, at most one invitation. Normal production budgets apply.");
    }

    if (this.state.pause) return { allow: false, reason: `Profile paused: ${this.state.pause.reason}. Manual review and resume required.`, plan };

    this.note("Checking activity limits and profile state.");

    const outsideHours = now.hour < config.workStartHour || now.hour >= config.workEndHour;
    if (outsideHours && !config.forceOutsideHours) {
      return { allow: false, reason: `Outside IST work window (${config.workStartHour}:00-${config.workEndHour}:00).`, plan };
    }
    if (outsideHours && config.forceOutsideHours && config.testRun) {
      plan.testRun = true;
      plan.likeCap = 0;
      plan.sessionMs = randomInt(150_000, 210_000);
      plan.warmupMs = randomInt(20_000, 35_000);
      plan.windDownMs = randomInt(12_000, 22_000);
      plan.skipFirstPosts = randomInt(4, 7);
      this.note("Off-hours diagnostic: short browse-only session, zero likes or invitations.");
    }
    if (config.testRun && !plan.testRun) {
      plan.testRun = true;
      plan.likeCap = 0;
      plan.sessionMs = Math.min(plan.sessionMs, 4 * 60_000);
      this.note("TEST_RUN: shortening the session so this is a pipeline check, not a full day slot.");
    }

    if (last?.checkpoint && !this.state.reviewedAt) {
      const cooldownUntil = new Date(last.at).getTime() + 48 * 3600 * 1000;
      if (Date.now() < cooldownUntil) {
        return { allow: false, reason: "Previous session hit a LinkedIn checkpoint. 48h cooldown.", plan };
      }
    }

    if (day.aborted >= 2 && !plan.testRun && !config.allowBlockedDay) {
      return { allow: false, reason: "Two failed production sessions today; further production runs are blocked.", plan };
    }
    if (day.sessions >= 3 && !plan.testRun && !config.allowBlockedDay) {
      return { allow: false, reason: "Daily limit of three production sessions reached.", plan };
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

    if (day.sessions === 0) {
      this.note("First session of the day. Do not like the top of the feed. Warm up the scroll first.");
    }

    this.note("Approved plan for the scenario builder.", {
      sessionMinutes: Math.round(plan.sessionMs / 6000) / 10,
      likeRate: Number(plan.likeRate.toFixed(3)),
      expandRate: Number(plan.expandRate.toFixed(3)),
      likeCap: plan.likeCap,
      skipFirstPosts: plan.skipFirstPosts,
      reverseScrollChance: plan.reverseScrollChance,
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
    const prospectiveRate = ((stats.likeAttempts ?? stats.likes) + 1) / Math.max(stats.postsSeen, 1);
    if (prospectiveRate > plan.likeRate) return deny("Would exceed the 2-5% like rate.");
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

  postflight(result) {
    const now = istNow();
    const run = this.state.currentRun;
    const day = getDayStats(this.state, run?.dayKey || now.dateKey);
    day.postsSeen += result.postsSeen;
    if (result.aborted) {
      if (this.plan?.testRun) day.testFailures = (day.testFailures || 0) + 1;
      else day.aborted += 1;
    }

    this.state.lastSession = {
      at: new Date().toISOString(),
      dateKey: now.dateKey,
      likes: result.likes,
      postsSeen: result.postsSeen,
      durationMs: result.durationMs,
      aborted: result.aborted,
      checkpoint: result.checkpoint,
      connections: result.connections || 0,
      reason: result.reason || null,
      testRun: Boolean(this.plan?.testRun),
      reasons: result.deniedReasons,
    };
    this.state.history.push({ ...run, ...this.state.lastSession, outcome: result.aborted ? "failed" : "completed" });
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
