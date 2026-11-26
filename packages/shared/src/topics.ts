/**
 * The system topics (TID-077, ADR 0021, spec 7.9). Shared by the Worker (tagging, the API) and the SPA
 * (chips, TID-078). IDs are stable, are never reused and do not depend on display order. They are packed
 * into `entries.topics` as 8-bit values, so they are 1 to 255. The API uses the slug.
 *
 * The array is in display order (UK politics follows US politics). The tagging prompt lists the topics
 * by ID, so a model answer is a list of IDs.
 */

export interface SystemTopic {
  id: number;
  slug: string;
  name: string;
  /** One line given to the tagging model and embedded for the fallback. */
  description: string;
}

export const TOPICS: readonly SystemTopic[] = [
  {
    id: 1,
    slug: 'world-news',
    name: 'World news',
    description:
      'International news and world affairs, foreign governments, diplomacy and global events',
  },
  {
    id: 2,
    slug: 'middle-east',
    name: 'Middle East',
    description:
      'Middle East conflict and politics: Israel, Gaza, Palestine, Iran, Lebanon, Syria, Yemen, Saudi Arabia',
  },
  {
    id: 3,
    slug: 'ukraine-russia',
    name: 'Ukraine and Russia',
    description: "Russia's war in Ukraine, Kremlin, Putin, Zelensky, NATO and the front line",
  },
  {
    id: 4,
    slug: 'us-politics',
    name: 'US politics',
    description:
      'United States politics: Trump, the White House, Congress, Republicans and Democrats, US elections',
  },
  {
    id: 28,
    slug: 'uk-politics',
    name: 'UK politics',
    description:
      'United Kingdom politics: the Prime Minister, Westminster, Parliament, Labour, the Conservatives, Reform UK, the Liberal Democrats, UK elections',
  },
  {
    id: 5,
    slug: 'australian-politics',
    name: 'Australian politics',
    description:
      'Australian federal politics: Albanese, Parliament House, Labor, the Coalition, Greens, Senate, elections',
  },
  {
    id: 6,
    slug: 'canberra',
    name: 'Canberra',
    description:
      'Canberra and the ACT: local news, ACT government, Canberra community and services',
  },
  {
    id: 7,
    slug: 'public-service',
    name: 'Public service',
    description:
      'Australian Public Service, government departments, public servants, APS reform, government administration',
  },
  {
    id: 8,
    slug: 'defence-security',
    name: 'Defence and security',
    description:
      'Defence, military, national security, strategy, AUKUS, armed forces, intelligence agencies',
  },
  {
    id: 9,
    slug: 'crime-justice',
    name: 'Crime and justice',
    description: 'Crime, police, courts, trials, murders, arrests and the justice system',
  },
  {
    id: 10,
    slug: 'economy',
    name: 'Economy',
    description:
      'The economy: inflation, interest rates, the Reserve Bank, jobs, wages, budgets, housing costs',
  },
  {
    id: 11,
    slug: 'business-markets',
    name: 'Business and markets',
    description:
      'Business news, companies, earnings, shares, the stock market, mergers, CEOs and investors',
  },
  {
    id: 12,
    slug: 'technology',
    name: 'Technology',
    description:
      'Technology industry news: big tech companies, gadgets, software, the internet and platforms',
  },
  {
    id: 13,
    slug: 'ai',
    name: 'AI',
    description:
      'Artificial intelligence: large language models, ChatGPT, OpenAI, Anthropic, Claude, Gemini, machine learning',
  },
  {
    id: 14,
    slug: 'apple',
    name: 'Apple',
    description: "Apple: iPhone, Mac, iPad, iOS, macOS, Apple Watch and Apple's business",
  },
  {
    id: 15,
    slug: 'programming',
    name: 'Programming',
    description:
      'Software development and programming: code, developers, open source, programming languages, tools',
  },
  {
    id: 16,
    slug: 'cybersecurity',
    name: 'Cybersecurity',
    description:
      'Cybersecurity: hacking, data breaches, ransomware, malware, vulnerabilities and online privacy',
  },
  {
    id: 17,
    slug: 'science',
    name: 'Science',
    description:
      'Science and research: physics, biology, archaeology, discoveries and scientific studies',
  },
  {
    id: 18,
    slug: 'space',
    name: 'Space',
    description:
      'Space exploration: NASA, SpaceX, rockets, satellites, astronomy, the Moon and Mars',
  },
  {
    id: 19,
    slug: 'health',
    name: 'Health',
    description:
      'Health and medicine: hospitals, diseases, doctors, treatments, mental health and public health',
  },
  {
    id: 20,
    slug: 'climate-environment',
    name: 'Climate and environment',
    description:
      'Climate change, the environment, emissions, renewable energy, weather extremes and conservation',
  },
  {
    id: 21,
    slug: 'formula-1',
    name: 'Formula 1',
    description:
      'Formula 1 motor racing: Grand Prix, F1 drivers and teams, qualifying, races and the championship',
  },
  {
    id: 22,
    slug: 'sport',
    name: 'Sport',
    description:
      'Sport: cricket, football, AFL, NRL, rugby, tennis, soccer, the Olympics, matches and players',
  },
  {
    id: 23,
    slug: 'deals',
    name: 'Deals',
    description: 'Shopping deals, discounts, bargains, coupons, sales and cheap prices',
  },
  {
    id: 24,
    slug: 'gaming',
    name: 'Gaming',
    description: 'Video games, gaming consoles, PlayStation, Xbox, Nintendo and game releases',
  },
  {
    id: 25,
    slug: 'entertainment',
    name: 'Entertainment',
    description:
      'Entertainment and culture: film, TV shows, streaming, music, celebrities and the arts',
  },
  {
    id: 26,
    slug: 'cars-transport',
    name: 'Cars and transport',
    description:
      'Cars, electric vehicles, Tesla, transport, aviation, airlines and public transport',
  },
  {
    id: 27,
    slug: 'osint',
    name: 'Open-source intelligence',
    description:
      'Open-source intelligence and investigations: OSINT, geolocation, verifying footage and disinformation',
  },
];

/** Bump when the list changes (add, retire or re-describe). Topic vectors older than this are recomputed. */
export const TOPICS_VERSION = 1;

/** IDs that were removed from `TOPICS` and must never be reused. Stored tags that carry one are ignored on read. */
export const RETIRED_TOPIC_IDS: readonly number[] = [];
