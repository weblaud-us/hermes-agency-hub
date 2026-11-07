import type {
  BrandKit,
  BusinessMode,
  GenerateNowResult,
  PortalClient,
  Roster,
  RosterAgent,
  SocialAutopilot,
  SocialComment,
  SocialPost,
} from "./portal-api";
import { delay } from "./utils";

type SocialViews = Pick<PortalClient, "roster" | "socialAutopilot" | "updateSocialSettings" | "generateNow" | "socialMedia">;

const AGENTS: Omit<RosterAgent, "active">[] = [
  { key: "orchestrator", name: "AI Employee Orchestrator", role: "Front desk: routes every request, remembers the business, sends your daily summary.", ecommerceOnly: false },
  { key: "social", name: "Social Media Autopilot", role: "Plans, designs, publishes and answers comments, with nothing for you to do.", ecommerceOnly: false },
  { key: "sales", name: "Sales Rep", role: "Answers WhatsApp, Messenger and Instagram enquiries day and night and captures bookings.", ecommerceOnly: false },
  { key: "designer", name: "Designer", role: "On-brand graphics, offer banners and story cards.", ecommerceOnly: false },
  { key: "video", name: "Video Editor", role: "Short vertical reels with captions and shot guides.", ecommerceOnly: false },
  { key: "ads", name: "Ads Manager", role: "Proposes Meta and Google campaigns and watches cost per lead. You approve spend.", ecommerceOnly: false },
  { key: "email", name: "Email Assistant", role: "Drafts partner, supplier and customer email for your approval.", ecommerceOnly: false },
  { key: "web", name: "Web Manager", role: "Keeps your site current, publishes local SEO articles, checks uptime.", ecommerceOnly: false },
  { key: "reporter", name: "Reporter", role: "Weekly funnel and ROI report, with what to do next.", ecommerceOnly: false },
  { key: "order_desk", name: "Order Desk", role: "Turns messages into orders, confirms payment or COD, books couriers.", ecommerceOnly: true },
  { key: "catalog", name: "Catalog Keeper", role: "Keeps SKUs and stock accurate and warns before anything sells out.", ecommerceOnly: true },
];

interface Topic {
  headline: string;
  subtext: string;
  caption: string;
  hashtags: string[];
  comments: { author: string; text: string; reply: string }[];
}

const SERVICE_TOPICS: Topic[] = [
  {
    headline: "Brighter smiles start here",
    subtext: "Ask about our whitening package",
    caption: "A confident smile changes everything. Message us to see this week's openings.",
    hashtags: ["#dentist", "#teethwhitening", "#smile", "#dentalcare"],
    comments: [
      { author: "Maya R.", text: "How much is the Teeth Whitening package?", reply: "Thanks for asking! We have just sent you the details in a private message." },
      { author: "Daniel K.", text: "Do you have anything open on Saturday?", reply: "Thanks for asking! We have just sent you the details in a private message." },
    ],
  },
  {
    headline: "Fear of the dentist? Same.",
    subtext: "Gentle check-ups, no pressure",
    caption: "Most of our patients were nervous once. Book a gentle first visit by sending us a message.",
    hashtags: ["#dentist", "#anxietyfree", "#checkup"],
    comments: [{ author: "Priya S.", text: "Do you take kids for first visits?", reply: "We do! We have just sent you a private message with the next steps." }],
  },
];

