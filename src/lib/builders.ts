import type { JsonLdNode } from './types';

/**
 * Small, pure helpers for the schema.org shapes that are tedious or easy to
 * get wrong. Each returns a plain `JsonLdNode`; unknown extra properties are
 * passed through, and `'@type'` may be given to refine the type.
 */

/** Any extra schema.org properties. */
export type Extra = { [key: string]: unknown };

/** A node reference such as `{ '@id': '/#org' }`, or any node. */
export type NodeRef = { '@id': string } | JsonLdNode;

type Typed<T> = T & Extra & { '@type'?: string | readonly string[]; '@id'?: string };

/** `Array.isArray` that also narrows readonly arrays. */
function isList<T>(value: unknown): value is readonly T[] {
  return Array.isArray(value);
}

function node(type: string, input: Extra): JsonLdNode {
  const out: JsonLdNode = { '@type': type };
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function named(type: string, value: string | NodeRef | Extra): unknown {
  return typeof value === 'string' ? { '@type': type, name: value } : value;
}

function namedList(type: string, value: string | NodeRef | readonly (string | NodeRef)[] | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  return isList(value) ? value.map((item) => named(type, item)) : named(type, value);
}

// ---------------------------------------------------------------- answer-shaped

export interface FaqItem {
  question: string;
  answer: string;
}

export function faqPage(input: readonly FaqItem[] | Typed<{ items: readonly FaqItem[] }>): JsonLdNode {
  const { items, ...rest } = isList(input) ? { items: input } : input;
  return node('FAQPage', {
    ...rest,
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  });
}

export type AnswerInput = Typed<{ text: string; upvoteCount?: number; url?: string; author?: string | NodeRef; datePublished?: string }>;

function answer(input: AnswerInput): JsonLdNode {
  const { author, ...rest } = input;
  return node('Answer', { ...rest, author: author === undefined ? undefined : named('Person', author) });
}

export function qaPage(
  input: Typed<{
    question: string;
    text?: string;
    acceptedAnswer?: AnswerInput;
    suggestedAnswers?: readonly AnswerInput[];
    author?: string | NodeRef;
    datePublished?: string;
  }>,
): JsonLdNode {
  const { question, text, acceptedAnswer, suggestedAnswers, author, datePublished, ...rest } = input;
  const suggested = suggestedAnswers ?? [];
  return node('QAPage', {
    ...rest,
    mainEntity: node('Question', {
      name: question,
      text,
      author: author === undefined ? undefined : named('Person', author),
      datePublished,
      answerCount: suggested.length + (acceptedAnswer ? 1 : 0),
      acceptedAnswer: acceptedAnswer ? answer(acceptedAnswer) : undefined,
      suggestedAnswer: suggested.length > 0 ? suggested.map(answer) : undefined,
    }),
  });
}

export type HowToStepInput = string | Typed<{ text: string; name?: string; url?: string; image?: string }>;

export function howTo(
  input: Typed<{ name: string; steps: readonly HowToStepInput[]; supply?: readonly string[]; tool?: readonly string[]; totalTime?: string }>,
): JsonLdNode {
  const { steps, supply, tool, ...rest } = input;
  return node('HowTo', {
    ...rest,
    supply: supply?.map((name) => ({ '@type': 'HowToSupply', name })),
    tool: tool?.map((name) => ({ '@type': 'HowToTool', name })),
    step: steps.map((step, index) =>
      typeof step === 'string'
        ? { '@type': 'HowToStep', position: index + 1, text: step }
        : node('HowToStep', { position: index + 1, ...step }),
    ),
  });
}

export function speakable(input: Typed<{ cssSelector?: readonly string[]; xpath?: readonly string[] }>): JsonLdNode {
  return node('SpeakableSpecification', input);
}

// ---------------------------------------------------------------- content

export type CreativeWorkInput = Typed<{
  headline: string;
  description?: string;
  image?: string | readonly string[] | Extra;
  author?: string | NodeRef | readonly (string | NodeRef)[];
  publisher?: string | NodeRef;
  datePublished?: string;
  dateModified?: string;
  url?: string;
  mainEntityOfPage?: string | NodeRef;
}>;

function creativeWork(type: string, input: CreativeWorkInput): JsonLdNode {
  const { author, publisher, ...rest } = input;
  return node(type, {
    ...rest,
    author: namedList('Person', author),
    publisher: publisher === undefined ? undefined : named('Organization', publisher),
  });
}

export function article(input: CreativeWorkInput): JsonLdNode {
  return creativeWork('Article', input);
}

export function blogPosting(input: CreativeWorkInput): JsonLdNode {
  return creativeWork('BlogPosting', input);
}

export function webPage(input: Typed<{ name?: string; description?: string; url?: string; speakable?: JsonLdNode }>): JsonLdNode {
  return node('WebPage', input);
}

export interface BreadcrumbItem {
  name: string;
  /** Omit for the current page. */
  url?: string;
}

export function breadcrumbList(input: readonly BreadcrumbItem[] | Typed<{ items: readonly BreadcrumbItem[] }>): JsonLdNode {
  const { items, ...rest } = isList(input) ? { items: input } : input;
  return node('BreadcrumbList', {
    ...rest,
    itemListElement: items.map((item, index) =>
      node('ListItem', { position: index + 1, name: item.name, item: item.url }),
    ),
  });
}

// ---------------------------------------------------------------- entities

export function organization(input: Typed<{ name: string; url?: string; logo?: string | Extra; sameAs?: readonly string[] }>): JsonLdNode {
  return node('Organization', input);
}

export function webSite(input: Typed<{ name: string; url?: string; searchUrlTemplate?: string }>): JsonLdNode {
  const { searchUrlTemplate, ...rest } = input;
  return node('WebSite', {
    ...rest,
    potentialAction:
      searchUrlTemplate === undefined
        ? undefined
        : {
            '@type': 'SearchAction',
            target: searchUrlTemplate,
            'query-input': 'required name=search_term_string',
          },
  });
}

export function person(input: Typed<{ name: string; url?: string; jobTitle?: string; sameAs?: readonly string[] }>): JsonLdNode {
  return node('Person', input);
}

// ---------------------------------------------------------------- commercial

export type OfferInput = Typed<{ price?: string | number; priceCurrency?: string; name?: string; availability?: string; url?: string }>;

export function offer(input: OfferInput): JsonLdNode {
  return node('Offer', input);
}

export function aggregateOffer(
  input: Typed<{
    offers: readonly JsonLdNode[];
    priceCurrency?: string;
    lowPrice?: string | number;
    highPrice?: string | number;
    offerCount?: number;
  }>,
): JsonLdNode {
  const { offers, priceCurrency, lowPrice, highPrice, offerCount, ...rest } = input;
  const children = offers.map((child) =>
    priceCurrency !== undefined && child['priceCurrency'] === undefined ? { ...child, priceCurrency } : child,
  );

  let low: unknown = lowPrice;
  let high: unknown = highPrice;
  const usable = (price: unknown): boolean =>
    (typeof price === 'number' && Number.isFinite(price)) ||
    (typeof price === 'string' && price.trim() !== '' && Number.isFinite(Number(price)));
  const priced = children.filter((child) => usable(child['price']));
  if (priced.length > 0) {
    const byPrice = [...priced].sort((a, b) => Number(a['price']) - Number(b['price']));
    low ??= byPrice[0]['price'];
    high ??= byPrice[byPrice.length - 1]['price'];
  }

  return node('AggregateOffer', {
    ...rest,
    priceCurrency,
    lowPrice: low,
    highPrice: high,
    offerCount: offerCount ?? children.length,
    offers: children,
  });
}

export function product(
  input: Typed<{ name: string; description?: string; image?: string | readonly string[]; brand?: string | NodeRef; offers?: JsonLdNode | readonly JsonLdNode[]; sku?: string }>,
): JsonLdNode {
  const { brand, ...rest } = input;
  return node('Product', { ...rest, brand: brand === undefined ? undefined : named('Brand', brand) });
}

export function service(
  input: Typed<{ name: string; description?: string; provider?: string | NodeRef; serviceType?: string; areaServed?: unknown; offers?: JsonLdNode | readonly JsonLdNode[] }>,
): JsonLdNode {
  const { provider, ...rest } = input;
  return node('Service', { ...rest, provider: provider === undefined ? undefined : named('Organization', provider) });
}
