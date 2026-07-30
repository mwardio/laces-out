import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  BrainCircuit,
  Cable,
  Check,
  ChevronRight,
  CircleDollarSign,
  ClipboardCheck,
  Clock3,
  Database,
  Eye,
  Gauge,
  KeyRound,
  LineChart,
  LockKeyhole,
  RefreshCw,
  Scale,
  ScanLine,
  ShieldCheck,
  SlidersHorizontal,
  Goal,
  TrendingUp,
  Workflow,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../components/laces-out-mark";
import { yahooComingSoon } from "../lib/public-site";

import { ContactEasterEgg } from "./contact-easter-egg";
import styles from "./landing.module.css";

const socialPreview = {
  url: "/opengraph-image.jpg",
  width: 1733,
  height: 908,
  alt: "Laces Out — Finkle is Einhorn!",
} as const;

export const metadata: Metadata = {
  title: "Laces Out — Automated Fantasy Football Intelligence",
  description: yahooComingSoon
    ? "Sync your ESPN league for built-in weekly forecasts and automated draft, lineup, waiver, trade, and opponent analysis."
    : "Connect Yahoo and ESPN leagues for built-in weekly forecasts and automated draft, lineup, waiver, trade, and opponent analysis.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    title: "Laces Out — Connect your leagues. Get the next move.",
    description: yahooComingSoon
      ? "A private fantasy football locker room with ESPN sync, backtested weekly forecasts, and automated decision analysis."
      : "A private fantasy football locker room that turns fresh Yahoo and ESPN league data into forecasts and prioritized decisions.",
    siteName: "Laces Out",
    url: "/",
    images: [socialPreview],
  },
  twitter: {
    card: "summary_large_image",
    title: "Laces Out — Automated Fantasy Football Intelligence",
    description: yahooComingSoon
      ? "ESPN league sync, built-in weekly forecasts, and automatic league-aware decision analysis."
      : "Yahoo and ESPN sync with built-in weekly forecasts and automatic, league-aware decision analysis.",
    images: [socialPreview],
  },
};

const applicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Laces Out",
  applicationCategory: "SportsApplication",
  operatingSystem: "Web",
  description:
    "Invite-only fantasy football software that syncs leagues, builds weekly forecasts, and automates draft, lineup, waiver, trade, and opponent analysis.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

const seasonFeatures = [
  {
    number: "01",
    label: "Connect your leagues",
    title: "Bring every team into one live picture.",
    text: yahooComingSoon
      ? "Sync ESPN with a private one-click bookmark or the automatic Chrome companion and pull in settings, rosters, standings, matchups, and the team that is actually yours."
      : "Link Yahoo or sync ESPN to pull league settings, rosters, standings, matchups, and the team that is actually yours.",
    icon: Cable,
  },
  {
    number: "02",
    label: "Forecast + decision sweep",
    title: "Let Laces Out recalculate what matters.",
    text: "Backtested weekly forecasts, legal-lineup bye checks, and fresh league inputs rerun lineup, waiver, trade, opponent, and portfolio analysis without asking you to rebuild the context.",
    icon: ScanLine,
  },
  {
    number: "03",
    label: "Add your edge",
    title: "Tune the engine to the way you play.",
    text: "Optional rankings, ADP, custom projections, auction values, and cheat sheets sharpen the built-in forecast. They enhance the automation; they do not power it.",
    icon: SlidersHorizontal,
  },
] as const;

const automationSteps = [
  {
    number: "01",
    title: "Sync",
    text: "Capture league settings, teams, rosters, standings, and matchups.",
    icon: Cable,
  },
  {
    number: "02",
    title: "Normalize",
    text: "League data and NFL-wide signals stay cleanly separated, so nothing gets mixed up or mislabeled.",
    icon: Database,
  },
  {
    number: "03",
    title: "Analyze",
    text: "Recompute lineups, waivers, trades, opponents, and roster strength.",
    icon: BarChart3,
  },
  {
    number: "04",
    title: "Prioritize",
    text: "Rank the calls by expected impact, confidence, urgency, and freshness.",
    icon: ClipboardCheck,
  },
] as const;