const SHOP_TOPICS: Topic[] = [
  {
    headline: "New arrivals, just landed",
    subtext: "Limited stock, order by message",
    caption: "The new drop is here and the popular sizes go first. Message us the item and your size.",
    hashtags: ["#newarrivals", "#shopsmall", "#ootd", "#newdrop"],
    comments: [
      { author: "Alex P.", text: "Do you have Size L in stock?", reply: "Good question! We have just sent you a private message with the answer." },
      { author: "Imani C.", text: "Can I pay on delivery?", reply: "Yes you can. We have sent you the details by private message." },
    ],
  },
  {
    headline: "Back in stock: the one you asked for",
    subtext: "Restocked today, selling fast",
    caption: "You asked, we restocked. Send us a message with your size and we will hold one for you.",
    hashtags: ["#restock", "#backinstock", "#shopnow"],
    comments: [{ author: "Jordan F.", text: "Is the navy one back in medium?", reply: "It is! We have just sent you a private message to reserve yours." }],
  },
];

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A branded card drawn in the browser, standing in for the hub's rendered visual. */
function cardFor(post: SocialPost, brand: BrandKit): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="1080" height="1080">
<rect width="1080" height="1080" fill="#07090E"/>
<circle cx="860" cy="220" r="340" fill="${esc(brand.primaryColor)}" opacity="0.22"/>
<circle cx="220" cy="880" r="320" fill="${esc(brand.accentColor)}" opacity="0.22"/>
<rect x="64" y="64" width="952" height="952" rx="36" fill="none" stroke="${esc(brand.primaryColor)}" stroke-opacity="0.35" stroke-width="3"/>
<text x="110" y="150" fill="${esc(brand.primaryColor)}" font-family="sans-serif" font-size="30" font-weight="700">${esc(brand.logoText.toUpperCase())}</text>
<text x="110" y="470" fill="#FFFFFF" font-family="sans-serif" font-size="64" font-weight="800">${esc(post.headline.slice(0, 26))}</text>
<text x="110" y="560" fill="#CBD5E1" font-family="sans-serif" font-size="36">${esc(post.subtext.slice(0, 40))}</text>
<rect x="110" y="850" width="560" height="82" rx="41" fill="${esc(brand.primaryColor)}"/>
<text x="390" y="902" text-anchor="middle" fill="#07090E" font-family="sans-serif" font-size="30" font-weight="700">${esc(brand.contactCta.slice(0, 34))}</text>
</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Sample social views for a preview with no hub behind it. Everything here is invented. */
export function createSocialMock(company: string, subdomain: string): SocialViews {
  const ecommerce = !/dental|clinic|salon|beauty|restaurant|travel/.test(subdomain);
  const mode: BusinessMode = ecommerce ? "ecommerce" : "general";
  const topics = ecommerce ? SHOP_TOPICS : SERVICE_TOPICS;
  const handoff = ecommerce ? "Order Desk" : "Sales Rep";

  let autopilot = true;
  let brand: BrandKit = {
    primaryColor: "#00F5D4",
    accentColor: "#6366F1",
    logoText: company.toUpperCase().slice(0, 24),
    contactCta: ecommerce ? "Order via WhatsApp or DM" : "Book via WhatsApp or DM",
    websiteUrl: null,
  };
  let counter = 0;
  const posts: SocialPost[] = [];
  const comments: SocialComment[] = [];

  const make = (topic: Topic, hoursAgo: number, published: boolean, demo: boolean): SocialPost => {
    counter += 1;
    const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const post: SocialPost = {
      id: `mock-post-${counter}`,
      status: published ? "published" : "awaiting_approval",
      headline: topic.headline,
      subtext: topic.subtext,
      caption: `${topic.caption}\n\n${brand.contactCta}`,
      hashtags: topic.hashtags,
      platforms: ["facebook", "instagram"],
      hasImage: true,
      visualEngine: "studio_canvas_overlay",
      publishMode: published ? "sandbox" : null,
      permalink: null,
      reach: demo ? 1800 + counter * 1130 : null,
      commentsReplied: published ? topic.comments.length : 0,
      leadsCaptured: published ? topic.comments.length : 0,
      error: null,
      demo,
      publishedAt: published ? at : null,
      createdAt: at,
    };
    if (published) {
      topic.comments.forEach((row, index) => {
        comments.push({
          id: `${post.id}-c${index}`,
          postId: post.id,
          author: row.author,
          text: row.text,
          publicReply: row.reply,
          handoffTo: handoff,
          dmText: "Hi! Thanks for your comment. Here is what you asked about. Reply and we will take it from there.",
          live: false,
          sample: true,
          createdAt: new Date(Date.parse(at) + (index + 1) * 240_000).toISOString(),
        });
      });
    }
    return post;
  };

  posts.push(make(topics[1 % topics.length], 52, true, true), make(topics[0], 28, true, true));
  posts.reverse();
  comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const view = (): SocialAutopilot => ({
    autopilotSocial: autopilot,
    brandKit: { ...brand },
    livePublishing: false,
    businessMode: mode,
    posts: posts.map((row) => ({ ...row })),
    comments: comments.map((row) => ({ ...row })),
  });

  return {
    async roster(): Promise<Roster> {
      await delay(160);
      const build = (target: BusinessMode): RosterAgent[] =>
        AGENTS.filter((agent) => target === "ecommerce" || !agent.ecommerceOnly).map((agent) => ({
          ...agent,
          active: target === mode,
        }));
      return { businessMode: mode, rosters: { general: build("general"), ecommerce: build("ecommerce") } };
    },

    async socialAutopilot() {
      await delay(200);
      return view();
    },

    async updateSocialSettings(patch) {
      await delay(220);
      if (patch.autopilotSocial !== undefined) autopilot = patch.autopilotSocial;
      if (patch.brandKit) brand = { ...patch.brandKit };
      return view();
    },

    async generateNow(): Promise<GenerateNowResult> {
      await delay(1900);
      const topic = topics[counter % topics.length];
      const post = make(topic, 0, autopilot, false);
      posts.unshift(post);
      const fresh = comments.filter((row) => row.postId === post.id);
      comments.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return {
        outcome: autopilot ? "published" : "awaiting_owner",
        message: autopilot
          ? "Post created in sandbox mode: no Meta account is connected for this business yet, so nothing was posted publicly."
          : "Post created. It is waiting for your one-tap approval in the Approvals tab.",
        post: { ...post },
        comments: fresh.map((row) => ({ ...row })),
      };
    },

    async socialMedia(postId) {
      await delay(120);
      const post = posts.find((row) => row.id === postId);
      return post ? cardFor(post, brand) : null;
    },
  };
}
