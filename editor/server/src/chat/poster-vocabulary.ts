/**
 * Per-language vocabulary the poster recreation uses to recognise times, dates, field labels, addresses, stop
 * words and "the event has no such datum" in a layout reference and in the owner's messages. Words are written
 * lower-case and without accents: they are matched after the same accent stripping the engine applies to text.
 *
 * Language selection: `vocabularyFor(locale)` takes the language subtag of the brand's BCP 47 locale
 * (case-insensitive, "es-XX" -> "es") and merges that table with the English one, because posters borrow English
 * labels ("tickets"). A locale whose language has no table, or no locale at all, gets the union of every
 * registered table. Word boundaries (`\b`) and `[a-z]*` month tails assume Latin script. Adding a language means registering one table; the engine does not change.
 *
 * Whose language: the brand's locale applies only to reading the OWNER's messages (stop words, negations and zone
 * words). Recognising what a LAYOUT line is (labels, the look of a datum, addresses) calls `vocabularyFor()` with no
 * locale, because a reference poster may be in another language than the brand.
 */
export type VocabularyZone = "title" | "date" | "time" | "place" | "entry" | "price";
type LabelZone = Exclude<VocabularyZone, "title">;

export interface PosterVocabulary {
  /** Words after an hour ("21 h", "21 hrs"); a one-letter unit also works between hour and minutes ("21h30"). */
  timeUnits?: string[];
  /** Words after an hour that also mark a 12-hour clock ("9 pm"); never part of a date. */
  meridiem?: string[];
  /** Month-name prefixes: "sep" matches "sep", "sept", "september". */
  months?: string[];
  /** Words allowed between a day and its month ("3 de ene"). */
  dateConnectors?: string[];
  /** Singular currency words; a trailing "s" is accepted ("peso" matches "pesos"). */
  currencyWords?: string[];
  stopWords?: string[];
  /** Whole-line field labels per zone. */
  labels?: Partial<Record<LabelZone, string[]>>;
  /** Words that name a zone inside a sentence ("no time"). */
  mentions?: Partial<Record<VocabularyZone, string[]>>;
  negations?: string[];
  /** Street words that start an address line ("av", "street"). */
  streetWords?: string[];
}

export interface CompiledVocabulary {
  time: RegExp;
  /** A day and month, numeric or with a month word. */
  date: RegExp;
  /** An amount followed by a currency word; never matches when the table has none. */
  priceWords: RegExp;
  stopWords: Set<string>;
  labelZones: Array<[LabelZone, RegExp]>;
  zoneWords: Partial<Record<VocabularyZone, RegExp>>;
  negation: RegExp;
  address: RegExp;
}

const EN: PosterVocabulary = {
  timeUnits: ["hr", "hrs", "h"],
  meridiem: ["am", "pm"],
  months: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  currencyWords: ["dollar", "euro", "pound"],
  stopWords: ["with", "from", "this", "that", "the", "and"],
  labels: {
    place: ["location", "place", "venue", "where", "address"],
    time: ["time", "hours", "doors", "schedule"],
    entry: ["ticket", "tickets", "entry", "admission", "cover"],
    price: ["price", "cost"],
    date: ["date", "day", "when"],
  },
  mentions: {
    title: ["name", "title"],
    date: ["date", "day"],
    time: ["time", "hour", "hours"],
    place: ["place", "venue", "location", "address"],
    entry: ["entry", "ticket", "tickets", "price", "cover"],
    price: ["price", "cost", "entry", "ticket", "tickets"],
  },
  negations: ["no", "without", "none", "not"],
  streetWords: ["street", "st", "road", "rd", "avenue", "ave"],
};

const ES: PosterVocabulary = {
  timeUnits: ["hr", "hrs", "h", "hora", "horas"],
  months: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "set", "oct", "nov", "dic"],
  dateConnectors: ["de"],
  currencyWords: ["peso"],
  stopWords: ["desde", "hasta", "para", "como", "sobre", "entre", "las", "los", "del", "una", "uno"],
  labels: {
    place: ["ubicacion", "lugar", "direccion", "donde", "recinto"],
    time: ["horario", "hora", "horas", "apertura"],
    entry: ["entrada", "entradas", "entrada general"],
    price: ["precio", "valor"],
    date: ["fecha", "dia", "cuando"],
  },
  mentions: {
    title: ["nombre", "titulo"],
    date: ["fecha", "dia"],
    time: ["hora", "horario"],
    place: ["lugar", "ubicacion", "direccion"],
    entry: ["entrada", "entradas", "precio", "valor"],
    price: ["precio", "valor", "entrada"],
  },
  negations: ["no", "sin", "ningun", "ninguna", "ninguno"],
  streetWords: ["av", "avda", "avenida", "calle", "pasaje", "psje", "camino"],
};

