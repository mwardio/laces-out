import {
  ArrowRight,
  BarChart3,
  BrainCircuit,
  Cable,
  Check,
  ChevronRight,
  CircleDollarSign,
  Eye,
  Gauge,
  Goal,
  KeyRound,
  LineChart,
  MessageSquareQuote,
  RefreshCw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Trophy,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../components/laces-out-mark";
import { siteOpenGraph } from "../lib/public-pages";
import { publicAppStoreUrl, yahooComingSoon } from "../lib/public-site";
import { landingStructuredDataJson } from "../lib/structured-data";
import { PublicSiteFooter } from "./public-site-chrome";

import styles from "./landing-page.module.css";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Laces Out: League-Aware Fantasy Football Advice",
  description: yahooComingSoon
    ? "A free fantasy football companion for ESPN lineup, waiver, trade, and draft decisions tailored to your league."
    : "A free fantasy football companion for ESPN and Yahoo lineup, waiver, trade, and draft decisions tailored to your league.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    ...siteOpenGraph,
    title: "Connect Your Leagues. Get the Next Move. | Laces Out",
    description: yahooComingSoon
      ? "Connect ESPN and get fantasy football recommendations based on your scoring, roster, and available players."
      : "Connect ESPN or Yahoo and get fantasy football recommendations based on your scoring, roster, and available players.",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Connect Your Leagues. Get the Next Move. | Laces Out",
    description: yahooComingSoon
      ? "League-aware lineup, waiver, trade, and draft advice for ESPN fantasy football."
      : "League-aware lineup, waiver, trade, and draft advice for ESPN and Yahoo fantasy football.",
  },
};

const howItWorks = [
  {
    number: "01",
    label: "Connect your existing leagues",
    title: "Bring the leagues you already play.",
    text: yahooComingSoon
      ? "Create a free account, then connect ESPN through the Chrome companion or iOS app and select your team."
      : "Create a free account, then connect Yahoo directly or use the Chrome companion or iOS app for ESPN and select your team.",
    icon: Cable,
  },
  {
    number: "02",
    label: "Review the biggest decisions",
    title: "See the move and the reason.",
    text: "Compare legal starters, available free agents, and trade fits using your league's scoring rules, your roster, and the latest stored league data.",
    icon: BarChart3,
  },
  {
    number: "03",
    label: yahooComingSoon ? "Make the move in ESPN" : "Make the move in your league app",
    title: "You maintain full control.",
    text: yahooComingSoon
      ? "Laces Out recommends the move. You return to ESPN to set the lineup, place the claim, or offer the trade."
      : "Laces Out recommends the move. You return to ESPN or Yahoo to set the lineup, place the claim, or offer the trade.",
    icon: ArrowRight,
  },
] as const;

const aiFeatures = [
  {
    icon: Check,
    title: "The core app works without AI",
    text: "Lineup, waiver, trade, analytics, and draft tools remain available without a model provider.",
  },
  {
    icon: KeyRound,
    title: "Shared or personal provider",
    text: "Use included Gemini when this deployment has it configured, or add your own supported provider key.",
  },
  {
    icon: ShieldCheck,
    title: "Clear data boundaries",
    text: "Your question and a bounded league snapshot go to the provider you select—never fantasy credentials.",
  },
] as const;

const trustPoints = [
  {
    icon: SlidersHorizontal,
    title: "Your league's scoring",
    text: "Supported rules are scored as configured. Unsupported forecast shapes are withheld instead of approximated.",
  },
  {
    icon: LineChart,
    title: "Freshness and uncertainty",
    text: "Recommendations show the inputs behind them, when those inputs were updated, and where uncertainty remains.",
  },
  {
    icon: Eye,
    title: "Read-only league access",
    text: yahooComingSoon
      ? "Laces Out reads the ESPN league data you authorize and never submits a roster move."
      : "Laces Out reads the ESPN or Yahoo league data you authorize and never submits a roster move.",
  },
] as const;