const aiFeatures = [
  {
    icon: BrainCircuit,
    title: "Gemini included",
    text: "Every signed-in member starts with Gemini 3.6 Flash analysis. No provider setup or personal API key is required.",
  },
  {
    icon: KeyRound,
    title: "Bring your own model",
    text: "Add an OpenAI, Anthropic, Gemini, DeepSeek, Grok, or OpenRouter key to choose the model and use limits independent from the included allowance.",
  },
  {
    icon: BookOpenCheck,
    title: "Explain with receipts",
    text: "The Film Room receives current league snapshots and deterministic recommendations, then labels the Laces Out sources behind its answer.",
  },
] as const;

const trustPoints = [
  {
    icon: Eye,
    title: "Read-only by default",
    text: "Laces Out recommends. You remain in control of every provider-side move.",
  },
  {
    icon: LockKeyhole,
    title: "Private connections",
    text: "Yahoo authorization stays encrypted server-side. ESPN passwords and cookies stay with ESPN.",
  },
  {
    icon: Database,
    title: "Source-aware data",
    text: "League syncs, nflverse identity and usage data, contextual draft markets, Sleeper signals, and Laces Out forecasts keep separate timestamps and provenance.",
  },
] as const;

export default function LandingPage() {
  return (
    <main className={styles.page}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>

      <header className={styles.siteHeader}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="Laces Out home">
            <LacesOutMark />
            <span>
              <strong>Laces Out</strong>
            </span>
          </Link>

          <nav className={styles.primaryNav} aria-label="Public site navigation">
            <a href="#product">How It Works</a>
            <a href="#sync">Sync</a>
            <a href="#draft-day">Draft Day</a>
            <a href="#in-season">In Season</a>
            <a href="#trust">Trust</a>
          </nav>

          <div className={styles.headerActions}>
            <Link className={styles.textButton} href="/login">
              Sign In
            </Link>
            <Link className={styles.headerCta} href="/register">
              Join <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </header>

      <div id="main-content">
        <section className={styles.hero}>
          <div className={styles.heroFieldLine} aria-hidden="true" />
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <p className={styles.kicker}>
                <Workflow size={14} /> Automated, league-aware fantasy intelligence
              </p>
              <h1>
                Connect your leagues.
                <span>Get the next move.</span>
              </h1>
              <p className={styles.heroLead}>
                Laces Out builds its own weekly forecast and keeps scanning lineups, waivers,
                trades, opponents, and draft rooms—then uses AI to explain the next move.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryButton} href="/register">
                  Create your account <ArrowRight size={16} />
                </Link>
                <Link className={styles.secondaryButton} href="/app">
                  Tour the locker room <ChevronRight size={16} />
                </Link>
              </div>
              <div className={styles.heroProof} aria-label="Product availability">
                <span>
                  <Check size={13} />
                  {yahooComingSoon ? " ESPN league sync" : " Yahoo + ESPN league sync"}
                </span>
                <span>
                  <Check size={13} /> Backtested weekly forecasts
                </span>
                <span>
                  <RefreshCw size={13} /> Fresh right up to kickoff
                </span>
                <span>
                  <BrainCircuit size={13} /> Gemini coaching included
                </span>
              </div>
            </div>

            <div className={styles.productPreview} aria-label="Illustrative Laces Out dashboard">
              <div className={styles.previewTopbar}>
                <span className={styles.previewBrand}>
                  <LacesOutMark compact />
                  <strong>Automated league brief</strong>
                </span>
                <span className={styles.sampleFlag}>Sample league · Week 8</span>
              </div>

              <div className={styles.previewBody}>
                <div className={styles.previewHeading}>
                  <div>
                    <p>North Loop Dynasty</p>
                    <h2>Three calls changed since the last sync.</h2>
                  </div>
                  <span className={styles.freshness}>
                    <RefreshCw size={12} /> Analysis refreshed 8 min ago
                  </span>
                </div>

                <div className={styles.previewScoreRow}>
                  <article className={styles.matchupCard}>
                    <div className={styles.cardLabel}>
                      <span>Current matchup</span>
                      <span className={styles.edgeLabel}>+5.4 edge</span>
                    </div>
                    <div className={styles.matchupTeams}>
                      <div>
                        <span className={styles.teamMonogram}>LO</span>
                        <span>
                          <strong>Laces Out</strong>
                          <small>Projected</small>
                        </span>
                      </div>
                      <strong>126.8</strong>
                    </div>
                    <div className={styles.matchupTeams}>
                      <div>
                        <span className={`${styles.teamMonogram} ${styles.teamMonogramMuted}`}>
                          RW
                        </span>
                        <span>
                          <strong>Roster Weather</strong>
                          <small>Projected</small>
                        </span>
                      </div>
                      <strong>121.4</strong>
                    </div>
                    <div className={styles.projectionTrack}>
                      <span />
                    </div>
                  </article>

                  <article className={styles.lineupCard}>
                    <div className={styles.cardLabel}>
                      <span>Best lineup move</span>
                      <Gauge size={15} />
                    </div>
                    <div className={styles.swapCall}>
                      <span>FLEX</span>
                      <div>
                        <strong>Start J. Reed</strong>
                        <small>over T. Benson</small>
                      </div>
                      <strong>+3.7</strong>
                    </div>
                    <p>Built-in forecast scored to this league’s settings.</p>
                  </article>
                </div>

                <div className={styles.decisionList}>
                  <div className={styles.decisionListHead}>
                    <span>Decision Desk</span>
                    <span>Why now</span>
                    <span>Edge</span>
                  </div>
                  <div className={styles.decisionRow}>
                    <span className={styles.decisionIcon}>
                      <TrendingUp size={14} />
                    </span>
                    <span>
                      <strong>Waiver priority</strong>
                      <small>Add M. Wilson · WR</small>
                    </span>
                    <span>Clears drop threshold</span>
                    <strong>8.4</strong>
                  </div>
                  <div className={styles.decisionRow}>
                    <span className={styles.decisionIcon}>
                      <Scale size={14} />
                    </span>
                    <span>
                      <strong>Trade fit</strong>
                      <small>Target Harbor Lights</small>
                    </span>
                    <span>RB surplus / WR need</span>
                    <strong>A−</strong>
                  </div>
                  <div className={styles.decisionRow}>
                    <span className={styles.decisionIcon}>
                      <Clock3 size={14} />
                    </span>
                    <span>
                      <strong>Opponent watch</strong>
                      <small>Sunday night pivot</small>
                    </span>
                    <span>Questionable starter</span>
                    <strong>SNF</strong>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Backtest-rigor strip: per-validation-run figures only (never lifetime totals — replays
            over the same held-out seasons would double-count evidence). Sources: 3,264 paired
            forecasts and 4 held-out seasons per official replay (reports/ros-validation-v8-*-n8-*,
            .report.forecasts and .coverage.fullyHeldOutSeasons; identical in all three scoring
            profiles), 12,288 release paths per projection (FIRST_PARTY_ROS_DEFAULT_SCENARIOS).
            The forecast count rose from the earlier replay because the sample widened to 8 players
            per position and cutoff — it is still one run's total, not a sum across runs. */}
        <section className={styles.signalBar} aria-label="How the forecasts are validated">
          <div className={styles.signalInner}>
            <span>
              <strong>4</strong> backtested NFL seasons
            </span>
            <i aria-hidden="true" />
            <span>
              <strong>3K+</strong> predictions graded against reality
            </span>
            <i aria-hidden="true" />
            <span>
              <strong>12K+</strong> simulations per projection
            </span>
            <i aria-hidden="true" />
            <Link className={styles.signalLink} href="/methodology">
              If it isn&rsquo;t proven, it isn&rsquo;t published
            </Link>
          </div>
        </section>

        <section className={styles.seasonSection} id="product">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>The operating loop</p>
              <h2>
                New data in.
                <span>Better decisions out.</span>
              </h2>
            </div>
            <p>
              Every successful sync, forecast input change, or custom projection import refreshes
              the decision picture. Custom boards and values can make it more personal, but the loop
              starts working from your connected league data.
            </p>
          </div>

          <div className={styles.seasonGrid}>
            {seasonFeatures.map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.number} className={styles.seasonCard}>
                  <div className={styles.cardNumber}>
                    <span>{feature.number}</span>
                    <Icon size={18} />
                  </div>
                  <p>{feature.label}</p>
                  <h3>{feature.title}</h3>
                  <span>{feature.text}</span>
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.syncSection} id="sync">
          <div className={styles.syncInner}>
            <div className={styles.syncIntro}>
              <div>
                <p className={styles.sectionKicker}>League sync + automation</p>
                <h2>League data travels. Credentials don’t.</h2>
              </div>
              <p>
                {yahooComingSoon
                  ? "ESPN league data lands in a source-aware league model. Once a fresh sync arrives, Laces Out handles the comparison work and rebuilds the calls that matter to each manager."
                  : "Yahoo and ESPN take different paths in, then land in the same source-aware league model. Once fresh data arrives, Laces Out handles the comparison work and rebuilds the calls that matter to each manager."}
              </p>
            </div>

            <div className={styles.syncGrid}>
              <div className={styles.providerStack} aria-label="Supported league connections">
                <article className={styles.providerCard}>
                  <div className={styles.providerCardHead}>
                    <div className={styles.providerIdentity}>
                      <span className={`${styles.providerBadge} ${styles.espnBadge}`}>ESPN</span>
                      <div>
                        <p>League connection</p>
                        <h3>ESPN Fantasy</h3>
                      </div>
                    </div>
                    <span className={styles.connectionMode}>One-click or automatic</span>
                  </div>
                  <p className={styles.providerDescription}>
                    A private sync bookmark or the automatic Chrome companion reads league data
                    through the ESPN session you already opened. Your password and cookies stay on
                    ESPN. Automatic sync also refreshes player availability, box scores,
                    transactions, and draft results as isolated feeds.
                  </p>
                  <ul>
                    <li>
                      <Check size={13} /> One-click bookmark for fast on-demand sync
                    </li>
                    <li>
                      <RefreshCw size={13} /> Optional six-hour refresh with the Chrome companion
                    </li>
                    <li>
                      <Check size={13} /> Availability, scoring, activity, and draft context
                    </li>
                    <li>
                      <Check size={13} />{" "}
                      <a
                        href="https://chromewebstore.google.com/detail/hmilkmcjlkpnigcfnlfogeafacjpmkbj"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Chrome extension
                      </a>
                      &nbsp;pairs with one click—no tokens to copy
                    </li>
                  </ul>
                </article>

                <article className={styles.providerCard}>
                  <div className={styles.providerCardHead}>
                    <div className={styles.providerIdentity}>
                      <span className={`${styles.providerBadge} ${styles.yahooBadge}`}>Yahoo</span>
                      <div>
                        <p>League connection</p>
                        <h3>Yahoo Fantasy</h3>
                      </div>
                    </div>
                    <span
                      className={`${styles.connectionMode}${yahooComingSoon ? ` ${styles.connectionModePending}` : ""}`}
                    >
                      {yahooComingSoon ? "Coming soon" : "Official authorization"}
                    </span>
                  </div>
                  <p className={styles.providerDescription}>
                    {yahooComingSoon
                      ? "Yahoo sign-in and read-only league sync are coming soon."
                      : "Authorize on Yahoo with OAuth and PKCE. Encrypted tokens remain server-side; your Yahoo password never passes through Laces Out."}
                  </p>
                  <ul>
                    <li>
                      <Check size={13} /> Settings, teams, rosters, standings, and matchups
                    </li>
                    <li>
                      {yahooComingSoon ? (
                        <>
                          <Clock3 size={13} /> Yahoo league sync coming soon
                        </>
                      ) : (
                        <>
                          <RefreshCw size={13} /> Refresh when linked or whenever you request it
                        </>
                      )}
                    </li>
                  </ul>
                </article>

                <article className={styles.providerCard}>
                  <div className={styles.providerCardHead}>
                    <div className={styles.providerIdentity}>
                      <span className={styles.providerBadge}>
                        <Database size={15} />
                      </span>
                      <div>
                        <p>Shared NFL intelligence</p>
                        <h3>More than one data feed</h3>
                      </div>
                    </div>
                    <span className={styles.connectionMode}>Daily + hourly checks</span>
                  </div>
                  <p className={styles.providerDescription}>
                    Laces Out blends nflverse identity, usage, injuries, and production with draft
                    markets, Sleeper signals, and the current schedule into a backtested weekly
                    forecast scored for each league—every source and timestamp kept visible.
                    Season-long projections only publish when they pass reliability checks; no
                    guesses dressed up as data.
                  </p>
                  <ul>
                    <li>
                      <RefreshCw size={13} /> Daily identity, usage, status, and draft-market checks
                    </li>
                    <li>
                      <TrendingUp size={13} /> Hourly waiver-market momentum
                    </li>
                    <li>
                      <LineChart size={13} /> Availability-aware rest-of-season ranges
                    </li>
                  </ul>
                </article>
              </div>

              <div className={styles.enginePanel} aria-label="Automated decision analysis flow">
                <div className={styles.engineHeader}>
                  <span>
                    <Workflow size={17} /> Automatic decision sweep
                  </span>
                  <span className={styles.engineState}>
                    <i /> Runs when fresh data lands
                  </span>
                </div>

                <ol className={styles.engineSteps}>
                  {automationSteps.map((step) => {
                    const Icon = step.icon;
                    return (
                      <li key={step.number}>
                        <span className={styles.engineStepIcon}>
                          <Icon size={15} />
                        </span>
                        <span className={styles.engineStepNumber}>{step.number}</span>
                        <div>
                          <strong>{step.title}</strong>
                          <p>{step.text}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>

                <div className={styles.engineOutput}>
                  <div className={styles.engineOutputHead}>
                    <span>
                      <ScanLine size={15} /> Latest sweep
                    </span>
                    <strong>3 calls changed</strong>
                  </div>
                  <div>
                    <span>Lineup edge found</span>
                    <strong>+3.7 pts</strong>
                  </div>
                  <div>
                    <span>Waiver target emerged</span>
                    <strong>High impact</strong>
                  </div>
                  <div>
                    <span>Mutual trade fit improved</span>
                    <strong>86 / 100</strong>
                  </div>
                </div>

                <p className={styles.engineCadence}>
                  Shared player facts, weekly usage, and contextual ADP check daily. Weekly
                  forecasts run hourly, tighten to 10-minute checks near kickoff, and rebuild only
                  from verified inputs. Every completed league sync or custom projection import
                  reruns the decision picture with visible source and freshness details.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.draftSection} id="draft-day">
          <div className={styles.draftCopy}>
            <p className={styles.sectionKicker}>Draft studio</p>
            <h2>The room changes. Your plan recalculates.</h2>
            <p>
              As picks and bids land, Laces Out updates auction inflation, roster construction,
              position scarcity, and the next best value. Bring a custom board if you have one; the
              live assistant remains useful if you don’t.
            </p>
            <ul>
              <li>
                <Check size={14} /> Live inflation, scarcity, and max-bid recalculation
              </li>
              <li>
                <Check size={14} /> Seeded snake and auction practice with undo and replay
              </li>
              <li>
                <Check size={14} /> Contextual ADP, wait risk, custom rankings, and salary overlays
              </li>
            </ul>
            <Link href="/app" className={styles.inlineLink}>
              Tour the locker room <ArrowRight size={15} />
            </Link>
          </div>

          <div className={styles.auctionBoard} aria-label="Illustrative auction draft assistant">
            <div className={styles.boardHeader}>
              <div>
                <span>Pick 37 · Nomination live</span>
                <strong>North Loop Auction</strong>
              </div>
              <span className={styles.livePill}>
                <i /> Live room
              </span>
            </div>
            <div className={styles.nomination}>
              <span className={styles.playerTile}>WR</span>
              <div>
                <p>Current nomination</p>
                <h3>C. Lamb</h3>
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
                <small>Board rank 7</small>
              </div>
              <div>
                <span>Room inflation</span>
                <strong>+7.2%</strong>
                <small>WR +10.4%</small>
              </div>
              <div>
                <span>Max bid</span>
                <strong>$50</strong>
                <small>Preserves $2/slot</small>
              </div>
            </div>
            <div className={styles.boardFooter}>
              <span>
                <CircleDollarSign size={14} /> $119 budget · 8 slots open
              </span>
              <span>Value remaining: $132</span>
            </div>
          </div>
        </section>

        <section className={styles.weekSection} id="in-season">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>The weekly automation layer</p>
              <h2>The league changes. Your decision queue changes with it.</h2>
            </div>
            <p>
              Laces Out checks your roster, every available player, every trade partner, and the
              current opponent together—then sorts the useful calls above the noise.
            </p>
          </div>

          <div className={styles.weekGrid}>
            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <BarChart3 size={19} />
              </div>
              <span>League Analytics</span>
              <h3>See strength, luck, depth, and schedule pressure across every roster.</h3>
              <div className={styles.rankPreview}>
                <span>Power index</span>
                <div>
                  <b>1</b>
                  <span>Harbor Lights</span>
                  <i style={{ width: "88%" }} />
                  <strong>91.4</strong>
                </div>
                <div>
                  <b>2</b>
                  <span>Laces Out</span>
                  <i style={{ width: "81%" }} />
                  <strong>87.1</strong>
                </div>
                <div>
                  <b>3</b>
                  <span>Roster Weather</span>
                  <i style={{ width: "70%" }} />
                  <strong>80.6</strong>
                </div>
              </div>
            </article>

            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <Scale size={19} />
              </div>
              <span>Trade finder</span>
              <h3>Find the deals that create value—and the ones both managers might accept.</h3>
              <div className={styles.tradePreview}>
                <div>
                  <small>You send</small>
                  <strong>D. Swift</strong>
                  <span>RB · depth surplus</span>
                </div>
                <ArrowRight size={18} />
                <div>
                  <small>You receive</small>
                  <strong>D. Smith</strong>
                  <span>WR · starting need</span>
                </div>
                <p>
                  <span>Mutual fit</span>
                  <strong>86 / 100</strong>
                </p>
              </div>
            </article>

            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <LineChart size={19} />
              </div>
              <span>Decision Desk</span>
              <h3>Rank lineup and waiver moves by expected impact, confidence, and urgency.</h3>
              <div className={styles.queuePreview}>
                <div>
                  <span className={styles.queueRank}>1</span>
                  <span>
                    <strong>Submit WR claim</strong>
                    <small>Deadline · Wed 2:00 AM</small>
                  </span>
                  <b>High</b>
                </div>
                <div>
                  <span className={styles.queueRank}>2</span>
                  <span>
                    <strong>Monitor Q tag</strong>
                    <small>Opponent starter · SNF</small>
                  </span>
                  <b>Watch</b>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.aiSection} id="ai-research">
          <div className={styles.aiInner}>
            <div className={styles.aiHeading}>
              <div className={styles.roadmapBadge}>
                <BrainCircuit size={14} /> Optional layer · Available now
              </div>
              <p className={styles.sectionKicker}>Gemini included · Add your own model anytime</p>
              <h2>Fueled by Gemini. Bring another model when you want.</h2>
              <p>
                Film Room works as soon as you sign in, using Gemini 3.6 Flash through the Laces Out
                account. Every request combines synced league facts, the Decision Desk, and league
                analytics so the answer explains the actual board instead of guessing from a generic
                prompt.
              </p>
            </div>

            <div className={styles.aiGrid}>
              {aiFeatures.map((feature) => {
                const Icon = feature.icon;
                return (
                  <article key={feature.title}>
                    <Icon size={18} />
                    <h3>{feature.title}</h3>
                    <p>{feature.text}</p>
                  </article>
                );
              })}
            </div>

            <div className={styles.aiDisclosure}>
              <ShieldCheck size={16} />
              <p>
                Laces Out does not retain prompts or answers — except the Weekly Reckoning recap
                your league asks for, which is saved for the league — and models cannot execute
                Yahoo or ESPN changes. Included calls are routed through Google AI Studio courtesy
                of Laces Out.
              </p>
              <Link className={styles.aiCta} href="/film-room">
                Open Film Room <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.trustSection} id="trust">
          <div className={styles.trustInner}>
            <div className={styles.trustHeading}>
              <p className={styles.sectionKicker}>Built for friends, not ad inventory</p>
              <h2>Your leagues are the product context. They are not the product.</h2>
              <p>
                Laces Out is a private, non-commercial project. No behavioral advertising, no data
                brokerage, and no pretending uncertain provider data is fresher than it is.
              </p>
            </div>
            <div className={styles.trustGrid}>
              {trustPoints.map((point) => {
                const Icon = point.icon;
                return (
                  <article key={point.title}>
                    <Icon size={18} />
                    <div>
                      <h3>{point.title}</h3>
                      <p>{point.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className={styles.providerNote}>
              <Cable size={18} />
              <p>
                Provider connections are read-only today. Laces Out recommends the move and keeps
                the evidence visible; you decide whether to make the change in Yahoo or ESPN.
              </p>
              <Link href="/privacy">
                Read the privacy policy <ChevronRight size={14} />
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.finalCta}>
          <div>
            <span className={styles.ctaIcon}>
              <Goal size={19} />
            </span>
            <div>
              <p>Have the league code?</p>
              <h2>Your next good decision starts here.</h2>
            </div>
          </div>
          <div className={styles.finalActions}>
            <Link className={styles.primaryButton} href="/register">
              Join Laces Out <ArrowRight size={16} />
            </Link>
            <Link className={styles.secondaryButton} href="/login">
              Sign In
            </Link>
          </div>
        </section>
      </div>

      <footer className={styles.siteFooter}>
        <div className={styles.footerTop}>
          <Link className={styles.brand} href="/" aria-label="Laces Out home">
            <LacesOutMark compact />
            <span>
              <strong>Laces Out</strong>
            </span>
          </Link>
          <p>Connected leagues. Automatic analysis. Better Sundays.</p>
          <nav aria-label="Legal and account links">
            <Link href="/methodology">Methodology</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <ContactEasterEgg />
            <Link href="/login">Sign In</Link>
          </nav>
        </div>
        <div className={styles.footerBottom}>
          <span>© 2026 Laces Out. Private beta.</span>
          <span>
            Independent and non-commercial. Not affiliated with or endorsed by Yahoo or ESPN.
          </span>
        </div>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(applicationSchema).replaceAll("<", "\\u003c"),
        }}
      />
    </main>
  );
}
