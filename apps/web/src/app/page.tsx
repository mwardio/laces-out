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
  LockKeyhole,
  RefreshCw,
  Scale,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LacesOutMark } from "../components/laces-out-mark";
import { publicAppStoreUrl, yahooComingSoon } from "../lib/public-site";
import { PublicSiteFooter } from "./public-site-chrome";

import styles from "./landing-page.module.css";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: "Laces Out: Automated Fantasy Football Intelligence",
  description: yahooComingSoon
    ? "Sync your ESPN league for fresh forecasts and ranked fantasy football decisions."
    : "Connect Yahoo and ESPN leagues for fresh forecasts and ranked fantasy football decisions.",
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    title: "Laces Out: Connect your leagues. Get the next move.",
    description: yahooComingSoon
      ? "A private fantasy football locker room with ESPN sync, backtested weekly forecasts, and ranked decisions."
      : "A private fantasy football locker room that turns fresh Yahoo and ESPN league data into forecasts and ranked decisions.",
    siteName: "Laces Out",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Laces Out: Automated Fantasy Football Intelligence",
    description: yahooComingSoon
      ? "ESPN league sync, built-in weekly forecasts, and automatic league-aware decision analysis."
      : "Yahoo and ESPN sync with built-in weekly forecasts and automatic, league-aware decision analysis.",
  },
};

const applicationSchema = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Laces Out",
  applicationCategory: "SportsApplication",
  operatingSystem: "Web, iOS",
  description:
    "Fantasy football software that syncs leagues, builds weekly forecasts, and automates draft, lineup, waiver, trade, and opponent analysis.",
  downloadUrl: publicAppStoreUrl,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
};

const howItWorks = [
  {
    number: "01",
    label: "Connect your leagues",
    title: "Bring every team together.",
    text: yahooComingSoon
      ? "Connect ESPN through the Chrome companion or iOS app. Laces Out pulls settings, rosters, standings, and matchups, and knows which team is yours."
      : "Link Yahoo with one sign-in, or connect ESPN through the Chrome companion or iOS app. Laces Out pulls settings, rosters, standings, and matchups, and knows which team is yours.",
    icon: Cable,
  },
  {
    number: "02",
    label: "Forecast + decision sweep",
    title: "Recalculate what matters.",
    text: "Backtested weekly forecasts and fresh league inputs rerun lineup, waiver, trade, and opponent analysis automatically, then rank every call by expected impact, confidence, and urgency.",
    icon: BarChart3,
  },
  {
    number: "03",
    label: "Add your edge",
    title: "Make it yours.",
    text: "Optional rankings, ADP, custom projections, auction values, and cheat sheets sharpen the built-in forecast.",
    icon: SlidersHorizontal,
  },
] as const;

const aiFeatures = [
  {
    icon: BrainCircuit,
    title: "Gemini included",
    text: "No provider setup.",
  },
  {
    icon: KeyRound,
    title: "Bring your own model",
    text: "Choose your preferred model.",
  },
  {
    icon: ShieldCheck,
    title: "Explain with receipts",
    text: "Answers cite the underlying data.",
  },
] as const;