const registry = new Map<string, PosterVocabulary>([["en", EN], ["es", ES]]);
const compiled = new Map<string, CompiledVocabulary>();

/**
 * Adds or replaces the table of a language: for the language tables shipped by the engine, and tests. The registry
 * is process-global, shared by every brand the server serves, so brand data never goes there.
 */
export function registerVocabulary(language: string, table: PosterVocabulary): void {
  registry.set(language.toLowerCase(), table);
  compiled.clear();
}

export function unregisterVocabulary(language: string): void {
  registry.delete(language.toLowerCase());
  compiled.clear();
}

const UNION = "*";

/** The compiled vocabulary of a brand locale; see the module comment for the fallback rules. */
export function vocabularyFor(locale?: string): CompiledVocabulary {
  const language = locale?.split(/[-_]/)[0]?.toLowerCase() ?? "";
  const key = registry.has(language) ? language : UNION;
  let found = compiled.get(key);
  if (!found) {
    const tables = key === UNION ? [...registry.values()] : [registry.get(key)!, ...(key === "en" ? [] : [registry.get("en")].filter((t) => t !== undefined))];
    found = compile(merge(tables));
    compiled.set(key, found);
  }
  return found;
}

const plain = (word: string): string => word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const escape = (word: string): string => plain(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (words: string[]): string => (words.length > 0 ? `(?:${[...new Set(words)].map(escape).join("|")})` : "(?!)");
const unique = (words: string[]): string[] => [...new Set(words.map(plain))];

function merge(tables: PosterVocabulary[]): Required<Omit<PosterVocabulary, "labels" | "mentions">> & Pick<PosterVocabulary, "labels" | "mentions"> {
  const list = (pick: (t: PosterVocabulary) => string[] | undefined) => unique(tables.flatMap((t) => pick(t) ?? []));
  const zones = <Z extends string>(pick: (t: PosterVocabulary) => Partial<Record<Z, string[]>> | undefined, names: readonly Z[]) =>
    Object.fromEntries(names.map((z) => [z, list((t) => pick(t)?.[z])])) as Record<Z, string[]>;
  return {
    timeUnits: list((t) => t.timeUnits),
    meridiem: list((t) => t.meridiem),
    months: list((t) => t.months),
    dateConnectors: list((t) => t.dateConnectors),
    currencyWords: list((t) => t.currencyWords),
    stopWords: list((t) => t.stopWords),
    labels: zones((t) => t.labels, ["place", "time", "entry", "price", "date"] as const),
    mentions: zones((t) => t.mentions, ["title", "date", "time", "place", "entry", "price"] as const),
    negations: list((t) => t.negations),
    streetWords: list((t) => t.streetWords),
  };
}

function compile(v: ReturnType<typeof merge>): CompiledVocabulary {
  const units = anyOf([...v.timeUnits, ...v.meridiem]);
  const clockUnits = anyOf(v.timeUnits);
  // A one-letter unit ("h") may also stand between hour and minutes: "21h30".
  const separator = `(?::|\\.${v.timeUnits.filter((u) => u.length === 1).map((u) => `|${escape(u)}`).join("")})`;
  const connector = v.dateConnectors.length > 0 ? `(?:${anyOf(v.dateConnectors)}\\s+)?` : "";
  const months = v.months.length > 0 ? `|\\b\\d{1,2}\\s+${connector}${anyOf(v.months)}[a-z]*\\b` : "";
  const label = (zone: LabelZone) => [zone, new RegExp(`^${anyOf(v.labels![zone]!)}$`)] as [LabelZone, RegExp];
  const zoneWords: Partial<Record<VocabularyZone, RegExp>> = {};
  for (const [zone, words] of Object.entries(v.mentions!)) zoneWords[zone as VocabularyZone] = new RegExp(`\\b${anyOf(words)}\\b`);
  return {
    time: new RegExp(`\\b\\d{1,2}\\s*${separator}\\s*\\d{2}\\b|\\b\\d{1,2}\\s*${units}\\b`, "i"),
    date: new RegExp(`\\b\\d{1,2}\\s*[/.-]\\s*(?:0?[1-9]|1[0-2])(?:\\s*[/.-]\\s*\\d{2,4})?\\b(?!\\s*${clockUnits}\\b)${months}`, "i"),
    priceWords: new RegExp(`\\b\\d[\\d.,]*\\s*${anyOf(v.currencyWords)}s?\\b`, "iu"),
    stopWords: new Set(v.stopWords),
    labelZones: (["place", "time", "entry", "price", "date"] as const).map(label),
    zoneWords,
    negation: new RegExp(`\\b${anyOf(v.negations)}\\b`),
    address: new RegExp(`\\b${anyOf(v.streetWords)}\\.?\\s+\\p{L}.*\\d`, "iu"),
  };
}