const faqItems = [
  {
    question: "Which league providers can I connect?",
    answer: yahooComingSoon
      ? "ESPN league sync is available through the Chrome companion or iOS app. Yahoo is coming soon on this deployment. Sleeper supplies player and market context, but Sleeper league sync is not implemented."
      : "ESPN league sync is available through the Chrome companion or iOS app, and Yahoo connects through official sign-in. Sleeper supplies player and market context, but Sleeper league sync is not implemented.",
  },
  {
    question: "Do my commissioner or league mates need to join?",
    answer:
      "No commissioner action is required to connect through your own provider access. League mates need their own Laces Out access only if they want to use shared rooms, league recaps, or other member features themselves.",
  },
  {
    question: "Do I need to install or host a server?",
    answer:
      "No. Create an account on the hosted web app and connect your league afterward. Self-hosting is an optional path for people who want to operate their own deployment.",
  },
  {
    question: "What is free?",
    answer:
      "The hosted Laces Out app is free and ad-free. A personal AI-provider key may incur that provider's charges, and self-hosting has whatever infrastructure costs you choose.",
  },
  {
    question: "What do I need to connect ESPN?",
    answer:
      "Use the signed Chrome companion or the iOS app to send scoped league data from your existing ESPN session. After setup, use Laces Out on the web; scheduled refresh depends on the connection mode enabled for your account and deployment.",
  },
  {
    question: "Can Laces Out change my team?",
    answer: yahooComingSoon
      ? "No. Laces Out recommends lineup, waiver, trade, and draft decisions, but you make every move in ESPN."
      : "No. Laces Out recommends lineup, waiver, trade, and draft decisions, but you make every move in ESPN or Yahoo.",
  },
  {
    question: "Which scoring rules and league formats work?",
    answer:
      "Laces Out reads the league's roster and scoring configuration. It shows forecasts only when the relevant rules and format are supported, and flags or withholds output rather than silently guessing.",
  },
  {
    question: "Can I explore before connecting a league?",
    answer:
      "Yes. The demo uses clearly labeled illustrative data and needs no account or league connection. The draft route also opens a browser-local practice room when you are signed out.",
  },
  {
    question: "Is AI required, and what does it receive?",
    answer:
      "AI is optional. If you use Film Room, your question and a bounded snapshot of authorized league data, recommendations, and analytics go to the model provider you select; fantasy credentials do not.",
  },
] as const;

function LandingHeader() {
  return (
    <header className={styles.siteHeader}>
      <div className={styles.headerInner}>
        <Link className={styles.brand} href="/" aria-label="Laces Out home">
          <LacesOutMark />
          <strong>Laces Out</strong>
        </Link>

        <nav className={styles.primaryNav} aria-label="Landing page navigation">
          <a href="#how-it-works">How It Works</a>
          <a href="#in-season">Weekly Decisions</a>
          <a href="#draft-day">Draft Tools</a>
          <a href="#league-fun">League Fun</a>
          <a href="#faq">FAQ</a>
        </nav>

        <div className={styles.headerActions}>
          <Link className={styles.signInButton} href="/login">
            Sign In
          </Link>
          <Link className={styles.headerCta} href="/register">
            Join <ArrowRight aria-hidden="true" size={14} />
          </Link>
        </div>
      </div>
      <nav className={styles.mobileNav} aria-label="Landing page sections">
        <a href="#how-it-works">How it works</a>
        <a href="#in-season">Decisions</a>
        <a href="#league-fun">Recaps</a>
        <a href="#faq">FAQ</a>
      </nav>
    </header>
  );
}

function YahooProviderCard() {
  return (
    <article className={styles.providerCard}>
      <div className={styles.providerCardHead}>
        <div className={styles.providerIdentity}>
          <span className={`${styles.providerBadge} ${styles.yahooBadge}`}>Yahoo</span>
          <div>
            <p>League connection</p>
            <h3>Yahoo Fantasy</h3>
          </div>
        </div>
        <span className={styles.connectionMode}>Official sign-in</span>
      </div>
      <p className={styles.providerDescription}>
        Sign in on Yahoo itself. Laces Out stores an encrypted read-only token, never your Yahoo
        password.
      </p>
      <ul>
        <li>
          <Check aria-hidden="true" size={14} /> Settings, teams, rosters, standings, and matchups
        </li>
        <li>
          <RefreshCw aria-hidden="true" size={14} /> On-request and best-effort scheduled refresh
        </li>
        <li>
          <Check aria-hidden="true" size={14} /> Recommendations only—no Yahoo roster edits
        </li>
      </ul>
    </article>
  );
}