const trustPoints = [
  {
    icon: Eye,
    title: "Read-only by default",
    text: "You approve every provider-side move.",
  },
  {
    icon: LockKeyhole,
    title: "Private connections",
    text: "Connections are encrypted. Provider passwords are never collected.",
  },
  {
    icon: LineChart,
    title: "Source-aware data",
    text: "Every number shows where it came from and when it was last updated.",
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
          <a href="#sync">Sync</a>
          <a href="#draft-day">Draft Day</a>
          <a href="#in-season">In Season</a>
          <a href="#privacy">Privacy</a>
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
        Sign in on Yahoo itself. Laces Out keeps an encrypted read-only token, never your password.
      </p>
      <ul>
        <li>
          <Check aria-hidden="true" size={14} /> Settings, teams, rosters, standings, and matchups
        </li>
        <li>
          <RefreshCw aria-hidden="true" size={14} /> Refreshes on link and on request
        </li>
        <li>
          <Check aria-hidden="true" size={14} /> Read-only: Laces Out never edits your Yahoo roster
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
        <span className={styles.connectionMode}>Automatic sync</span>
      </div>
      <p className={styles.providerDescription}>
        Connect ESPN through the Chrome companion or iOS app. Laces Out keeps your league synced on
        a schedule and never sees your ESPN password.
      </p>
      <ul>
        <li>
          <Check aria-hidden="true" size={14} /> Private multi-league sync
        </li>
        <li>
          <RefreshCw aria-hidden="true" size={14} /> Refreshes within five minutes when you ask
        </li>
        <li>
          <Check aria-hidden="true" size={14} /> Availability, scoring, activity, and draft context
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
      <p>Yahoo sync is next on the roadmap.</p>
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
              <h1>
                Connect your leagues.
                <span>Get the next move.</span>
              </h1>
              <p className={styles.heroLead}>
                Every time your {yahooComingSoon ? "ESPN" : "Yahoo or ESPN"} league changes, Laces
                Out reruns the lineup, waiver, and trade math and ranks the calls by the points at
                stake. It never touches your roster or asks for your password.
              </p>
              <div className={styles.heroActions}>
                <Link className={styles.primaryButton} href="/register">
                  Create your account <ArrowRight aria-hidden="true" size={16} />
                </Link>
                <Link className={styles.secondaryButton} href="/app">
                  See a sample week <ChevronRight aria-hidden="true" size={16} />
                </Link>
              </div>
              <div className={styles.heroProof} aria-label="Product availability">
                <span>
                  <Check aria-hidden="true" size={14} />
                  {yahooComingSoon ? "ESPN syncing" : "ESPN & Yahoo syncing"}
                </span>
                <span>
                  <Check aria-hidden="true" size={14} /> Access on web + iOS
                </span>
                <span>
                  <Check aria-hidden="true" size={14} /> Backtested across 4 NFL seasons
                </span>
              </div>
            </div>

            <div className={styles.productPreview} aria-label="Illustrative Laces Out dashboard">
              <div className={styles.previewTopbar}>
                <span className={styles.freshness}>
                  <RefreshCw aria-hidden="true" size={13} /> Analysis refreshed 8 min ago
                </span>
                <span className={styles.sampleFlag}>Sample league · Week 8</span>
              </div>

              <div className={styles.previewBody}>
                <div className={styles.previewHeading}>
                  <p>North Loop Dynasty</p>
                  <h2>Three calls changed since the last sync.</h2>
                </div>

                <div className={styles.previewScoreRow}>
                  <article className={styles.matchupCard}>
                    <div className={styles.cardLabel}>
                      <span>Current matchup</span>
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
                    <div className={styles.projectionTrack} aria-hidden="true">
                      <span />
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
                        <strong>Start J. Reed</strong>
                        <small>over T. Benson</small>
                      </div>
                      <strong>+3.7 pts</strong>
                    </div>
                  </article>
                </div>

                <article className={styles.waiverCard}>
                  <div>
                    <p className={styles.waiverLabel}>Waiver move</p>
                    <p className={styles.waiverPlayers}>
                      <strong>Add M. Wilson</strong>
                      <span aria-hidden="true">→</span>
                      <strong>Drop T. Benson</strong>
                    </p>
                  </div>
                  <div className={styles.waiverImpact}>
                    <span>Roster gain</span>
                    <strong>+2.1 pts</strong>
                  </div>
                </article>
              </div>
            </div>
          </div>
        </section>

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
            <Link className={styles.signalButton} href="/methodology">
              See the methodology
            </Link>
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>How it works</p>
              <h2>
                New data in.
                <span>Better decisions out.</span>
              </h2>
            </div>
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

        <section className={styles.syncSection} id="sync">
          <div className={styles.syncInner}>
            <div className={styles.syncIntro}>
              <div>
                <p className={styles.sectionKicker}>League sync</p>
                <h2>Fresh league data. Your password stays put.</h2>
              </div>
              <div>
                <p>
                  {yahooComingSoon
                    ? "ESPN connects through the Chrome companion or iOS app. Laces Out holds a read-only connection, never your password, and rebuilds your calls whenever fresh data lands."
                    : "Yahoo signs you in on Yahoo. ESPN connects through the Chrome companion or iOS app. Either way, Laces Out holds a read-only connection, never your password, and rebuilds your calls whenever fresh data lands."}
                </p>
                <p className={styles.syncCadence}>
                  <RefreshCw aria-hidden="true" size={14} /> Forecasts refresh hourly, and every 10
                  minutes near kickoff.
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

        <section className={styles.draftSection} id="draft-day">
          <div className={styles.draftCopy}>
            <p className={styles.sectionKicker}>Draft studio</p>
            <h2>
              The room changes.
              <span>Your plan recalculates.</span>
            </h2>
            <p>
              Every pick or bid recalculates inflation, roster construction, scarcity, and your next
              best value. Add a custom board if you have one.
            </p>
            <ul>
              <li>
                <Check aria-hidden="true" size={14} /> Live inflation and max bids
              </li>
              <li>
                <Check aria-hidden="true" size={14} /> Snake and auction practice
              </li>
              <li>
                <Check aria-hidden="true" size={14} /> ADP, wait risk, and rankings
              </li>
            </ul>
            <Link href="/draft" className={styles.inlineLink}>
              Try the draft studio <ArrowRight aria-hidden="true" size={15} />
            </Link>
          </div>

          <div className={styles.auctionBoard} aria-label="Illustrative auction draft assistant">
            <div className={styles.boardHeader}>
              <div>
                <span>Pick 37 · Nomination live</span>
                <strong>North Loop Auction</strong>
              </div>
              <span className={styles.livePill}>
                <i aria-hidden="true" /> Live room
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
                <CircleDollarSign aria-hidden="true" size={15} /> $119 budget · 8 slots open
              </span>
              <span>Value remaining: $132</span>
            </div>
          </div>
        </section>

        <section className={styles.weekSection} id="in-season">
          <div className={styles.sectionIntro}>
            <div>
              <p className={styles.sectionKicker}>In season</p>
              <h2>One ranked queue for the whole week.</h2>
            </div>
            <p>
              Laces Out checks your roster, every free agent, every trade partner, and this
              week&rsquo;s opponent, then sorts the useful calls above the noise.
            </p>
          </div>

          <div className={styles.weekGrid}>
            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <BarChart3 aria-hidden="true" size={19} />
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
                  <span>Finkle&rsquo;s Revenge</span>
                  <i style={{ width: "70%" }} />
                  <strong>80.6</strong>
                </div>
              </div>
            </article>

            <article className={styles.weekFeature}>
              <div className={styles.featureIcon}>
                <Scale aria-hidden="true" size={19} />
              </div>
              <span>Trade finder</span>
              <h3>Find the deals that create value and the ones both managers might accept.</h3>
              <div className={styles.tradePreview}>
                <div>
                  <small>You send</small>
                  <strong>D. Swift</strong>
                  <span>RB · depth surplus</span>
                </div>
                <ArrowRight aria-hidden="true" size={18} />
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
                <LineChart aria-hidden="true" size={19} />
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
              <p className={styles.sectionKicker}>Film Room</p>
              <h2>Ask the Film Room why.</h2>
              <p>
                Included Gemini, or your own OpenAI, Anthropic, DeepSeek, Grok, or OpenRouter key.
                Every answer is built from your synced league and cites the Laces Out data behind
                it.
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

            <div className={styles.aiDisclosure}>
              <ShieldCheck aria-hidden="true" size={17} />
              <p>
                Prompts and answers aren&rsquo;t stored, except the Weekly Reckoning recap your
                league opts into. Models can&rsquo;t change your Yahoo or ESPN roster.
              </p>
              <Link className={styles.primaryButton} href="/film-room">
                Open Film Room <ArrowRight aria-hidden="true" size={15} />
              </Link>
            </div>
          </div>
        </section>

        <section className={styles.trustSection} id="privacy">
          <div className={styles.trustInner}>
            <div className={styles.trustHeading}>
              <p className={styles.sectionKicker}>Built for friends, not ad inventory</p>
              <h2>No fees. No ads. No roster moves without you.</h2>
              <p>Your league stays private.</p>
              <Link href="/privacy" className={styles.inlineLink}>
                Read the privacy policy <ChevronRight aria-hidden="true" size={15} />
              </Link>
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
            </div>
          </div>
        </section>

        <section className={`${styles.ctaBand} ${styles.finalCta}`}>
          <div className={styles.ctaTitle}>
            <span>
              <Goal aria-hidden="true" size={20} />
            </span>
            <h2>Your league&rsquo;s next call is waiting.</h2>
          </div>
          <div className={styles.ctaActions}>
            <Link className={styles.secondaryButton} href="/app">
              See a sample week <ChevronRight aria-hidden="true" size={16} />
            </Link>
            <Link className={styles.primaryButton} href="/register">
              Join Laces Out <ArrowRight aria-hidden="true" size={16} />
            </Link>
            <a className={styles.secondaryButton} href={publicAppStoreUrl}>
              Get the iPhone app <Smartphone aria-hidden="true" size={16} />
            </a>
          </div>
        </section>
      </main>

      <PublicSiteFooter />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(applicationSchema).replaceAll("<", "\\u003c"),
        }}
      />
    </div>
  );
}