function EspnProviderCard() {
  return (
    <article className={styles.providerCard}>
      <div className={styles.providerCardHead}>
        <div className={styles.providerIdentity}>
          <span className={`${styles.providerBadge} ${styles.espnBadge}`}>ESPN</span>
          <div>
            <p>League connection</p>
            <h3>ESPN Fantasy</h3>
          </div>
        </div>
        <span className={styles.connectionMode}>Chrome or iOS</span>
      </div>
      <p className={styles.providerDescription}>
        Use the Chrome companion or iOS app with your existing ESPN session. Laces Out never asks
        for your ESPN password.
      </p>
      <ul>
        <li>
          <Check aria-hidden="true" size={14} /> Scoring, rosters, standings, matchups, and activity
        </li>
        <li>
          <RefreshCw aria-hidden="true" size={14} /> Device sync, plus scheduled refresh when
          enabled
        </li>
        <li>
          <Check aria-hidden="true" size={14} /> Recommendations only—no ESPN roster edits
        </li>
      </ul>
    </article>
  );
}

function YahooRoadmapCard() {
  return (
    <aside className={styles.providerPending} aria-label="Yahoo Fantasy availability">
      <div>
        <span className={`${styles.providerBadge} ${styles.yahooBadge}`}>Yahoo</span>
        <span className={`${styles.connectionMode} ${styles.connectionModePending}`}>
          Coming soon
        </span>
      </div>
      <h3>Yahoo Fantasy</h3>
      <p>Yahoo league sync is not available on this deployment yet.</p>
    </aside>
  );
}

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>

      <LandingHeader />

      <main id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.heroEyebrow}>
                <Goal aria-hidden="true" size={15} /> Your fantasy football companion
              </p>
              <h1>
                Connect your leagues.
                <span>Get the next move.</span>
              </h1>
              <p className={styles.heroLead}>
                Laces Out pairs with your{" "}
                {yahooComingSoon ? "ESPN league" : "ESPN or Yahoo leagues"} and brings lineup
                advice, waiver pickups, trade ideas, and draft tools into one place.
              </p>
              <p className={styles.heroPersonalization}>
                Recommendations use your league&rsquo;s scoring, your roster, and the players
                available to you—not a generic rankings list.
              </p>
              <p className={styles.heroControl}>
                <ShieldCheck aria-hidden="true" size={15} /> Laces Out recommends the move. You make
                it happen.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryButton} href="/register">
                  Create a free account <ArrowRight aria-hidden="true" size={16} />
                </Link>
                <div className={styles.demoAction}>
                  <Link className={styles.secondaryButton} href="/app">
                    Explore the demo <ChevronRight aria-hidden="true" size={16} />
                  </Link>
                  <small>No account or league connection required.</small>
                </div>
              </div>
            </div>

            <div className={styles.productPreview} aria-label="Illustrative Laces Out dashboard">
              <div className={styles.previewTopbar}>
                <span className={styles.freshness}>
                  <RefreshCw aria-hidden="true" size={13} /> Sample analysis · refreshed 8 min ago
                </span>
                <span className={styles.sampleFlag}>Illustrative league · Week 8</span>
              </div>

              <div className={styles.previewBody}>
                <div className={styles.previewHeading}>
                  <p>North Loop Dynasty</p>
                  <h2>Your highest-impact Week 8 decisions.</h2>
                </div>

                <div className={styles.previewScoreRow}>
                  <article className={styles.matchupCard}>
                    <div className={styles.cardLabel}>
                      <span>Projected matchup · Week 8</span>
                      <span className={styles.edgeLabel}>+5.4 pts</span>
                    </div>
                    <div className={styles.matchupTeams}>
                      <div>
                        <span className={styles.teamMonogram}>LO</span>
                        <strong>Laces Out</strong>
                      </div>
                      <strong>126.8</strong>
                    </div>
                    <div className={styles.matchupTeams}>
                      <div>
                        <span className={`${styles.teamMonogram} ${styles.teamMonogramMuted}`}>
                          FR
                        </span>
                        <strong>Finkle&rsquo;s Revenge</strong>
                      </div>
                      <strong>121.4</strong>
                    </div>
                    <div
                      className={styles.projectionTrack}
                      role="img"
                      aria-label="Projected matchup range from 120 to 130 points; Laces Out leads 126.8 to 121.4"
                    >
                      <span />
                    </div>
                    <div className={styles.projectionScale} aria-hidden="true">
                      <span>120</span>
                      <span>Projected points</span>
                      <span>130</span>
                    </div>
                  </article>

                  <article className={styles.lineupCard}>
                    <div className={styles.cardLabel}>
                      <span>Best lineup move</span>
                      <Gauge aria-hidden="true" size={16} />
                    </div>
                    <div className={styles.swapCall}>
                      <span>FLEX</span>
                      <div>
                        <strong>Start Jayden Reed</strong>
                        <small>over Trey Benson</small>
                      </div>
                      <strong>+3.7 pts</strong>
                    </div>
                    <p className={styles.callMetric}>Projected Week 8 gain</p>
                    <p className={styles.callReason}>
                      Both fit the FLEX slot; Reed has the higher sample forecast.
                    </p>
                  </article>
                </div>

                <article className={styles.waiverCard}>
                  <div>
                    <p className={styles.waiverLabel}>Available in this sample league</p>
                    <p className={styles.waiverPlayers}>
                      <strong>Add Michael Wilson</strong>
                      <span aria-hidden="true">→</span>
                      <strong>Drop Trey Benson</strong>
                    </p>
                  </div>
                  <div className={styles.waiverImpact}>
                    <span>Projected Week 8 gain</span>
                    <strong>+2.1 pts</strong>
                  </div>
                  <p className={styles.waiverReason}>
                    The available receiver improves this roster&rsquo;s best legal lineup in the
                    illustrative forecast.
                  </p>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.signalBar} aria-label="How the forecasts are validated">
          <div className={styles.signalInner}>
            <span>
              <strong>Tested against completed NFL seasons.</strong>
            </span>
            <i aria-hidden="true" />
            <span>Unsupported forecasts stay hidden.</span>
            <i aria-hidden="true" />
            <span>Freshness and limitations stay visible.</span>
            <i aria-hidden="true" />
            <Link className={styles.signalButton} href="/methodology">
              See the results and limitations
            </Link>
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>How it works</p>
              <h2>
                League context in.
                <span>Clear advice out.</span>
              </h2>
            </div>
            <p>
              Laces Out sits beside the fantasy platform you already use. It turns league data into
              a short list of decisions, then leaves every provider-side action to you.
            </p>
          </div>

          <div className={styles.howGrid}>
            {howItWorks.map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.number} className={styles.howCard}>
                  <div className={styles.cardNumber}>
                    <span>{feature.number}</span>
                    <Icon aria-hidden="true" size={18} />
                  </div>
                  <p>{feature.label}</p>
                  <h3>{feature.title}</h3>
                  <span>{feature.text}</span>
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.weekSection} id="in-season">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>Weekly decisions</p>
              <h2>Your next lineup, waiver, and trade moves.</h2>
            </div>
            <p>
              Decision Desk checks the roster you have and the players your league actually leaves
              available, so two managers can get different answers to the same fantasy question.
            </p>
          </div>

          <div className={styles.weekGrid}>
            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <Gauge aria-hidden="true" size={19} />
              </div>
              <span>
                Start / sit · <b>Decision Desk</b>
              </span>
              <h3>Compare legal starters and see the projected weekly impact.</h3>
              <div className={styles.queuePreview}>
                <div>
                  <span className={styles.queueRank}>1</span>
                  <span>
                    <strong>Start Jayden Reed</strong>
                    <small>FLEX · projected +3.7 pts</small>
                  </span>
                  <b>High</b>
                </div>
                <div>
                  <span className={styles.queueRank}>2</span>
                  <span>
                    <strong>Recheck before lock</strong>
                    <small>Forecast freshness visible</small>
                  </span>
                  <b>Watch</b>
                </div>
              </div>
            </article>

            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <LineChart aria-hidden="true" size={19} />
              </div>
              <span>Available pickups</span>
              <h3>Find waiver options that improve your roster, not somebody else&rsquo;s.</h3>
              <div className={styles.pickupPreview}>
                <small>Available WR · illustrative</small>
                <strong>Michael Wilson</strong>
                <span>Best legal drop: Trey Benson</span>
                <p>
                  <span>Projected Week 8 gain</span>
                  <b>+2.1 pts</b>
                </p>
              </div>
            </article>

            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <Scale aria-hidden="true" size={19} />
              </div>
              <span>
                Find trades that fit both rosters · <b>Trade finder</b>
              </span>
              <h3>Look for exchanges that address each manager&rsquo;s roster needs.</h3>
              <div className={styles.tradePreview}>
                <div>
                  <small>You send</small>
                  <strong>D&rsquo;Andre Swift</strong>
                  <span>RB · depth surplus</span>
                </div>
                <ArrowRight aria-hidden="true" size={18} />
                <div>
                  <small>You receive</small>
                  <strong>DeVonta Smith</strong>
                  <span>WR · starting need</span>
                </div>
                <p>
                  <span>Mutual roster fit</span>
                  <strong>86 / 100</strong>
                </p>
              </div>
              <small className={styles.metricNote}>
                A fit score models roster needs—not the chance another manager accepts.
              </small>
            </article>
          </div>

          <div className={styles.weekFootnote}>
            <BarChart3 aria-hidden="true" size={18} />
            <p>
              <strong>
                See how your roster compares · <span>League Analytics</span>
              </strong>
              Strength, depth, luck, schedule pressure, and opponent context stay one click away.
            </p>
            <Link href="/analytics">
              Explore the sample <ArrowRight aria-hidden="true" size={14} />
            </Link>
          </div>
        </section>

        <section className={styles.draftSection} id="draft-day">
          <div className={styles.draftCopy}>
            <p className={styles.sectionKicker}>
              Plan your picks and bids · <span>Draft Studio</span>
            </p>
            <h2>
              Practice the room.
              <span>Track the real one.</span>
            </h2>
            <p>
              Run a browser-local practice draft, or create a shared manual snake or auction room.
              As picks and bids are entered, Laces Out recalculates the board around your remaining
              needs and budget.
            </p>
            <ul>
              <li>
                <Check aria-hidden="true" size={14} /> Browser-local snake and auction practice
              </li>
              <li>
                <Check aria-hidden="true" size={14} /> Shared rooms with manual pick and bid
                tracking
              </li>
              <li>
                <Check aria-hidden="true" size={14} /> Inflation, scarcity, maximum bids, and
                whether a target is likely to last until your next pick
              </li>
            </ul>
            <Link href="/draft" className={styles.inlineLink}>
              Try the practice draft <ArrowRight aria-hidden="true" size={15} />
            </Link>
            <p className={styles.linkNote}>
              No account required for the browser-local practice room.
            </p>
          </div>

          <div className={styles.auctionBoard} aria-label="Illustrative manual auction draft room">
            <div className={styles.boardHeader}>
              <div>
                <span>Illustrative draft · Pick 37</span>
                <strong>North Loop Auction</strong>
              </div>
              <span className={styles.livePill}>
                <i aria-hidden="true" /> Manual room
              </span>
            </div>
            <div className={styles.nomination}>
              <span className={styles.playerTile}>WR</span>
              <div>
                <p>Current nomination</p>
                <h3>CeeDee Lamb</h3>
                <span>DAL · WR1</span>
              </div>
              <div className={styles.bidBlock}>
                <span>Current bid</span>
                <strong>$48</strong>
              </div>
            </div>
            <div className={styles.auctionMetrics}>
              <div>
                <span>Your value</span>
                <strong>$52</strong>
                <small>Your board&rsquo;s estimate</small>
              </div>
              <div>
                <span>Room inflation</span>
                <strong>+7.2%</strong>
                <small>Prices vs. your values</small>
              </div>
              <div>
                <span>Max bid</span>
                <strong>$50</strong>
                <small>Preserves later needs</small>
              </div>
            </div>
            <div className={styles.boardFooter}>
              <span>
                <CircleDollarSign aria-hidden="true" size={15} /> $119 budget · 8 slots open
              </span>
              <span>Next-pick availability: low</span>
            </div>
          </div>
        </section>

        <section className={styles.funSection} id="league-fun">
          <div className={styles.funInner}>
            <div className={styles.funCopy}>
              <p className={styles.sectionKicker}>Make your league more fun</p>
              <h2>Turn the box score into a league receipt.</h2>
              <p>
                The Weekly Reckoning turns final scores into awards like Bad Beat, The Horseshoe,
                Beatdown, and Photo Finish. Share an award card, then keep one recap where league
                members can find it.
              </p>
              <ul>
                <li>
                  <Users aria-hidden="true" size={15} /> Saved recaps are visible to league members
                </li>
                <li>
                  <Sparkles aria-hidden="true" size={15} /> Tone controls range from clean to
                  scorched
                </li>
              </ul>
              <Link href="/analytics#reckoning-recap" className={styles.inlineLink}>
                See a sample recap <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </div>

            <article className={styles.reckoningCard} aria-label="Illustrative Bad Beat award">
              <div className={styles.reckoningHeader}>
                <span>
                  <MessageSquareQuote aria-hidden="true" size={15} /> <b>Weekly Reckoning</b> · Week
                  5
                </span>
                <span>Illustrative</span>
              </div>
              <div className={styles.awardMark}>
                <Trophy aria-hidden="true" size={25} />
              </div>
              <p className={styles.awardLabel}>Bad Beat</p>
              <h3>Budget Ballers did enough to win—almost anywhere else.</h3>
              <p>
                128.4 points would have beaten 7 of 9 other teams in the sample league. This week,
                they lost by 2.8.
              </p>
              <div className={styles.reckoningFooter}>
                <span>Saved for league members</span>
                <span>Shareable award</span>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.syncSection} id="sync">
          <div className={styles.syncInner}>
            <div className={styles.syncIntro}>
              <div>
                <p className={styles.sectionKicker}>
                  <span>League sync</span> · Why it fits
                </p>
                <h2>Recommendations built around your league.</h2>
              </div>
              <div>
                <p>
                  Laces Out combines the rules that determine points, the roster you can change, and
                  the free agents and trade partners unique to your league. That removes the work of
                  translating a national rankings list into your next move.
                </p>
                <p className={styles.syncCadence}>
                  <RefreshCw aria-hidden="true" size={14} /> League-data refresh depends on your
                  connection mode. Forecasts have their own cadence, and the app shows freshness for
                  both instead of promising a fixed completion time.
                </p>
              </div>
            </div>

            <div className={styles.providerGrid}>
              {yahooComingSoon ? (
                <>
                  <EspnProviderCard />
                  <YahooRoadmapCard />
                </>
              ) : (
                <>
                  <YahooProviderCard />
                  <EspnProviderCard />
                </>
              )}
            </div>
          </div>
        </section>

        <section className={styles.trustSection} id="privacy">
          <div className={styles.trustInner}>
            <div className={styles.trustHeading}>
              <p className={styles.sectionKicker}>Why trust it</p>
              <h2>The evidence and the limits stay visible.</h2>
              <p>
                Forecasts are tested against completed NFL seasons. The public methodology shows the
                model-specific results, scoring profiles, and limitations without turning backtests
                into a promise about your record.
              </p>
              <Link href="/methodology" className={styles.inlineLink}>
                Read the methodology <ChevronRight aria-hidden="true" size={15} />
              </Link>
              <p className={styles.trustPromise}>
                Independent, free, and ad-free. No fantasy roster writes.
              </p>
            </div>
            <div className={styles.trustGrid}>
              {trustPoints.map((point) => {
                const Icon = point.icon;
                return (
                  <article key={point.title}>
                    <Icon aria-hidden="true" size={19} />
                    <div>
                      <h3>{point.title}</h3>
                      <p>{point.text}</p>
                    </div>
                  </article>
                );
              })}
              <Link href="/privacy" className={styles.inlineLink}>
                Read the privacy policy <ChevronRight aria-hidden="true" size={15} />
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.aiSection} id="ai-research">
          <div className={styles.aiInner}>
            <div className={styles.aiHeading}>
              <p className={styles.sectionKicker}>
                Ask why a move makes sense · <span>Film Room</span>
              </p>
              <h2>Get an explanation, not another projection.</h2>
              <p>
                Start with the deterministic recommendation. Optional AI can turn the league data
                behind it into a plain-language answer and cite the computed facts it used.
              </p>
            </div>

            <div
              className={styles.aiExample}
              aria-label="Illustrative Film Room question and answer"
            >
              <span>You ask</span>
              <p>&ldquo;Why is Jayden Reed the better FLEX this week?&rdquo;</p>
              <span>Film Room answers</span>
              <p>
                In this illustrative league, both players are legal at FLEX. Reed&rsquo;s current
                Week 8 forecast is 3.7 points higher, so he leads the lineup board. Recheck the
                forecast before lock because the margin can move.
              </p>
            </div>

            <div className={styles.aiGrid}>
              {aiFeatures.map((feature) => {
                const Icon = feature.icon;
                return (
                  <article key={feature.title}>
                    <Icon aria-hidden="true" size={19} />
                    <div>
                      <h3>{feature.title}</h3>
                      <p>{feature.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className={styles.customizationCallout}>
              <SlidersHorizontal aria-hidden="true" size={18} />
              <div>
                <strong>Bring your own football view</strong>
                <p>
                  Import rankings, ADP, auction values, cheat sheets, or custom projections when you
                  want to layer your research onto the built-in board.
                </p>
              </div>
              <Link href="/rankings">
                Explore rankings <ArrowRight aria-hidden="true" size={14} />
              </Link>
            </div>

            <div className={styles.aiDisclosure}>
              <BrainCircuit aria-hidden="true" size={17} />
              <p>
                One-off Film Room questions and answers are not retained. Your selected provider
                still processes the question and bounded league context; shared Weekly Reckoning
                recaps are stored separately as league data.
              </p>
              <Link className={styles.primaryButton} href="/film-room">
                Explore the sample Film Room <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.faqSection} id="faq">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>Before you connect</p>
              <h2>Questions that decide whether Laces Out fits.</h2>
            </div>
            <p>
              Start with the no-account demo, then create a free account when you are ready to use
              your own league.
            </p>
          </div>

          <div className={styles.faqGrid}>
            {faqItems.map((item) => (
              <details key={item.question} className={styles.faqItem}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={`${styles.ctaBand} ${styles.finalCta}`}>
          <div className={styles.finalCtaCopy}>
            <div className={styles.ctaTitle}>
              <span>
                <Goal aria-hidden="true" size={20} />
              </span>
              <h2>See your next league-aware move.</h2>
            </div>
            <p>Free hosted access. Connect your league after signup.</p>
            <a
              className={styles.selfHostLink}
              href="https://github.com/mwardio/laces-out#quick-start"
            >
              Prefer to self-host? Read the setup guide.
            </a>
          </div>
          <div className={styles.ctaActions}>
            <Link className={styles.primaryButton} href="/register">
              Create a free account <ArrowRight aria-hidden="true" size={16} />
            </Link>
            <Link className={styles.secondaryButton} href="/app">
              Explore the demo <ChevronRight aria-hidden="true" size={16} />
            </Link>
            <a className={styles.secondaryButton} href={publicAppStoreUrl}>
              Get the iOS app <Smartphone aria-hidden="true" size={16} />
            </a>
          </div>
        </section>
      </main>

      <PublicSiteFooter />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: landingStructuredDataJson }}
      />
    </div>
  );
}
